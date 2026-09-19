import { Effect, Schema, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import DESCRIPTION from "./websearch.txt"
import { InstallationVersion } from "@homecode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { encode } from "@toon-format/toon"
import { classifyQuery } from "../retrieval/classifier"
import { Reranker } from "../retrieval/reranker"
import { RetrievalCache } from "../retrieval/cache"
import { extractFromHtml } from "../retrieval/extractor"
import { extractHighlights } from "../retrieval/highlighter"
import { validateSafeUrl } from "../retrieval/ssrf"
import { executeSafeRequest } from "../retrieval/http"

const ResultCount = Schema.Number.check(Schema.isInt()).check(Schema.isBetween({ minimum: 1, maximum: 100 }))
const ContextCharacters = Schema.Number.check(Schema.isInt()).check(Schema.isBetween({ minimum: 1, maximum: 100_000 }))

export const Parameters = Schema.Struct({
  query: Schema.String.check(Schema.isNonEmpty()).annotate({
    description: "Websearch query",
  }),

  numResults: Schema.optional(ResultCount).annotate({
    description: "Number of search results to return (default: 8)",
  }),

  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),

  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),

  contextMaxCharacters: Schema.optional(ContextCharacters).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

const WebSearchProviderSchema = Schema.Literals(["exa", "parallel", "searxng"])

export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8899"

export function selectWebSearchProvider(
  sessionID: string,
  flags = {
    exa: false,
    parallel: false,
  },
): WebSearchProvider {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER

  if (override === "exa" || override === "parallel" || override === "searxng") {
    return override
  }

  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"

  return "searxng"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"

  if (provider === "exa") return "Exa Web Search"

  if (provider === "searxng") return "SearXNG Web Search"

  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model

  if (!model || typeof model !== "object") return undefined

  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined

  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined

  const id = "id" in model && typeof model.id === "string" ? model.id : undefined

  return (apiID ?? id)?.slice(0, 100)
}

function parallelAuthHeaders() {
  const headers = {
    "User-Agent": `homecode/${InstallationVersion}`,
  }

  if (!process.env.PARALLEL_API_KEY) return headers

  return {
    ...headers,
    Authorization: `Bearer ${process.env.PARALLEL_API_KEY}`,
  }
}

function extractDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.replace(/^www\./, "")
  } catch {
    return "unknown"
  }
}

function fetchPagePassages(
  http: HttpClient.HttpClient,
  url: string,
  query: string,
  cache: RetrievalCache.Interface,
  preferLive = false,
) {
  return Effect.gen(function* () {
    const safeUrl = yield* validateSafeUrl(url).pipe(Effect.orElseSucceed(() => null))
    if (!safeUrl) return []

    if (!preferLive) {
      const cached = yield* cache.getDocument(safeUrl.href)
      if (cached) return extractHighlights(query, cached.content, { maxHighlights: 3, maxCharacters: 2000 })
    }
    const request = HttpClientRequest.get(safeUrl.href).pipe(
      HttpClientRequest.setHeaders({
        "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (homecode/${InstallationVersion})`,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      }),
    )

    const fetched = yield* executeSafeRequest(http, request).pipe(
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed(() => null),
    )

    if (!fetched || fetched.response.status < 200 || fetched.response.status >= 300) return []

    const html = yield* fetched.response.text.pipe(Effect.orElseSucceed(() => ""))

    if (!html) return []

    const extracted = extractFromHtml(html, { format: "markdown", url: fetched.url })
    if (!extracted.content) return []

    yield* cache.setDocument({
      url: fetched.url,
      title: extracted.title,
      content: extracted.content,
      status: fetched.response.status,
    })

    return extractHighlights(query, extracted.content, { maxHighlights: 3, maxCharacters: 2000 })
  })
}

import {
  createFederatedDiscoveryService,
  createLocalCorpusProvider,
  createGitHubProvider,
  createStackExchangeProvider,
  createSearXNGProvider,
} from "../retrieval/discovery"

function makeFetchFromHttpClient(http: HttpClient.HttpClient): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = HttpClientRequest.fromWeb(new Request(input, init))
    const fetched = await Effect.runPromise(executeSafeRequest(http, req))
    const text = await Effect.runPromise(fetched.response.text)
    return new Response(text, {
      status: fetched.response.status,
      headers: new Headers(fetched.response.headers),
    })
  }) as unknown as typeof fetch
}

