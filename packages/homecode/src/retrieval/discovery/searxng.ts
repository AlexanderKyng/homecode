import { Effect } from "effect"
import { type DiscoveryCandidate, type DiscoveryOptions, type DiscoveryProvider } from "./types"
import { type QueryClassification } from "../classifier"

const DEFAULT_SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8899"

interface SearXNGItem {
  readonly title?: string
  readonly url?: string
  readonly content?: string
  readonly snippet?: string
  readonly publishedDate?: string
  readonly engine?: string
}

interface SearXNGResponse {
  readonly results?: readonly SearXNGItem[]
  readonly unresponsive_engines?: readonly (readonly [string, string])[]
}

export function createSearXNGProvider(
  baseUrl = DEFAULT_SEARXNG_URL,
  customFetch?: typeof fetch,
): DiscoveryProvider {
  const fetchFn = customFetch ?? fetch

  return {
    id: "searxng",
    name: "SearXNG Meta-Search",
    supports: () => true, // General web fallback supports all queries
    search: (query: string, options: DiscoveryOptions) =>
      Effect.tryPromise({
        try: async () => {
          const timeout = options.timeoutMs ?? 4000
          const classification = options.classification

          const params = new URLSearchParams({
            q: classification ? classification.formattedQuery : query,
            format: "json",
            pageno: "1",
          })

          if (classification && classification.categories && classification.categories.length > 0) {
            params.set("categories", classification.categories.join(","))
          }

          const url = `${baseUrl}/search?${params.toString()}`
          const res = await fetchFn(url, {
            headers: {
              Accept: "application/json",
              "User-Agent": "HomeCode-Retrieval-Agent/2.0",
            },
            signal: AbortSignal.timeout(timeout),
          })

          if (!res.ok) {
            return []
          }

          const data = (await res.json()) as SearXNGResponse
          const items = data.results ?? []
          const candidates: DiscoveryCandidate[] = []

          for (let i = 0; i < items.length; i++) {
            const item = items[i]
            if (!item.url) continue

            candidates.push({
              url: item.url,
              title: item.title?.trim() || "Untitled",
              snippet: (item.snippet || item.content || "").replace(/\s+/g, " ").trim(),
              provider: "searxng",
              providerRank: i + 1,
              sourceType: "web",
              publishedDate: item.publishedDate,
              metadata: {
                engine: item.engine,
              },
            })
          }

          return candidates
        },
        catch: (err) => new Error(`SearXNG discovery failed: ${String(err)}`),
      }),
  }
}

export * as SearXNGDiscovery from "./searxng"
