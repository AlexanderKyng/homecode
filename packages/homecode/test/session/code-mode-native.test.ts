import { expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect } from "effect"
import type { Provider } from "@/provider/provider"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { LLMNative } from "@/session/llm/native-request"

test("native tool bridge preserves Code Mode execute schema and routes its arguments through HomeCode", async () => {
  const received: unknown[] = []
  const execute = tool({
    description: "Execute confined Code Mode source",
    inputSchema: jsonSchema({
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    }),
    execute: async (args) => {
      received.push(args)
      return { output: "complete" }
    },
  })
  const abort = new AbortController().signal
  const native = LLMNativeRuntime.nativeTools({ execute }, { messages: [], abort })
  expect(native.execute._definition.inputSchema).toMatchObject({
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  })
  const result = await Effect.runPromise(native.execute.execute!({ code: "return 42" }, { id: "decision-1", name: "execute" }))
  expect(received).toEqual([{ code: "return 42" }])
  expect(result).toEqual({ output: "complete" })
})

test("native request serializes execute as an ordinary schema-accurate tool definition", () => {
  const model = {
    id: "local/test",
    providerID: "local",
    api: { id: "test-model", npm: "@ai-sdk/openai-compatible", url: "http://127.0.0.1:8080/v1" },
    name: "Local test",
    capabilities: { temperature: true, reasoning: true, attachment: false, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
    cost: { input: 0, output: 0 },
    limit: { context: 4096, output: 1024 },
    status: "active",
    options: {},
    headers: {},
  } as unknown as Provider.Model
  const request = LLMNative.request({
    model,
    messages: [],
    tools: {
      execute: {
        description: "Run Code Mode source",
        inputSchema: jsonSchema({ type: "object", properties: { code: { type: "string" } }, required: ["code"] }),
      },
    },
  })
  expect(request.tools).toHaveLength(1)
  expect(request.tools[0]).toMatchObject({ name: "execute", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } })
})