function callFederatedSearch(
  http: HttpClient.HttpClient,
  reranker: Reranker.Interface,
  cache: RetrievalCache.Interface,
  params: Schema.Schema.Type<typeof Parameters>,
) {
  return Effect.gen(function* () {
    const query = params.query.trim()
    if (!query) return encode({ status: "invalid_query", message: "Search query cannot be empty." })

    const classification = classifyQuery(query)
    const numResults = params.numResults ?? 8
    const searchType = params.type ?? "auto"

    const cacheKey = `search:v2:${query}:${searchType}:${numResults}:${params.livecrawl ?? "fallback"}:${params.contextMaxCharacters ?? 10000}`
    const cachedQuery = yield* cache.getQuery(cacheKey)
    if (cachedQuery && typeof cachedQuery === "string") {
      return cachedQuery
    }

    const fetchFn = makeFetchFromHttpClient(http)
    const federated = createFederatedDiscoveryService([
      createLocalCorpusProvider(),
      createGitHubProvider(fetchFn),
      createStackExchangeProvider(fetchFn),
      createSearXNGProvider(SEARXNG_URL, fetchFn),
    ])

    const discoveryResult = yield* federated.search(query, {
      limit: numResults * 2,
      classification,
    })

    const fusedCandidates = discoveryResult.candidates
    if (fusedCandidates.length === 0) {
      return encode({ status: "no_results", message: "No search results found across discovery providers." })
    }

    const candidates = fusedCandidates.map((c) => ({
      id: c.url,
      title: c.title || "Untitled",
      url: c.url,
      domain: extractDomain(c.url),
      summary: c.snippet || "",
      sourceTypes: c.sourceTypes,
      matchedProviders: c.matchedProviders,
      fusionScore: c.fusionScore,
      publishedDate: (c.metadata?.publishedDate as string | undefined) || undefined,
    }))

    // 2. CPU Reranking of candidates
    const docsToRerank = candidates.map((c) => ({
      id: c.id,
      text: `${c.title}. ${c.summary}`,
    }))

    const rankedOutputs = yield* reranker.rerank({
      query,
      documents: docsToRerank,
      topK: numResults,
    })

    const candidateMap = new Map(candidates.map((c) => [c.id, c]))
    const topCandidates = rankedOutputs.flatMap((r) => {
      const candidate = candidateMap.get(r.id)
      return candidate ? [{ candidate, score: r.score }] : []
    })

    // 3. Selective Fetch for top candidates (unless in fast mode)
    const shouldFetch = searchType !== "fast"
    const fetchLimit = searchType === "deep" ? Math.min(topCandidates.length, 5) : Math.min(topCandidates.length, 3)

    const enrichedResults = yield* Effect.forEach(
      topCandidates,
      (item, index) =>
        Effect.gen(function* () {
          const candidate = item.candidate
          const score = item.score
          let highlights: string[] = []

          if (shouldFetch && index < fetchLimit) {
            highlights = yield* fetchPagePassages(http, candidate.url, query, cache, params.livecrawl === "preferred")
          }

          if (highlights.length === 0 && candidate.summary) {
            highlights = [candidate.summary]
          }

          return {
            title: candidate.title,
            url: candidate.url,
            domain: candidate.domain,
            score,
            publishedDate: candidate.publishedDate,
            sourceTypes: candidate.sourceTypes,
            matchedProviders: candidate.matchedProviders,
            highlights,
          }
        }),
      { concurrency: 4 },
    )

    const payload = {
      query,
      category: classification.category,
      results: enrichedResults,
      context: enrichedResults
        .flatMap((result) => result.highlights)
        .join("\n\n")
        .slice(0, params.contextMaxCharacters ?? 10000),
    }

    const output = encode(payload)
    yield* cache.setQuery(cacheKey, output, 3600)

    return output
  })
}

function callProvider(
  http: HttpClient.HttpClient,
  reranker: Reranker.Interface,
  cache: RetrievalCache.Interface,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "searxng") {
    return callFederatedSearch(http, reranker, cache, params)
  }

  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query.trim(),
        search_queries: [params.query.trim()],
        session_id: ctx.sessionID,
        model_name: webSearchModelName(ctx.extra),
      },
      "25 seconds",
      parallelAuthHeaders(),
    )
  }

  return McpWebSearch.call(
    http,
    McpWebSearch.EXA_URL,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query.trim(),
      numResults: params.numResults ?? 8,
    },
    "25 seconds",
    McpWebSearch.exaAuthHeaders(),
  )
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    const reranker = yield* Reranker.Service
    const cache = yield* RetrievalCache.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },

      parameters: Parameters,

      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const provider = selectWebSearchProvider(ctx.sessionID, {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
          })

          const title = webSearchProviderLabel(provider)

          yield* ctx.metadata({
            title: `${title} "${params.query}"`,
            metadata: { provider },
          })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider,
            },
          })

          const result = yield* callProvider(http, reranker, cache, provider, params, ctx)

          const fallbackOutput = encode({ status: "no_results", message: "No search results found." })

          return {
            output: result ?? fallbackOutput,
            title: `${title}: ${params.query}`,
            metadata: { provider },
          }
        }).pipe(Effect.orDie),
    }
  }).pipe(Effect.provide(Layer.mergeAll(Reranker.defaultLayer, RetrievalCache.defaultLayer))),
)

export * as WebSearch from "./websearch"
