import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@openqcode-ai/core/util/encode"
import { InstallationVersion } from "@openqcode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { encode } from "@toon-format/toon" // Ajout de l'import TOON

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Websearch query",
  }),

  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),

  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),

  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),

  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
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
    "User-Agent": `openqcode/${InstallationVersion}`,
  }

  if (!process.env.PARALLEL_API_KEY) return headers

  return {
    ...headers,
    Authorization: `Bearer ${process.env.PARALLEL_API_KEY}`,
  }
}

function callSearXNG(http: HttpClient.HttpClient, params: Schema.Schema.Type<typeof Parameters>) {
  return Effect.gen(function* () {
    const request = HttpClientRequest.get(`${SEARXNG_URL}/search`).pipe(
      HttpClientRequest.setUrlParams({
        q: params.query,
        format: "json",
      }),
    )

    const response = yield* http.execute(request)

    const json = (yield* response.json) as {
      results?: Array<{
        title?: string
        url?: string
        content?: string
      }>
    }

    const results = (json.results ?? []).slice(0, params.numResults || 8)

    if (results.length === 0) {
      return encode({ status: "no_results", message: "No search results found." })
    }

    // Reconstruction propre des résultats sous forme d'objets pour TOON
    const cleanedResults = results.map((result) => ({
      title: result.title?.trim() || "Untitled",
      url: result.url ?? "",
      summary: (result.content ?? "").replace(/\s+/g, " ").trim(),
    }))

    // Retour encodé en TOON pour économiser les tokens du Qwen local
    return encode({
      query: params.query,
      results: cleanedResults,
    })
  })
}

function callProvider(
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "searxng") {
    return callSearXNG(http, params)
  }

  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query,
        search_queries: [params.query],
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
      query: params.query,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service

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

          const result = yield* callProvider(http, provider, params, ctx)

          // Fallback au format TOON si la chaîne finale est vide ou nulle
          const fallbackOutput = encode({ status: "no_results", message: "No search results found." })

          return {
            output: result ?? fallbackOutput,

            title: `${title}: ${params.query}`,

            metadata: { provider },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
