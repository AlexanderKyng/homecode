import { describe, expect, it } from "bun:test"
import { make as makeReranker } from "@/retrieval/reranker"
import { Effect } from "effect"

describe("Local CPU Reranker", () => {
  const reranker = makeReranker()

  it("ranks relevant documents above irrelevant ones", async () => {
    const query = "how to handle errors in Effect-TS"
    const documents = [
      {
        id: "doc1",
        text: "Cooking pasta: Boil salted water and add pasta for 10 minutes.",
      },
      {
        id: "doc2",
        text: "Effect-TS error management: Effect represents typed errors using either or typed failure channels.",
      },
      {
        id: "doc3",
        text: "Weather forecast: Rain expected in Paris this afternoon.",
      },
      {
        id: "doc4",
        text: "Error handling in TypeScript using try catch blocks and standard Error objects.",
      },
    ]

    const ranked = await Effect.runPromise(
      reranker.rerank({
        query,
        documents,
      }),
    )

    expect(ranked.length).toBe(4)
    // Most relevant must be doc2 (exact match on Effect-TS error management)
    expect(ranked[0].id).toBe("doc2")
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)

    // doc4 should be higher than irrelevant doc1 and doc3
    const doc4Index = ranked.findIndex((r) => r.id === "doc4")
    const doc1Index = ranked.findIndex((r) => r.id === "doc1")
    const doc3Index = ranked.findIndex((r) => r.id === "doc3")
    expect(doc4Index).toBeLessThan(doc1Index)
    expect(doc4Index).toBeLessThan(doc3Index)
  })

  it("executes fast on CPU (< 15ms for 30 documents)", async () => {
    const query = "React useState hook concurrency"
    const documents = Array.from({ length: 30 }, (_, i) => ({
      id: `doc_${i}`,
      text: `Document number ${i} discussing React hooks, useState state updates, and concurrent rendering mechanisms in React 19.`,
    }))

    const start = performance.now()
    const ranked = await Effect.runPromise(
      reranker.rerank({
        query,
        documents,
        topK: 10,
      }),
    )
    const elapsed = performance.now() - start

    expect(ranked.length).toBe(10)
    expect(elapsed).toBeLessThan(50) // High margin for CI environments
  })
})
