import { expect, test } from "bun:test"
import { MessageV2 } from "@/session/message-v2"
import type { Provider } from "@/provider/provider"

test("Code Mode child tool parts remain visible in session state but are excluded from later model decisions", async () => {
  const sessionID = "ses-code-mode-history"
  const messageID = "msg-code-mode-history"
  const base = {
    id: "prt-code-mode-tool",
    messageID,
    sessionID,
    type: "tool" as const,
    callID: "call-1",
    state: {
      status: "completed" as const,
      input: { file: "src/main.ts" },
      output: "file contents",
      title: "read",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
  const message = {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "msg-user",
      modelID: "local-model",
      providerID: "homecode-local",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { ...base, metadata: { codeModeExecutionID: "exec-1", parentCallID: "execute-1", decisionType: "deterministic_program_operation" } },
      { ...base, id: "prt-code-mode-outer", callID: "execute-1", tool: "execute", state: { ...base.state, input: { code: "return 42" }, output: '{"result":42}' } },
    ],
  } as unknown as MessageV2.WithParts
  const model = {
    id: "local-model",
    providerID: "homecode-local",
    api: { id: "local-model", npm: "@ai-sdk/openai-compatible", url: "http://127.0.0.1:8080/v1" },
    name: "local",
    capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
    cost: { input: 0, output: 0 },
    limit: { context: 4096, output: 1024 },
    status: "active",
    options: {},
    headers: {},
  } as unknown as Provider.Model
  const messages = await MessageV2.toModelMessages([message], model)
  const assistant = messages[0]
  expect(assistant?.role).toBe("assistant")
  expect(JSON.stringify(assistant?.content)).toContain("execute-1")
  expect(JSON.stringify(assistant?.content)).not.toContain("call-1")
  expect(JSON.stringify(assistant?.content)).not.toContain("tool-read")
})
