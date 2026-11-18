import { describe, expect, test } from "bun:test"
import { jsonSchema } from "ai"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@homecode-ai/llm"
import { Atem } from "@/session/llm/atem"

describe("ATEM tool format", () => {
  test("resolves the project-local canonical template path", () => {
    expect(Atem.templatePath("/workspace")).toBe("/workspace/.homecode/chat_template-ATEM.jinja")
  })

  test("auto-detects Glimmer and HomeAgent models and honors overrides", () => {
    expect(Atem.resolve({ modelID: "Muse-Glimmer-12B" })).toBe("atem")
    expect(Atem.resolve({ modelID: "Muse-30B" })).toBe("atem")
    expect(Atem.resolve({ modelID: "homeagent-dev" })).toBe("atem")
    expect(Atem.resolve({ modelID: "homeagent-dev", override: "hermes" })).toBe("hermes")
    expect(Atem.resolve({ modelID: "model-alias", modelConfig: "Muse-Glimmer-12B" })).toBe("atem")
    expect(Atem.resolve({ modelID: "gpt-5", configured: "json" })).toBe("json")
    expect(Atem.resolve({ modelID: "gpt-5" })).toBe("hermes")
  })

  test("renders canonical metadata, schemas, recipients, and invocation example", () => {
    const prompt = Atem.renderSystemPrompt({
      "filesystem.read": {
        description: "Read a file",
        inputSchema: jsonSchema({
          type: "object",
          properties: { path: { type: "string" } },
        }),
      },
    })

    expect(prompt).toContain("// Tool metadata")
    expect(prompt).toContain("// Function schemas")
    expect(prompt).toContain('# Valid recipients: "self", "filesystem.*", "user".')
    expect(prompt).toContain("<atem:function_calls>")
    expect(prompt).toContain('<atem:invoke name="example_tool_name.example_function_name">')
    expect(prompt).toContain('"name":"filesystem.read"')
  })

  test("parses multiline values, JSON arguments, reasoning, and multiple calls", () => {
    const parsed = Atem.parse(
      [
        "<|start|>assistant to=self<|message|>Plan first<|eom|>",
        "<|start|>assistant to=filesystem.read<|message|>",
        "[atem:function_calls]",
        '<atem:invoke name="filesystem.read">',
        '<atem:parameter name="path">src/main.ts</atem:parameter>',
        '<atem:parameter name="lines">[1, 2, 3]</atem:parameter>',
        '<atem:parameter name="note">line one\nline two</atem:parameter>',
        "</atem:invoke>",
        "</atem:function_calls>",
        "<|eot|>",
      ].join("\n"),
    )

    expect(parsed.reasoning).toBe("Plan first")
    expect(parsed.text.trim()).toBe("")
    expect(parsed.errors).toEqual([])
    expect(parsed.calls).toEqual([
      {
        name: "filesystem.read",
        arguments: { path: "src/main.ts", lines: [1, 2, 3], note: "line one\nline two" },
        raw: expect.any(String),
      },
    ])
  })

  test("parses direct channel invocation without atem:function_calls block", () => {
    const parsed = Atem.parse(
      [
        "<|start|>assistant to=self<|message|>Need to read package.json<|eom|>",
        '<|start|>assistant to=read<|message|>{"filePath": "package.json"}<|eot|>',
      ].join("\n"),
    )

    expect(parsed.reasoning).toBe("Need to read package.json")
    expect(parsed.text.trim()).toBe("")
    expect(parsed.errors).toEqual([])
    expect(parsed.calls).toEqual([
      {
        name: "read",
        arguments: { filePath: "package.json" },
        raw: '<|start|>assistant to=read<|message|>{"filePath": "package.json"}<|eot|>',
      },
    ])
  })

  test("turns streamed ATEM text into executable common tool events", async () => {
    const stream = Stream.fromIterable<LLMEvent>([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "text-0" }),
      LLMEvent.textDelta({ id: "text-0", text: '[atem:function_calls]\n<atem:invoke name="echo">' }),
      LLMEvent.textDelta({
        id: "text-0",
        text: '<atem:parameter name="value">hello</atem:parameter>\n</atem:invoke>\n</atem:function_calls>',
      }),
      LLMEvent.textEnd({ id: "text-0" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
      LLMEvent.finish({ reason: "stop" }),
    ])

    const events = await Effect.runPromise(Stream.runCollect(Atem.stream(stream)))
    const calls = events.filter(LLMEvent.is.toolCall)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: "echo", input: { value: "hello" } })
    expect(events.find(LLMEvent.is.stepFinish)).toMatchObject({ reason: "tool-calls" })
  })

  test("serializes tool observations with native Glimmer delimiters", () => {
    expect(Atem.serializeToolObservation("echo", "hello\nworld")).toBe(
      '<|start|>tool echo<|message|><tool_output name="echo">\nhello\nworld\n</tool_output><|eot|>',
    )
  })

  test("converts malformed tags into an invalid tool call", async () => {
    const stream = Stream.fromIterable<LLMEvent>([
      LLMEvent.textStart({ id: "text-0" }),
      LLMEvent.textDelta({ id: "text-0", text: '<atem:function_calls><atem:invoke name="echo">' }),
      LLMEvent.textEnd({ id: "text-0" }),
    ])

    const events = await Effect.runPromise(Stream.runCollect(Atem.stream(stream)))
    const call = events.find(LLMEvent.is.toolCall)
    if (!call) throw new Error("Expected an invalid tool call event")
    expect(call).toMatchObject({ name: "invalid", input: { tool: "atem" } })
    expect((call.input as { readonly error: string }).error).toContain('"code":"atem_parse_error"')
  })
})
