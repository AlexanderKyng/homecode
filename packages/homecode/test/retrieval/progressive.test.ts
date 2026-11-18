import { describe, expect, it } from "bun:test"
import { reformulateQuery, evaluateSufficiency } from "@/retrieval/progressive"

describe("Progressive Retrieval & Second-Pass Expansion", () => {
  it("expands known technical acronyms for better recall", () => {
    expect(reformulateQuery("CRDT conflict resolution")).toContain("conflict-free replicated data type")
    expect(reformulateQuery("AST traversal in TypeScript")).toContain("abstract syntax tree")
    expect(reformulateQuery("SSRF prevention rules")).toContain("server side request forgery")
    expect(reformulateQuery("MRR ranking evaluation")).toContain("mean reciprocal rank")
  })

  it("evaluates evidence sufficiency accurately", () => {
    const sufficientRanked = [
      { id: "doc1", score: 12.5, index: 0 },
      { id: "doc2", score: 3.2, index: 1 },
    ]
    const highPassages = [{ text: "High quality evidence snippet with exact match", score: 8.5 }]

    const res1 = evaluateSufficiency(sufficientRanked, highPassages)
    expect(res1.isSufficient).toBe(true)
    expect(res1.reason).toBe("high_confidence_evidence")

    const tiedLowRanked = [
      { id: "doc1", score: 1.2, index: 0 },
      { id: "doc2", score: 1.1, index: 1 },
    ]
    const lowPassages = [{ text: "Weak unrelated snippet", score: 1.0 }]

    const res2 = evaluateSufficiency(tiedLowRanked, lowPassages)
    expect(res2.isSufficient).toBe(false)
    expect(res2.reason).toBe("insufficient_score_or_margin")

    const resEmpty = evaluateSufficiency([], [])
    expect(resEmpty.isSufficient).toBe(false)
    expect(resEmpty.reason).toBe("zero_candidates")
  })
})
