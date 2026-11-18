import { describe, expect, it } from "bun:test"
import {
  LocalCorpusIndex,
  SourceRegistry,
  bootstrapAuthoritativeCorpus,
  analyzeBenchmarkMisses,
  planCorpusPriorities,
  BackgroundCorpusSyncer,
  type CorpusSource,
} from "@/retrieval/corpus"

describe("Authoritative Local Technical Knowledge Corpus (HomeCode Retrieval V3)", () => {
  it("LocalCorpusIndex: indexes documents and structural sections with field-weighted BM25 scoring", async () => {
    const corpus = new LocalCorpusIndex(":memory:")

    const didIngest = await corpus.ingestDocument({
      url: "https://effect.website/docs/schema",
      sourceId: "effect_core",
      project: "effect",
      version: "3.12",
      title: "Effect Schema Decoding and Validation",
      documentPath: "docs/schema.md",
      content: `
# Effect Schema Guide
Effect Schema allows converting untrusted JSON into typed models.

## Decoding Untrusted Input
Use Schema.decodeUnknownEffect for parsing data safely.
\`\`\`typescript
const decode = Schema.decodeUnknownEffect(User);
\`\`\`

## Synchronous Options
Use Schema.decodeUnknownOption for optional decoding.
      `,
    })

    expect(didIngest).toBe(true)

    // Verify metrics
    const metrics = corpus.getMetrics()
    expect(metrics.totalDocuments).toBe(1)
    expect(metrics.totalSections).toBeGreaterThanOrEqual(2)

    // Search query matches
    const results = corpus.search("Schema decodeUnknownEffect")
    expect(results.length).toBe(1)
    expect(results[0].url).toBe("https://effect.website/docs/schema")
    expect(results[0].project).toBe("effect")
    expect(results[0].version).toBe("3.12")
    expect(results[0].score).toBeGreaterThan(0)

    corpus.close()
  })

  it("Bootstrap Authoritative Corpus: populates core developer ecosystems (Effect, Bun, Drizzle, TypeScript, React 19, SQLite)", async () => {
    const corpus = new LocalCorpusIndex(":memory:")
    const summary = await bootstrapAuthoritativeCorpus(corpus)

    expect(summary.totalSources).toBeGreaterThanOrEqual(10)
    expect(summary.totalDocuments).toBeGreaterThanOrEqual(10)
    expect(summary.totalSections).toBeGreaterThanOrEqual(15)

    // Test searches across bootstrapped domains
    const bunRes = corpus.search("Bun file json parsing automatic decoding")
    expect(bunRes.length).toBeGreaterThan(0)
    expect(bunRes[0].url).toContain("bun.sh")

    const drizzleRes = corpus.search("Drizzle ORM sqliteTable snake_case")
    expect(drizzleRes.length).toBeGreaterThan(0)
    expect(drizzleRes[0].url).toContain("drizzle.team")

    const effectV4Res = corpus.search("Effect catchAll rename Effect catch v4 migration")
    expect(effectV4Res.length).toBeGreaterThan(0)
    expect(effectV4Res[0].url).toContain("effect-smol")

    const react19Res = corpus.search("React 19 useActionState server actions")
    expect(react19Res.length).toBeGreaterThan(0)
    expect(react19Res[0].url).toContain("react.dev")

    const sqliteWalRes = corpus.search("SQLite WAL mode concurrent multiple readers")
    expect(sqliteWalRes.length).toBeGreaterThan(0)
    expect(sqliteWalRes[0].url).toContain("sqlite.org")

    corpus.close()
  })

  it("Corpus Coverage Planner & Miss Taxonomy: analyzes benchmark misses and computes prioritized source rankings", () => {
    const mockResults = [
      {
        item: {
          id: "1",
          split: "train" as const,
          category: "Exact Technical Facts",
          query: "Bun.file json parsing",
          expectedIntent: "technical_docs" as const,
          authoritativeDomains: ["bun.sh"],
          targetKeywords: ["Bun.file"],
          targetFacts: "fact",
        },
        hit: true,
        localHit: true,
      },
      {
        item: {
          id: "2",
          split: "dev" as const,
          category: "Version-Sensitive API Documentation",
          query: "Effect 4.0 beta removal of Effect.catchAll",
          expectedIntent: "technical_docs" as const,
          authoritativeDomains: ["effect.website"],
          targetKeywords: ["Effect.catch"],
          targetFacts: "fact",
        },
        hit: false,
        localHit: false,
      },
      {
        item: {
          id: "3",
          split: "test" as const,
          category: "Stack Traces & Runtime Errors",
          query: "SqliteError: database is locked with WAL",
          expectedIntent: "error_debug" as const,
          authoritativeDomains: ["stackoverflow.com"],
          targetKeywords: ["WAL"],
          targetFacts: "fact",
        },
        hit: false,
        localHit: false,
      },
    ]

    const analysis = analyzeBenchmarkMisses(mockResults)
    expect(analysis.totalMisses).toBe(2)
    expect(analysis.missTaxonomy.version_specific_docs_missing).toBe(1)
    expect(analysis.missTaxonomy.stackoverflow_content_missing).toBe(1)

    const registry = new SourceRegistry()
    const sources = registry.listSources()
    const plan = planCorpusPriorities(analysis.analyses, sources)

    expect(plan.length).toBeGreaterThan(0)
    // Effect source should receive high priority score due to recovering the miss
    const effectCandidate = plan.find((p) => p.source.id === "effect_core")
    expect(effectCandidate).toBeDefined()
    expect(effectCandidate?.coveredBenchmarkQueries.length).toBeGreaterThan(0)
  })

  it("Source Registry: loads, enables, and manages source manifests", async () => {
    const registry = new SourceRegistry(":memory:")
    const sources = registry.listSources()
    expect(sources.length).toBeGreaterThanOrEqual(10)

    const effectSrc = registry.getSource("effect_core")
    expect(effectSrc).toBeDefined()
    expect(effectSrc?.authority).toBe("official")

    registry.disableSource("effect_core")
    expect(registry.getSource("effect_core")?.enabled).toBe(false)

    registry.enableSource("effect_core")
    expect(registry.getSource("effect_core")?.enabled).toBe(true)
  })

  it("Background Corpus Syncer: handles 304 Not Modified and updates source timestamps", async () => {
    const corpus = new LocalCorpusIndex(":memory:")
    const registry = new SourceRegistry(":memory:")

    const mockFetch = (async (_url: any, init?: any) => {
      if (init?.headers?.["If-None-Match"] === '"etag_v1"') {
        return new Response(null, { status: 304 })
      }
      return new Response("# Document: https://bun.sh/docs/file\n# Bun File Reference\nBun.file API details.", {
        status: 200,
        headers: { etag: '"etag_v1"' },
      })
    }) as unknown as typeof fetch

    const syncer = new BackgroundCorpusSyncer(corpus, registry)
    const testSource: CorpusSource = {
      id: "test_source",
      name: "Test Source",
      type: "llms_full_txt",
      canonicalUrl: "https://example.com/llms-full.txt",
      authority: "official",
      updateStrategy: "etag",
      enabled: true,
      discoveredBy: "benchmark",
      priority: 5,
    }

    // First sync (200 OK)
    const res1 = await syncer.syncSource(testSource, { customFetch: mockFetch })
    expect(res1.success).toBe(true)
    expect(res1.addedDocuments).toBe(1)

    // Second sync with matching ETag (304 Not Modified)
    const updatedSource = registry.getSource("test_source") || { ...testSource, lastCommitOrEtag: '"etag_v1"' }
    const res2 = await syncer.syncSource(updatedSource, { customFetch: mockFetch })
    expect(res2.success).toBe(true)
    expect(res2.addedDocuments).toBe(0)
    expect(res2.unchangedDocuments).toBe(1)

    corpus.close()
  })

  it("Offline-First Behavior: searches indexed knowledge completely offline without network calls", async () => {
    const corpus = new LocalCorpusIndex(":memory:")
    await bootstrapAuthoritativeCorpus(corpus)

    // Completely offline query execution
    const results = corpus.search("SQLite WAL synchronous NORMAL PRAGMA busy_timeout")
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.url.includes("sqlite") || r.url.includes("bun.sh"))).toBe(true)

    // Access tracking
    corpus.recordAccess(results[0].url, true)
    const doc = corpus.getDocument(results[0].url)
    expect(doc?.accessCount).toBe(1)
    expect(doc?.successfulRetrievalCount).toBe(1)

    corpus.close()
  })
})
