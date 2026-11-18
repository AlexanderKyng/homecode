import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { asSchema } from "ai"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { SessionTools } from "@/session/tools"
import { MessageID, SessionID } from "@/session/schema"

const calls: string[] = []
const parameters = Schema.Struct({ value: Schema.String })
const definition: Tool.Def<typeof parameters> = {
  id: "inspect",
  description: "Inspect a value",
  parameters,
  execute: (args, ctx) =>
    Effect.gen(function* () {
      calls.push(`executor:${args.value}`)
      yield* ctx.ask({ permission: "inspect", patterns: [args.value], metadata: {}, always: [] })
      return { title: "inspected", output: `result:${args.value}`, metadata: {} }
    }),
}

const layers = Layer.mergeAll(
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      tools: () => Effect.succeed([definition]),
      ids: () => Effect.succeed(["inspect"]),
      all: () => Effect.succeed([definition]),
      named: () => Effect.die("not used"),
    }),
  ),
  Layer.mock(Plugin.Service)({
    trigger: (name, _input, output) => {
      if (name === "tool.execute.before" || name === "tool.execute.after") calls.push(`plugin:${name}`)
      return Effect.succeed(output)
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }),
  Layer.mock(Permission.Service)({
    ask: (request) => Effect.sync(() => calls.push(`ask:${request.permission}:${request.patterns.join(",")}`)),
    reply: () => Effect.die("not used"),
    list: () => Effect.succeed([]),
  }),
  Layer.mock(MCP.Service)({ tools: () => Effect.succeed({}) }),
  Layer.mock(Truncate.Service)({
    output: (content) => Effect.succeed({ content, truncated: false }),
  }),
)

const model = {
  id: "test-model",
  providerID: "test-provider",
  api: { id: "test-api", npm: "@ai-sdk/openai" },
} as unknown as Provider.Model

const session = {
  id: SessionID.make("ses_codemode_test"),
  permission: [],
} as never

const processor = {
  message: { id: MessageID.make("msg_codemode_test") },
  updateToolCall: () => Effect.succeed(true),
  completeToolCall: () => Effect.succeed(true),
  beginNestedToolCall: (input: { name: string; input: Record<string, unknown> }) =>
    Effect.sync(() => calls.push(`nested:${input.name}:${input.input.value}`)),
  failToolCall: () => Effect.succeed(true),
} as never

function agent(codeMode: boolean): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    permission: [],
    options: {},
    codeMode,
  }
}

function resolve(codeMode: boolean) {
  return SessionTools.resolve({
    agent: agent(codeMode),
    model,
    session,
    processor,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  }).pipe(Effect.provide(layers))
}

describe("SessionTools Code Mode integration", () => {
  test("keeps direct tools when disabled and routes nested calls through wrapped execution when enabled", async () => {
    calls.length = 0
    const direct = await Effect.runPromise(resolve(false))
    expect(Object.keys(direct)).toEqual(["inspect"])
    const directTool = direct.inspect
    expect(directTool).toBeDefined()
    await directTool!.execute!({ value: "direct" }, {
      toolCallId: "direct-call",
      abortSignal: new AbortController().signal,
      messages: [],
    })
    expect(calls).toEqual([
      "plugin:tool.execute.before",
      "executor:direct",
      "ask:inspect:direct",
      "plugin:tool.execute.after",
    ])

    calls.length = 0
    const enabled = await Effect.runPromise(resolve(true))
    expect(Object.keys(enabled)).toEqual(["execute"])
    expect(asSchema(enabled.execute!.inputSchema).jsonSchema).toMatchObject({
      type: "object",
      required: ["code"],
    })
    await enabled.execute!.execute!({ code: 'const result = await tools.inspect({ value: "nested" }); return result.output;' }, {
      toolCallId: "parent-call",
      abortSignal: new AbortController().signal,
      messages: [],
    })
    expect(calls).toContain("nested:inspect:nested")
    expect(calls).toContain("plugin:tool.execute.before")
    expect(calls).toContain("executor:nested")
    expect(calls).toContain("ask:inspect:nested")
    expect(calls).toContain("plugin:tool.execute.after")
    expect(calls.at(-1)).toBe("plugin:tool.execute.after")
  })
})
