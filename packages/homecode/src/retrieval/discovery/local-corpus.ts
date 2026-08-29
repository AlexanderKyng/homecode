import { Effect } from "effect"
import { type DiscoveryCandidate, type DiscoveryOptions, type DiscoveryProvider } from "./types"
import { LocalCorpusIndex } from "../corpus/index"

export { LocalCorpusIndex }

export function createLocalCorpusProvider(index?: LocalCorpusIndex): DiscoveryProvider {
  const corpus = index ?? new LocalCorpusIndex()

  return {
    id: "local_corpus",
    name: "Local Technical Corpus (FTS5)",
    supports: () => true, // Local corpus is checked on all technical and general queries
    search: (query: string, options: DiscoveryOptions) =>
      Effect.tryPromise({
        try: async () => {
          const limit = options.limit ?? 10
          const results = corpus.search(query, { limit })

          return results.map((r, i) => ({
            url: r.url,
            title: r.title,
            snippet: r.snippet,
            provider: "local_corpus",
            providerRank: i + 1,
            providerScore: r.score,
            sourceType: "local_corpus" as const,
            metadata: {
              project: r.project,
              version: r.version,
              authority: r.authority,
              bm25Rank: r.bm25Rank,
            },
          }))
        },
        catch: (err) => new Error(`Local corpus search failed: ${String(err)}`),
      }),
  }
}

export * as LocalCorpus from "./local-corpus"
