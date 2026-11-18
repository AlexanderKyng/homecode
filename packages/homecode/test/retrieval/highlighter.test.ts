import { describe, expect, it } from "bun:test"
import { extractHighlights, segmentDocument } from "@/retrieval/highlighter"

describe("Passage Highlighter", () => {
  const sampleDoc = `
# Effect-TS Overview

Effect is a library for building robust applications in TypeScript.

## Error Handling

Effect makes error handling explicit and typed. Unlike standard try/catch, Effect tracks errors in the type system.

\`\`\`typescript
const program = Effect.try({
  try: () => JSON.parse(invalidJson),
  catch: (error) => new ParseError({ error })
})
\`\`\`

## Schema Decoding

Effect Schema provides bidirectional encoding and decoding of untrusted data with full type inference.

\`\`\`typescript
const User = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  email: Schema.String,
})
const decodeUser = Schema.decodeUnknownEffect(User)
\`\`\`

## Concurrency and Fibers

Fibers are lightweight virtual threads managed by the Effect runtime.
`

  it("segments markdown into structural passages", () => {
    const segments = segmentDocument(sampleDoc)
    expect(segments.length).toBeGreaterThan(4)

    const codeSegments = segments.filter((s) => s.isCode)
    expect(codeSegments.length).toBe(2)
    expect(codeSegments[0].text).toContain("const program = Effect.try")
    expect(codeSegments[1].text).toContain("Schema.decodeUnknownEffect")
  })

  it("extracts query-conditioned highlights with high precision", () => {
    const query = "Schema.decodeUnknownEffect untrusted data"
    const highlights = extractHighlights(query, sampleDoc, { maxHighlights: 2 })

    expect(highlights.length).toBeGreaterThan(0)
    const combined = highlights.join("\n")
    expect(combined).toContain("Effect Schema provides bidirectional encoding")
    expect(combined).toContain("Schema.decodeUnknownEffect(User)")
    expect(combined).not.toContain("Fibers are lightweight virtual threads")
  })

  it("respects maxCharacters budget", () => {
    const highlights = extractHighlights("Effect", sampleDoc, { maxCharacters: 150 })
    const totalLength = highlights.reduce((acc, h) => acc + h.length, 0)
    expect(totalLength).toBeLessThanOrEqual(250)
  })
})
