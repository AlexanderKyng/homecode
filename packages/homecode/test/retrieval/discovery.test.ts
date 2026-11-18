import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  createGitHubProvider,
  createStackExchangeProvider,
  createSearXNGProvider,
  createLocalCorpusProvider,
  LocalCorpusIndex,
  fuseCandidates,
  createFederatedDiscoveryService,
  type DiscoveryCandidate,
} from "@/retrieval/discovery"

describe("Federated Technical Discovery Layer (HomeCode Retrieval V2)", () => {
  it("GitHub Provider: searches issues, code, and repositories with rich metadata", async () => {
    const mockFetch = (async (input: any) => {
      const urlStr = String(input)
      if (urlStr.includes("/search/issues")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 101,
                number: 42,
                title: "Fix SQLite concurrency lock under WAL mode",
                html_url: "https://github.com/oven-sh/bun/issues/42",
                body: "When multiple readers connect in WAL mode, database is locked errors occur.",
                state: "open",
                comments: 5,
                created_at: "2026-08-15T12:00:00Z",
                user: { login: "dev_user" },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 201,
              full_name: "Effect-TS/effect",
              html_url: "https://github.com/Effect-TS/effect",
              description: "A fully-fledged functional effect system for TypeScript",
              stargazers_count: 9800,
              language: "TypeScript",
              updated_at: "2026-08-18T10:00:00Z",
            },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const provider = createGitHubProvider(mockFetch)

    // 1. Issue query
    const issueCandidates = await Effect.runPromise(
      provider.search("SQLite WAL mode lock error issue", {}),
    )
    expect(issueCandidates.length).toBe(1)
    expect(issueCandidates[0].sourceType).toBe("github_issue")
    expect(issueCandidates[0].url).toBe("https://github.com/oven-sh/bun/issues/42")
    expect(issueCandidates[0].title).toContain("#42")
    expect(issueCandidates[0].metadata?.state).toBe("open")

    // 2. Repository query
    const repoCandidates = await Effect.runPromise(
      provider.search("Effect-TS functional TypeScript", {}),
    )
    expect(repoCandidates.length).toBe(1)
    expect(repoCandidates[0].sourceType).toBe("github_repository")
    expect(repoCandidates[0].url).toBe("https://github.com/Effect-TS/effect")
    expect(repoCandidates[0].metadata?.stars).toBe(9800)
  })

  it("Stack Exchange Provider: queries technical Q&A, decodes entities, and preserves score/accepted status", async () => {
    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          items: [
            {
              question_id: 54321,
              title: "How to set &quot;PRAGMA busy_timeout&quot; in SQLite with WAL mode?",
              link: "https://stackoverflow.com/questions/54321/sqlite-busy-timeout",
              score: 48,
              is_answered: true,
              accepted_answer_id: 54325,
              answer_count: 3,
              tags: ["sqlite", "wal", "node.js"],
              creation_date: 1723500000,
            },
          ],
          quota_remaining: 295,
          quota_max: 300,
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const provider = createStackExchangeProvider(mockFetch)
    const candidates = await Effect.runPromise(
      provider.search("sqlite busy timeout wal mode", {}),
    )

    expect(candidates.length).toBe(1)
    expect(candidates[0].sourceType).toBe("stackoverflow")
    expect(candidates[0].title).toBe('How to set "PRAGMA busy_timeout" in SQLite with WAL mode?')
    expect(candidates[0].metadata?.score).toBe(48)
    expect(candidates[0].metadata?.hasAcceptedAnswer).toBe(true)
    expect(candidates[0].metadata?.tags).toContain("sqlite")
  })

  it("Local Technical Corpus (FTS5): stores documents, skips duplicate hashes, and performs sub-millisecond BM25 search", async () => {
    const corpus = new LocalCorpusIndex(":memory:")

    const didInsert1 = await corpus.ingestDocument({
      url: "https://effect.website/docs/schema",
      sourceId: "effect-docs",
      project: "effect",
      title: "Effect Schema Validation Guide",
      content: `
        # Schema Decoding and Encoding
        Effect Schema allows transforming untrusted JSON input safely.
        \`\`\`typescript
        const decode = Schema.decodeUnknownEffect(User);
        \`\`\`
      `,
    })
    expect(didInsert1).toBe(true)

    // Re-inserting identical document returns false (skipped)
    const didInsertDuplicate = await corpus.ingestDocument({
      url: "https://effect.website/docs/schema",
      sourceId: "effect-docs",
      project: "effect",
      title: "Effect Schema Validation Guide",
      content: `
        # Schema Decoding and Encoding
        Effect Schema allows transforming untrusted JSON input safely.
        \`\`\`typescript
        const decode = Schema.decodeUnknownEffect(User);
        \`\`\`
      `,
    })
    expect(didInsertDuplicate).toBe(false)

    // Progressive accumulation
    await corpus.accumulateDocument(
      "https://bun.sh/docs/api/file",
      "Bun File API Documentation",
      `
        # Bun.file Fast I/O
        Bun.file reads files directly with Blob compatibility.
        \`\`\`typescript
        const file = Bun.file("data.json");
        const json = await file.json();
        \`\`\`
      `,
    )

    // Search query
    const results = corpus.search("Schema decodeUnknownEffect")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].url).toBe("https://effect.website/docs/schema")
    expect(results[0].project).toBe("effect")

    const bunResults = corpus.search("Bun file json")
    expect(bunResults.length).toBeGreaterThan(0)
    expect(bunResults[0].url).toBe("https://bun.sh/docs/api/file")

    corpus.close()
  })

  it("Cross-Provider Candidate Fusion: canonicalizes URLs and grants consensus bonuses to multi-provider matches", () => {
    const provider1Results: DiscoveryCandidate[] = [
      {
        url: "https://github.com/Effect-TS/effect?utm_source=docs",
        title: "Effect-TS Core Repository",
        snippet: "Core effect system",
        provider: "github",
        providerRank: 1,
        sourceType: "github_repository",
      },
      {
        url: "https://github.com/oven-sh/bun",
        title: "Bun Runtime",
        provider: "github",
        providerRank: 2,
        sourceType: "github_repository",
      },
    ]

    const provider2Results: DiscoveryCandidate[] = [
      {
        url: "https://github.com/Effect-TS/effect/",
        title: "Effect-TS / effect on GitHub",
        snippet: "Functional effect system",
        provider: "searxng",
        providerRank: 1,
        sourceType: "web",
      },
      {
        url: "https://stackoverflow.com/questions/12345",
        title: "How to use Effect",
        provider: "searxng",
        providerRank: 2,
        sourceType: "web",
      },
    ]

    const provider3Results: DiscoveryCandidate[] = [
      {
        url: "https://github.com/Effect-TS/effect",
        title: "Effect-TS Local Corpus",
        provider: "local_corpus",
        providerRank: 1,
        sourceType: "local_corpus",
      },
    ]

    const fused = fuseCandidates([provider1Results, provider2Results, provider3Results])

    // Should collapse 3 entries for Effect-TS into 1 fused entry
    expect(fused.length).toBe(3)

    const effectEntry = fused.find((f) => f.url === "https://github.com/Effect-TS/effect")
    expect(effectEntry).toBeDefined()
    expect(effectEntry?.matchedProviders).toContain("github")
    expect(effectEntry?.matchedProviders).toContain("searxng")
    expect(effectEntry?.matchedProviders).toContain("local_corpus")
    expect(effectEntry?.matchedProviders.length).toBe(3)

    // Multi-provider consensus bonus should place Effect-TS clearly in rank 1
    expect(fused[0].url).toBe("https://github.com/Effect-TS/effect")
    expect(fused[0].fusionScore).toBeGreaterThan(fused[1].fusionScore * 1.5)
  })

  it("Federated Discovery Orchestrator: executes concurrent providers and handles failures gracefully", async () => {
    const corpus = new LocalCorpusIndex(":memory:")
    await corpus.ingestDocument({
      url: "https://orm.drizzle.team/docs/sqlite",
      sourceId: "drizzle-docs",
      project: "drizzle",
      title: "Drizzle ORM SQLite Documentation",
      content: "Drizzle sqliteTable definitions and schema migrations.",
    })

    const mockGitHub = createGitHubProvider((async () => {
      throw new Error("GitHub rate limit exceeded 403")
    }) as unknown as typeof fetch)

    const mockSearxng = createSearXNGProvider("http://localhost:8899", (async () => {
      return new Response(
        JSON.stringify({
          results: [
            {
              url: "https://orm.drizzle.team/docs/sqlite",
              title: "Drizzle SQLite Docs",
              content: "Drizzle ORM SQLite guide",
              engine: "duckduckgo",
            },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch)

    const federated = createFederatedDiscoveryService(
      [createLocalCorpusProvider(corpus), mockGitHub, mockSearxng],
      corpus,
    )

    const result = await Effect.runPromise(
      federated.search("Drizzle ORM sqliteTable"),
    )

    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates[0].url).toBe("https://orm.drizzle.team/docs/sqlite")
    expect(result.telemetry.some((t) => t.provider === "github" && !t.success)).toBe(true)
    expect(result.telemetry.some((t) => t.provider === "local_corpus" && t.success)).toBe(true)

    corpus.close()
  })
})
