import { describe, expect, it } from "bun:test"
import { classifyQuery } from "@/retrieval/classifier"

describe("Search Intelligence & Classifier", () => {
  it("classifies direct URLs", () => {
    const res = classifyQuery("https://github.com/anomalyco/homecode")
    expect(res.category).toBe("url")
    expect(res.isUrl).toBe(true)
  })

  it("classifies workspace symbols and file paths", () => {
    const symbolRes = classifyQuery("@/retrieval/reranker.ts")
    expect(symbolRes.category).toBe("workspace_symbol")
    expect(symbolRes.isWorkspaceSymbol).toBe(true)

    const fnRes = classifyQuery("fn:handleRequest")
    expect(fnRes.category).toBe("workspace_symbol")
  })

  it("classifies error messages and stack traces", () => {
    const errorRes = classifyQuery("TypeError: turndownService.remove is not a function")
    expect(errorRes.category).toBe("error_debug")
    expect(errorRes.engines).toContain("stackoverflow")
    expect(errorRes.engines).toContain("github")
  })

  it("classifies technical documentation queries", () => {
    const techRes = classifyQuery("Effect-TS Schema decodeUnknownEffect signature")
    expect(techRes.category).toBe("technical_docs")
    expect(techRes.engines).toContain("github")
  })

  it("classifies general research queries", () => {
    const genRes = classifyQuery("History of asynchronous programming models")
    expect(genRes.category).toBe("general")
    expect(genRes.engines).toContain("wikipedia")
  })
})
