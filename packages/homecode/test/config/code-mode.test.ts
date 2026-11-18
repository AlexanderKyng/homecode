import { expect, test } from "bun:test"
import { ConfigAgent } from "@/config/agent"
import { Schema } from "effect"

test("agent configuration keeps Code Mode opt-in and accepts direct-only exclusions", () => {
  const disabledByDefault = Schema.decodeUnknownSync(ConfigAgent.Info)({})
  expect(disabledByDefault.codeMode).toBeUndefined()

  const enabled = Schema.decodeUnknownSync(ConfigAgent.Info)({
    codeMode: true,
    codeModeExclude: ["task", "mcp_calendar_delete"],
  })
  expect(enabled.codeMode).toBe(true)
  expect(enabled.options?.codeModeExclude).toEqual(["task", "mcp_calendar_delete"])
})
