import { Effect, Schema, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import DESCRIPTION from "./codesearch.txt"
import { encode } from "@toon-format/toon"
import { InstallationVersion } from "@homecode-ai/core/installation/version"
import { Reranker } from "../retrieval/reranker"
import { RetrievalCache } from "../retrieval/cache"
import { extractFromHtml } from "../retrieval/extractor"
import { extractHighlights } from "../retrieval/highlighter"
import { validateSafeUrl } from "../retrieval/ssrf"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Code or technical query",
  }),
  category: Schema.optional(Schema.String).annotate({
    description: "Search category: qa, repos, or all (default: all)",
  }),
  maxResults: Schema.optional(Schema.Number).annotate({
    description: "Maximum results to return (default: 5)",
  }),
})

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8899"

function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const trackingParams = ["utm_source", "utm_medium", "utm_campaign", "ref", "fbclid", "gclid"]
    for (const p of trackingParams) {
      url.searchParams.delete(p)
    }
    url.hash = ""
    return url.toString()
  } catch {
    return rawUrl
  }
}

function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "")
  } catch {
    return rawUrl
  }
}

function fetchCodePassages(
  http: HttpClient.HttpClient,
  url: string,
  query: string,
  cache: RetrievalCache.Interface,
) {
  return Effect.gen(function* () {
    const safeUrl = yield* validateSafeUrl(url).pipe(
      Effect.orElseSucceed(() => null),
    )
    if (!safeUrl) return []

    const cached = yield* cache.getDocument(safeUrl.href)
    if (cached) {
      return extractHighlights(query, cached.content, { maxHighlights: 3, maxCharacters: 2500 })
    }

    const request = HttpClientRequest.get(safeUrl.href).pipe(
      HttpClientRequest.setHeaders({
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (homecode/${InstallationVersion})`,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      }),
    )

    const response = yield* http.execute(request).pipe(
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed(() => null),
    )

    if (!response || response.status >= 400) return []

    const html = yield* response.text.pipe(
      Effect.orElseSucceed(() => ""),
    )

    if (!html) return []

    const extracted = extractFromHtml(html, { format: "markdown", url: safeUrl.href })
    if (!extracted.content) return []

    yield* cache.setDocument({
      url: safeUrl.href,
      title: extracted.title,
      content: extracted.content,
      status: response.status,
    })

    return extractHighlights(query, extracted.content, { maxHighlights: 3, maxCharacters: 2500 })
  })
}

import {
  createFederatedDiscoveryService,
  createLocalCorpusProvider,
  createGitHubProvider,
  createStackExchangeProvider,
  createSearXNGProvider,
  type FusedCandidate,
} from "../retrieval/discovery"
import { classifyQuery } from "../retrieval/classifier"

function makeFetchFromHttpClient(http: HttpClient.HttpClient): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url
    const method = init?.method || "GET"
    const req = HttpClientRequest.make(method)(url)
    const res = await Effect.runPromise(http.execute(req))
    const text = await Effect.runPromise(res.text)
    return new Response(text, {
      status: res.status,
      headers: res.headers as any,
    })
  }) as unknown as typeof fetch
}

export const CodeSearchTool = Tool.define(
  "codesearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const reranker = yield* Reranker.Service
    const cache = yield* RetrievalCache.Service

    return {
      get description() {
        return DESCRIPTION
      },

      parameters: Parameters,

      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const category = params.category || "all"
          const maxResults = params.maxResults || 5

          yield* ctx.metadata({
            title: `Code Search "${params.query}" (${category})`,
            metadata: { category },
          })

          yield* ctx.ask({
            permission: "codesearch",
            patterns: [params.query],
            always: ["*"],
            metadata: { query: params.query, category, maxResults },
          })

          const cacheKey = `codesearch:${params.query}:${category}:${maxResults}`
          const cachedOutput = yield* cache.getQuery(cacheKey)
          if (cachedOutput && typeof cachedOutput === "string") {
            return {
              output: cachedOutput,
              title: `Code Search: ${params.query}`,
              metadata: { category, cached: true },
            }
          }

          const fetchFn = makeFetchFromHttpClient(http)
          const federated = createFederatedDiscoveryService([
            createLocalCorpusProvider(),
            createGitHubProvider(fetchFn),
            createStackExchangeProvider(fetchFn),
            createSearXNGProvider(SEARXNG_URL, fetchFn),
          ])

          const classification = classifyQuery(params.query)
          const discoveryResult = yield* federated.search(params.query, {
            limit: maxResults * 2,
            classification,
          })

          const rawResults = discoveryResult.candidates
          if (rawResults.length === 0) {
            const emptyOutput = encode({
              status: "no_results",
              message: "No code search results found across discovery providers.",
            })
            return {
              output: emptyOutput,
              title: `Code Search: ${params.query}`,
              metadata: { category, cached: false },
            }
          }

          // 1. Deduplication and candidate formatting
          const seenUrls = new Set<string>()
          const candidates: Array<{
            id: string
            title: string
            url: string
            domain: string
            summary: string
            sourceTypes: readonly string[]
            matchedProviders: readonly string[]
          }> = []

          for (const item of rawResults) {
            if (!item.url) continue
            const normalized = normalizeUrl(item.url)
            if (seenUrls.has(normalized)) continue
            seenUrls.add(normalized)

            candidates.push({
              id: normalized,
              title: item.title?.trim() || "Untitled",
              url: normalized,
              domain: extractDomain(normalized),
              summary: item.snippet || "",
              sourceTypes: item.sourceTypes,
              matchedProviders: item.matchedProviders,
            })
          }

          // 2. CPU Reranking
          const docsToRerank = candidates.map((c) => ({
            id: c.id,
            text: `${c.title}. ${c.summary}`,
          }))

          const rankedOutputs = yield* reranker.rerank({
            query: params.query,
            documents: docsToRerank,
            topK: maxResults,
          })

          const candidateMap = new Map(candidates.map((c) => [c.id, c]))
          const topCandidates = rankedOutputs.map((r) => ({
            candidate: candidateMap.get(r.id)!,
            score: r.score,
          }))

          // Fetch code passages for top results
          const enrichedResults = yield* Effect.forEach(
            topCandidates,
            (item, index) =>
              Effect.gen(function* () {
                const candidate = item.candidate
                const score = item.score
                let highlights: string[] = []
                if (index < 3) {
                  highlights = yield* fetchCodePassages(http, candidate.url, params.query, cache)
                }

                return {
                  title: candidate.title,
                  url: candidate.url,
                  source: candidate.domain || "code",
                  score,
                  highlights: highlights.length > 0 ? highlights : [candidate.summary],
                }
              }),
            { concurrency: 3 },
          )

          const payload = {
            query_executed: params.query,
            engine_category: category,
            results_count: enrichedResults.length,
            results: enrichedResults,
          }

          const output = encode(payload)
          yield* cache.setQuery(cacheKey, output, 3600)

          return {
            output,
            title: `Code Search: ${params.query}`,
            metadata: { category, cached: false },
          }
        }).pipe(Effect.orDie),
    }
  }).pipe(Effect.provide(Layer.mergeAll(Reranker.defaultLayer, RetrievalCache.defaultLayer))),
)

export * as CodeSearch from "./codesearch"
