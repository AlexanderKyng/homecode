import path from "path"
import { Option, Schema } from "effect"
import * as Stream from "effect/Stream"
import { type Tool } from "ai"
import { LLMEvent, type ProviderMetadata } from "@homecode-ai/llm"
import { ConfigToolFormat, type ToolFormat } from "@/config/tool-format"
import { isRecord } from "@/util/record"

const ATEM_MODEL_PATTERN = /(glimmer|homeagent)/i
const ATEM_INVOKE = /<atem:invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/atem:invoke>/g
const ATEM_PARAMETER = /<atem:parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/atem:parameter>/g
const ATEM_CONTROL_TAG = /(?:\[?\/?atem:(?:function_calls|invoke|parameter)[^>]*\]?)/
const ASSISTANT_CHANNEL = /<\|start\|>assistant(?:\s+to=([^\s<]+))?<\|message\|>([\s\S]*?)(<\|eom\|>|<\|eot\|>)/g
const ASSISTANT_CHANNEL_START = /<\|start\|>assistant(?:\s+to=[^\s<]+)?<\|message\|>/g

export type AtemFunctionCall = {
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly raw: string
}

export type AtemParseError = {
  readonly code: "atem_parse_error"
  readonly message: string
  readonly raw?: string
}

export type AtemParseResult = {
  readonly detected: boolean
  readonly text: string
  readonly reasoning: string
  readonly calls: ReadonlyArray<AtemFunctionCall>
  readonly errors: ReadonlyArray<AtemParseError>
}

export type AtemTool = Pick<Tool, "description" | "inputSchema">

export function resolve(input: {
  readonly modelID: string
  readonly providerID?: string
  readonly modelConfig?: string
  readonly override?: ToolFormat
  readonly configured?: ToolFormat
}): ToolFormat {
  if (input.override) return input.override
  if (input.configured) return input.configured
  const identifier = [input.providerID ?? "", input.modelID, input.modelConfig ?? ""].join("/")
  return ATEM_MODEL_PATTERN.test(identifier) ? "atem" : "hermes"
}

export function matchesModel(modelID: string): boolean {
  return ATEM_MODEL_PATTERN.test(modelID)
}

export function templatePath(projectRoot: string): string {
  return path.join(projectRoot, ".homecode", "chat_template-ATEM.jinja")
}

export function renderToolDefinitions(tools: Record<string, AtemTool>): string {
  const entries = Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))
  const namespaces = [...new Set(entries.map(([name]) => name.split(".")[0]))]
  const metadata = namespaces.map((name) => JSON.stringify({ name, description: "" })).join("\n")
  const schemas = entries
    .map(([name, tool]) => {
      const inputSchema =
        isRecord(tool.inputSchema) && isRecord(tool.inputSchema.jsonSchema)
          ? tool.inputSchema.jsonSchema
          : (tool.inputSchema ?? { type: "object", properties: {} })
      return JSON.stringify({
        name,
        description: tool.description ?? "",
        parameters: inputSchema,
      })
    })
    .join("\n")

  return [
    "In this environment you have access to a set of tools you can use to answer the user's question.",
    "",
    'You can invoke a function by writing a "<atem:function_calls>" block like the following:',
    "<atem:function_calls>",
    '<atem:invoke name="$FUNCTION_NAME">',
    '<atem:parameter name="$PARAMETER_NAME">$PARAMETER_VALUE</atem:parameter>',
    "...",
    "</atem:invoke>",
    "</atem:function_calls>",
    "",
    "String and scalar parameters should be specified as is, while lists and objects should use JSON format. Note that spaces for string values are not stripped. The output is not expected to be valid XML and is parsed with regular expressions.",
    "Here are the functions available in JSONSchema format:",
    "// Tool metadata",
    metadata,
    "// Function schemas",
    schemas,
    "",
    "Here's an example of how to call a function in the tool set:",
    "(If the tool namespace is not specified, invoke the function directly as `example_function_name` rather than `example_tool_name.example_function_name`)",
    "",
    "to=example_tool_name.example_function_name",
    "",
    '<atem:function_calls>\n<atem:invoke name="example_tool_name.example_function_name">',
    '<atem:parameter name="example_parameter_1">value_1</atem:parameter>',
    '<atem:parameter name="example_parameter_2">This is the value for the second parameter',
    "that can span",
    '"multiple" lines',
    "</atem:parameter>",
    "</atem:invoke>\n</atem:function_calls>",
  ].join("\n")
}

export function renderSystemPrompt(tools: Record<string, AtemTool>): string {
  const namespaces = [...new Set(Object.keys(tools).map((name) => name.split(".")[0]))]
  const recipients = ['"self"', ...namespaces.map((name) => `"${name}.*"`), '"user"']
  return [
    "Reasoning strength: high.",
    renderToolDefinitions(tools),
    `# Valid recipients: ${recipients.join(", ")}.`,
  ].join("\n\n")
}

