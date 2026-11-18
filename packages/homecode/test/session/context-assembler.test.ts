import { describe, expect, test } from "bun:test"
import { assemble, type DynamicContextBlock } from "../../src/session/context-assembler"

describe("session context assembler", () => {
  test("preserves the existing HomeMem-only format", () => {
    const messages = assemble({
      messages: [{ role: "user", content: "Fix the failing test" }],
      blocks: [{ source: "homemem", text: "known correction", estimatedTokens: 4, priority: 10 }],
      tokenBudget: 20,
    })

    expect(messages[0]?.content).toBe(
      'Fix the failing test\n\n<dynamic_context source="homemem">\nRelevant evidence-derived Recall Capsules:\n- known correction\n</dynamic_context>',
    )
  })

  test("renders mixed sources deterministically and appends to the last user", () => {
    const blocks: DynamicContextBlock[] = [
      { source: "homesitter", text: "path: src/a.ts", estimatedTokens: 3, priority: 10 },
      { source: "homemem", text: "known rule", estimatedTokens: 3, priority: 10 },
    ]
    const messages = assemble({
      messages: [
        { role: "user", content: "Earlier request" },
        { role: "assistant", content: "working" },
        { role: "user", content: "Current request" },
      ],
      blocks,
      tokenBudget: 6,
    })

    expect(messages[0]?.content).toBe("Earlier request")
    expect(messages[2]?.content).toBe(
      'Current request\n\n<dynamic_context source="homemem,homesitter">\nRelevant deterministic context evidence:\n[homemem] known rule\n[homesitter] path: src/a.ts\n</dynamic_context>',
    )
  })
})
