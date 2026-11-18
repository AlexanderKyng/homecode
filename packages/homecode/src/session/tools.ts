import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ModelID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Cause, Effect, Exit, Schema, Semaphore } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import * as Log from "@homecode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { Wildcard } from "@homecode-ai/core/util/wildcard"
import { HomeMemAdapter } from "@/homemem"
import type { Tool as CodeModeToolType } from "@homecode-ai/codemode"
import { CodeModeTrace } from "./code-mode-trace"
import type { ValidateFunction } from "ajv"

const log = Log.create({ service: "session.tools" })
const EDIT_TOOLS = ["edit", "write", "apply_patch"]

const waitForAbort = (signal: AbortSignal) =>
  Effect.callback<never>((resume) => {
    if (signal.aborted) return resume(Effect.interrupt)
    const handler = () => resume(Effect.interrupt)
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall" | "beginNestedToolCall" | "failToolCall">
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
  homemem?: HomeMemAdapter.Interface
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const nestedToolLimit = Semaphore.makeUnsafe(4)
  const mutationLimit = Semaphore.makeUnsafe(1)
  const sideEffectTools = new Set<string>()
  const codeModeCalls = new Map<string, { trace: ReturnType<typeof CodeModeTrace.create>; executionID: string }>()
  const validators = new Map<string, (args: unknown) => unknown>()
  const ajvModule = input.agent.codeMode ? yield* Effect.promise(() => import("ajv")) : undefined
  const ajv = ajvModule ? new ajvModule.default({ allErrors: true, strict: false, allowUnionTypes: true }) : undefined

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) => {
      const request = permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie)
      const active = codeModeCalls.get(options.toolCallId)
      if (!active) return request
      return active.trace
        .write("permission_requested", {
          callID: options.toolCallId,
          executionID: active.executionID,
          permission: req.permission,
          patterns: req.patterns,
          metadata: req.metadata,
        })
        .pipe(
          Effect.andThen(
            Effect.onExit(request, (exit) =>
              active.trace.write("permission_decision", {
                callID: options.toolCallId,
                executionID: active.executionID,
                decision: Exit.isSuccess(exit) ? "allow" : "deny_or_cancel",
              }),
            ),
          ),
        )
    },
  })

  for (const item of yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    if (input.agent.codeMode) validators.set(item.id, (args) => Schema.decodeUnknownSync(item.parameters)(args))
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            // Gate: reject denied tools at execution time so the backend sees a stable
            // tool list with identical descriptions every turn. HomeCode enforces what's
            // usable via permissions, not by filtering from the request.
            const ruleset = Permission.merge(input.agent.permission, input.session.permission ?? [])
            const checkPermission = EDIT_TOOLS.includes(item.id) ? "edit" : item.id
            const deniedRule = ruleset.findLast((r) => Wildcard.match(checkPermission, r.permission))
            if (deniedRule?.pattern === "*" && deniedRule.action === "deny") {
              const active = codeModeCalls.get(options.toolCallId)
              if (active) {
                yield* active.trace.write("permission_decision", {
                  callID: options.toolCallId,
                  executionID: active.executionID,
                  permission: checkPermission,
                  decision: "deny",
                  source: "agent_or_session_wildcard_rule",
                })
              }
              return {
                title: `Tool "${item.id}" is not available in this mode`,
                output: `The tool "${item.id}" is not permitted in the current agent mode. Please use an alternative tool or switch to a different agent mode if needed.`,
                metadata: {},
              }
            }

            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const homememBefore = input.homemem
              ? yield* input.homemem.beforeTool({
                  tool: item.id,
                  args,
                  sessionID: ctx.sessionID,
                  callID: ctx.callID ?? "unknown",
                })
              : undefined
            const result = yield* item.execute(args, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (input.homemem && homememBefore) {
              yield* input.homemem.afterTool({
                tool: item.id,
                args,
                sessionID: ctx.sessionID,
                callID: ctx.callID ?? "unknown",
                before: homememBefore,
                result: output,
              })
            }
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    sideEffectTools.add(key)
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    if (ajv) {
      const validator: ValidateFunction = ajv.compile(schema)
      validators.set(key, (args) => {
        if (validator(args)) return args
        throw new Error(ajv.errorsText(validator.errors))
      })
    }
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  if (!input.agent.codeMode) return tools

  const codeModePackage = yield* Effect.promise(() => import("@homecode-ai/codemode"))

  const configuredExclusions = input.agent.options.codeModeExclude
  const excluded = new Set([
    "execute",
    "task",
    "todowrite",
    "plan_enter",
    "plan_exit",
    "question",
    ...(Array.isArray(configuredExclusions) ? configuredExclusions.filter((name): name is string => typeof name === "string") : []),
  ])
  const eligible = Object.entries(tools).filter(([name, item]) => !excluded.has(name) && item.execute)
  if (eligible.length === 0) return tools
  if (!input.processor.beginNestedToolCall || !input.processor.failToolCall) {
    throw new Error("Code Mode requires nested tool lifecycle support in SessionProcessor")
  }
  const beginNestedToolCall = input.processor.beginNestedToolCall
  const failToolCall = input.processor.failToolCall

  const definitions = eligible.map(([name, item]) => [
    name,
    codeModePackage.Tool.make({
      description: item.description ?? "",
      input: asSchema(item.inputSchema).jsonSchema as CodeModeToolType.JsonSchema,
      output: Schema.Unknown,
      execute: () => Effect.succeed(null),
    }),
  ])
  const catalogRuntime = codeModePackage.CodeMode.make({ tools: Object.fromEntries(definitions) })
  const catalog = catalogRuntime.catalog.slice(0, 16).map((item) => `${item.signature} // ${item.description}`).join("\n")
  for (const [name] of eligible) delete tools[name]
  tools.execute = tool({
    description: [
      "Run one JavaScript program in HomeCode's confined Code Mode interpreter. The program can only call the tools listed below or returned by search().",
      "Supported language features are ordinary JavaScript expressions, variables, functions, arrays, objects, conditionals, loops, async/await, and Promise.all. Imports, filesystem/process access, Node/Bun globals, timers, and dynamic eval are unavailable.",
      "Use exact tool names and schemas. Independent reads may use Promise.all; filesystem mutations are serialized. Await started work and return a compact JSON-compatible result.",
      catalog,
      catalogRuntime.catalog.length > 16 ? "Catalog excerpt only; use search({query, limit, offset}) to discover exact APIs." : "",
      "search({query, limit, offset}) is synchronous and returns matching tool paths and signatures.",
    ].filter(Boolean).join("\n\n"),
    inputSchema: jsonSchema({ type: "object", properties: { code: { type: "string", description: "A program in the supported Code Mode JavaScript subset." } }, required: ["code"], additionalProperties: false }),
    async execute(args, options) {
      if (options.abortSignal?.aborted) throw new Error("Code Mode execution cancelled")
      const code = args && typeof args === "object" && "code" in args && typeof args.code === "string" ? args.code : undefined
      if (code === undefined) return { title: "Code Mode input error", output: "Expected a string field named code.", metadata: { codeModeError: "invalid_input" } }
      const parentCallID = options.toolCallId ?? crypto.randomUUID()
      const execution = CodeModeTrace.create({
        sessionID: input.session.id,
        messageID: input.processor.message.id,
        turnID: input.processor.message.id,
        decisionID: parentCallID,
        model: { providerID: input.model.providerID, id: input.model.id, api: { npm: input.model.api.npm } },
      })
      return run.promise(
        Effect.gen(function* () {
          let callSequence = 0
          const attachmentsByOrder = new Map<number, MessageV2.FilePart[]>()
          const executionAbort = new AbortController()
          const abortExecution = () => executionAbort.abort(options.abortSignal?.reason)
          options.abortSignal?.addEventListener("abort", abortExecution, { once: true })
          if (options.abortSignal?.aborted) abortExecution()
          const activeTools = Object.fromEntries(
            eligible.map(([name, item]) => [
              name,
              codeModePackage.Tool.make({
                description: item.description ?? "",
                input: asSchema(item.inputSchema).jsonSchema as CodeModeToolType.JsonSchema,
                output: Schema.Unknown,
                execute: (toolArgs: unknown) => {
                  const order = ++callSequence
                  const callID = `${parentCallID}:${order}`
                  const mutating = sideEffectTools.has(name) || /(^|[._-])(edit|write|apply_patch|bash|shell|git)([._-]|$)/i.test(name)
                  return Effect.gen(function* () {
                    if (options.abortSignal?.aborted) return yield* Effect.interrupt
                    const argsObject = toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs) ? (toolArgs as Record<string, unknown>) : {}
                    const started = Date.now()
                    yield* execution.write("nested_call_started", {
                      callID,
                      parentID: parentCallID,
                      operationType: "deterministic_program_operation",
                      tool: name,
                      arguments: toolArgs,
                      order,
                    })
                    yield* beginNestedToolCall({
                      id: callID,
                      name,
                      input: argsObject,
                      executionID: execution.executionID,
                      parentCallID,
                    })
                    const opts: ToolExecutionOptions = {
                      toolCallId: callID,
                      messages: input.messages as unknown as ToolExecutionOptions["messages"],
                      abortSignal: executionAbort.signal,
                    }
                    codeModeCalls.set(callID, { trace: execution, executionID: execution.executionID })
                    const runCall = Effect.try({
                      try: () => validators.get(name)?.(toolArgs),
                      catch: (error) => error,
                    }).pipe(Effect.flatMap((validated) => Effect.promise(() => Promise.resolve(item.execute!(validated, opts)))))
                    const boundedResult = (raw: unknown) => {
                      const result = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { output: raw }
                      const attachments = Array.isArray(result.attachments) ? result.attachments : []
                      const safeAttachments = attachments.map((attachment) => {
                        const file = attachment as Record<string, unknown>
                        return { type: file.type, mime: file.mime, filename: file.filename, size: typeof file.url === "string" ? file.url.length : 0 }
                      })
                      const value = { ...result, attachments: safeAttachments }
                      if (new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength <= 48_000) return value
                      return {
                        title: typeof result.title === "string" ? result.title : name,
                        output: typeof result.output === "string" ? `${result.output.slice(0, 36_000)} [nested tool output truncated]` : "[nested tool output truncated]",
                        metadata: { truncated: true },
                        attachments: safeAttachments.slice(0, 16).map((file) => ({
                          type: file.type,
                          mime: file.mime,
                          filename: typeof file.filename === "string" ? file.filename.slice(0, 128) : undefined,
                          size: file.size,
                        })),
                      }
                    }
                    const call = nestedToolLimit
                      .withPermits(1)(mutating ? mutationLimit.withPermits(1)(runCall) : runCall)
                      .pipe(Effect.map(boundedResult))
                    return yield* Effect.ensuring(
                      Effect.onExit(call, (exit) =>
                      Effect.gen(function* () {
                        if (Exit.isSuccess(exit)) {
                          const result = exit.value as Record<string, unknown>
                          const rawResult = result.output
                          const rawAttachments = Array.isArray(result.attachments) ? result.attachments : []
                          attachmentsByOrder.set(order, rawAttachments as MessageV2.FilePart[])
                          yield* execution.write("nested_call_finished", { callID, tool: name, durationMs: Date.now() - started, output: result })
                          yield* input.processor.completeToolCall(callID, {
                            title: typeof result.title === "string" ? result.title : name,
                            output: typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult),
                            metadata: { ...(result.metadata && typeof result.metadata === "object" ? result.metadata : {}), codeModeExecutionID: execution.executionID },
                            attachments: [],
                          })
                          return
                        }
                        const cancelled = options.abortSignal?.aborted === true
                        yield* execution.write(cancelled ? "nested_call_cancelled" : "nested_call_failed", {
                          callID,
                          tool: name,
                          durationMs: Date.now() - started,
                          error: String(Cause.squash(exit.cause)),
                        })
                        yield* failToolCall(callID, Cause.squash(exit.cause))
                      }),
                      ),
                      Effect.sync(() => codeModeCalls.delete(callID)),
                    )
                  })
                },
              }),
            ]),
          )
          const runtime = codeModePackage.CodeMode.make({
            tools: activeTools,
            limits: { timeoutMs: 60_000, maxToolCalls: 32, maxOutputBytes: 96_000 },
          })
          yield* execution.write("execution_started", {
            decisionType: "model_generated_code_decision",
            program: code,
            configuration: { interpreter: "@opencode/codemode@2.0.32", timeoutMs: 60_000, maxToolCalls: 32, maxOutputBytes: 96_000, maxConcurrency: 4 },
          })
          const result = yield* runtime.execute(code).pipe(
            Effect.raceFirst(options.abortSignal ? waitForAbort(options.abortSignal) : Effect.never),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (!Exit.isSuccess(exit)) {
                  yield* execution.write(Cause.hasInterruptsOnly(exit.cause) ? "execution_cancelled" : "execution_failed", {
                    error: String(Cause.squash(exit.cause)),
                  })
                }
                options.abortSignal?.removeEventListener("abort", abortExecution)
                executionAbort.abort()
              }),
            ),
          )
          let attachmentBytes = 0
          let attachmentCount = 0
          let omittedAttachments = 0
          const attachments = Array.from(attachmentsByOrder)
            .sort(([left], [right]) => left - right)
            .flatMap(([, values]) => values)
            .filter((attachment) => {
              const bytes = typeof attachment.url === "string" ? new TextEncoder().encode(attachment.url).byteLength : 0
              if (attachmentCount >= 16 || attachmentBytes + bytes > 8_000_000) {
                omittedAttachments++
                return false
              }
              attachmentCount++
              attachmentBytes += bytes
              return true
            })
          const aggregate = { result, attachmentCount: attachments.length, omittedAttachments }
          yield* execution.write("aggregate_returned", aggregate)
          return {
            title: "Code Mode execution",
            output: JSON.stringify({ executionID: execution.executionID, result }),
            metadata: { codeModeExecutionID: execution.executionID, traceVersion: 1, omittedAttachments },
            attachments,
          }
        }),
      )
    },
  })
  return tools
})

export * as SessionTools from "./tools"