export function serializeToolObservation(toolName: string, output: unknown): string {
  const value = typeof output === "string" ? output : JSON.stringify(output)
  return `<|start|>tool ${toolName}<|message|><tool_output name="${escapeAttribute(toolName)}">\n${value ?? ""}\n</tool_output><|eot|>`
}

export function machineReadableError(error: AtemParseError, raw?: string): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    ...(raw === undefined ? {} : { raw: raw.slice(0, 2000) }),
  })
}

export function parse(output: string): AtemParseResult {
  const errors: AtemParseError[] = []
  let reasoning = ""
  let body = output
  let channelMatch: RegExpExecArray | null
  let channelEnd = 0

  ASSISTANT_CHANNEL.lastIndex = 0
  while ((channelMatch = ASSISTANT_CHANNEL.exec(output)) !== null) {
    const match = channelMatch
    const recipient = match[1] ?? "user"
    if (recipient === "self") reasoning += match[2]
    body = body.replace(match[0], () => (recipient === "self" ? "" : match[2]))
    channelEnd = Math.max(channelEnd, match.index + match[0].length)
  }

  ASSISTANT_CHANNEL_START.lastIndex = 0
  if (ASSISTANT_CHANNEL_START.test(output.slice(channelEnd))) {
    errors.push({
      code: "atem_parse_error",
      message: "assistant channel is missing <|eom|> or <|eot|>",
      raw: output,
    })
  }

  const detected =
    reasoning.length > 0 ||
    ATEM_CONTROL_TAG.test(body) ||
    body.includes("[atem:function_calls]") ||
    body.includes("<atem:function_calls>")

  const calls: AtemFunctionCall[] = []
  const blocks = [
    ...body.matchAll(
      /(?:\[atem:function_calls\]|<atem:function_calls>)([\s\S]*?)(?:<\/atem:function_calls>|\[\/atem:function_calls\])/g,
    ),
  ]
  let visible = body.replace(
    /(?:\[atem:function_calls\]|<atem:function_calls>)([\s\S]*?)(?:<\/atem:function_calls>|\[\/atem:function_calls\])/g,
    "",
  )

  for (const block of blocks) parseInvocations(block[1], calls, errors)

  if (detected && blocks.length === 0 && body.includes("<atem:function_calls>")) {
    errors.push({
      code: "atem_parse_error",
      message: "function call block is missing </atem:function_calls>",
      raw: output,
    })
  }

  if (detected && blocks.length === 0 && body.includes("<atem:invoke")) parseInvocations(body, calls, errors)

  if (detected && ATEM_CONTROL_TAG.test(visible)) {
    errors.push({
      code: "atem_parse_error",
      message: "ATEM output contains an incomplete or unbalanced tag sequence",
      raw: output,
    })
  }

  visible = visible.replace(/<\|(?:eom|eot)\|>/g, "").replace(ASSISTANT_CHANNEL_START, "")
  return {
    detected,
    text: visible,
    reasoning,
    calls,
    errors,
  }
}

function parseInvocations(input: string, calls: AtemFunctionCall[], errors: AtemParseError[]) {
  ATEM_INVOKE.lastIndex = 0
  const matches = [...input.matchAll(ATEM_INVOKE)]
  for (const match of matches) {
    const name = match[1]
    const argumentText = match[2]
    if (!name || argumentText === undefined) {
      errors.push({ code: "atem_parse_error", message: "ATEM invocation is missing its name or body" })
      continue
    }
    const errorCount = errors.length
    const args: Record<string, unknown> = {}
    ATEM_PARAMETER.lastIndex = 0
    for (const parameter of argumentText.matchAll(ATEM_PARAMETER)) {
      const parameterName = parameter[1]
      const parameterValue = parameter[2]
      if (!parameterName || parameterValue === undefined) continue
      if (parameterName in args) {
        errors.push({ code: "atem_parse_error", message: `ATEM invocation ${name} repeats parameter ${parameterName}` })
        continue
      }
      const value = decodeParameter(parameterValue)
      if (value._tag === "error") {
        errors.push({ ...value.error, raw: parameterValue })
        continue
      }
      args[parameterName] = value.value
    }

    const remainder = argumentText.replace(ATEM_PARAMETER, "").trim()
    if (remainder.length > 0) {
      errors.push({
        code: "atem_parse_error",
        message: `ATEM invocation ${name} contains an unparseable parameter tag sequence`,
      })
    }
    if (errors.length === errorCount) calls.push({ name, arguments: args, raw: match[0] })
  }

  if (matches.length === 0 && /<atem:invoke\b/.test(input)) {
    errors.push({ code: "atem_parse_error", message: "ATEM invocation is missing </atem:invoke>" })
  }
}

