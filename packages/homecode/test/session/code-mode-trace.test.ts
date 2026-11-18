import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { CodeModeTrace, redact } from "@/session/code-mode-trace"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("redacts secret fields and writes a versioned, linked execution trace", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "homecode-codemode-trace-"))
  temporary.push(rootDir)
  const trace = CodeModeTrace.create({
    rootDir,
    sessionID: "session-1",
    messageID: "message-1",
    turnID: "message-1",
    decisionID: "call-1",
    model: { providerID: "local", id: "homeagent", api: { npm: "@ai-sdk/openai-compatible" } },
  })
  await Effect.runPromise(trace.write("execution_started", { program: `return { api_key: "secret", text: "Bearer abc123" }` }))
  await Effect.runPromise(trace.write("aggregate_returned", { result: { ok: true } }))
  const contents = await readFile(path.join(rootDir, "codemode-traces", "session-1", `${trace.executionID}.jsonl`), "utf8")
  const records = contents.trim().split("\n").map((line) => JSON.parse(line))
  expect(records).toHaveLength(2)
  expect(records[0]).toMatchObject({ version: 1, sessionID: "session-1", messageID: "message-1", turnID: "message-1", decisionID: "call-1", sequence: 1 })
  expect(JSON.stringify(records)).not.toContain("abc123")
  expect(JSON.stringify(records)).not.toContain('"secret"')
  expect(redact({ password: "hidden", harmless: "ok" })).toEqual({ password: "[REDACTED]", harmless: "ok" })
})