function decodeParameter(
  value: string,
): { readonly _tag: "value"; readonly value: unknown } | { readonly _tag: "error"; readonly error: AtemParseError } {
  const candidate = value.trim()
  if (candidate === "true") return { _tag: "value", value: true }
  if (candidate === "false") return { _tag: "value", value: false }
  if (candidate === "null") return { _tag: "value", value: null }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(candidate))
    return { _tag: "value", value: Number(candidate) }
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return { _tag: "value", value }

  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(candidate)
  if (Option.isSome(parsed)) return { _tag: "value", value: parsed.value }
  return {
    _tag: "error",
    error: {
      code: "atem_parse_error",
      message: "complex ATEM parameter is not valid JSON",
    },
  }
}

type AtemStreamState = {
  buffer: string
  textID?: string
  textMetadata?: ProviderMetadata
  toolCalls: number
  parsed: boolean
}

export function stream<E>(input: Stream.Stream<LLMEvent, E>): Stream.Stream<LLMEvent, E> {
  return input.pipe(
    Stream.mapAccum<AtemStreamState, LLMEvent, LLMEvent>(
      () => ({ buffer: "", toolCalls: 0, parsed: false }) satisfies AtemStreamState,
      (state, event) => adaptEvent(state, event),
      { onHalt: (state) => flush(state) },
    ),
  )
}

function adaptEvent(state: AtemStreamState, event: LLMEvent): readonly [AtemStreamState, ReadonlyArray<LLMEvent>] {
  if (event.type === "text-start") {
    state.textID = event.id
    state.textMetadata = event.providerMetadata
    return [state, []]
  }
  if (event.type === "text-delta") {
    state.buffer += event.text
    state.textMetadata = event.providerMetadata ?? state.textMetadata
    return [state, []]
  }
  if (event.type === "text-end") {
    return [state, flushText(state)]
  }
  if (event.type === "step-finish") {
    if (state.buffer.length > 0) return [state, [...flushText(state), finishStep(event, state)]]
    return [state, [finishStep(event, state)]]
  }
  if (event.type === "finish") {
    if (state.buffer.length > 0) return [state, [...flushText(state), finish(event, state)]]
    return [state, [finish(event, state)]]
  }
  return [state, [event]]
}

function flushText(state: AtemStreamState): ReadonlyArray<LLMEvent> {
  if (state.parsed && state.buffer.length === 0) return []
  const raw = state.buffer
  state.buffer = ""
  state.parsed = true
  if (raw.length === 0) return []

  const parsed = parse(raw)
  if (!parsed.detected) return plainText(state, raw)

  const events: LLMEvent[] = []
  if (parsed.reasoning.length > 0) {
    events.push(LLMEvent.reasoningStart({ id: "atem-reasoning" }))
    events.push(LLMEvent.reasoningDelta({ id: "atem-reasoning", text: parsed.reasoning }))
    events.push(LLMEvent.reasoningEnd({ id: "atem-reasoning" }))
  }
  if (parsed.text.length > 0) events.push(...plainText(state, parsed.text))
  for (const call of parsed.calls) {
    const id = `atem-${state.toolCalls++}`
    events.push(LLMEvent.toolInputStart({ id, name: call.name }))
    events.push(LLMEvent.toolInputEnd({ id, name: call.name }))
    events.push(LLMEvent.toolCall({ id, name: call.name, input: call.arguments }))
  }
  for (const error of parsed.errors) {
    const id = `atem-${state.toolCalls++}`
    events.push(LLMEvent.toolInputStart({ id, name: "invalid" }))
    events.push(LLMEvent.toolInputEnd({ id, name: "invalid" }))
    events.push(
      LLMEvent.toolCall({
        id,
        name: "invalid",
        input: {
          tool: "atem",
          error: machineReadableError(error, raw),
        },
      }),
    )
  }
  return events
}

function plainText(state: AtemStreamState, text: string): ReadonlyArray<LLMEvent> {
  const id = state.textID ?? "atem-text"
  return [
    LLMEvent.textStart({ id, providerMetadata: state.textMetadata }),
    LLMEvent.textDelta({ id, text, providerMetadata: state.textMetadata }),
    LLMEvent.textEnd({ id, providerMetadata: state.textMetadata }),
  ]
}

function flush(state: AtemStreamState): ReadonlyArray<LLMEvent> {
  return flushText(state)
}

function finishStep(event: Extract<LLMEvent, { type: "step-finish" }>, state: AtemStreamState) {
  return LLMEvent.stepFinish({
    ...event,
    reason: state.toolCalls > 0 && event.reason === "stop" ? "tool-calls" : event.reason,
  })
}

function finish(event: Extract<LLMEvent, { type: "finish" }>, state: AtemStreamState) {
  return LLMEvent.finish({
    ...event,
    reason: state.toolCalls > 0 && event.reason === "stop" ? "tool-calls" : event.reason,
  })
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export { ConfigToolFormat }
export type { ToolFormat }
export * as Atem from "./atem"
