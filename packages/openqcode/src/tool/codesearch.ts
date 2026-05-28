import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import DESCRIPTION from "./codesearch.txt"
import { encode } from "@toon-format/toon"

// Schéma simplifié à l'extrême pour valider l'inférence guidée d'ik_llama
export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Code or technical query",
  }),
  category: Schema.String.annotate({
    description: "Search category: qa, repos, or all",
  }),
  maxResults: Schema.Number.annotate({
    description: "Maximum results to return",
  }),
})

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8899"

export const CodeSearchTool = Tool.define(
  "codesearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      get description() {
        return DESCRIPTION
      },

      parameters: Parameters,

      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const category = params.category || "all"
          const maxResults = params.maxResults || 5

          let formattedQuery = params.query
          if (category === "qa") {
            formattedQuery = `!q&a ${params.query}`
          } else if (category === "repos") {
            formattedQuery = `!repos ${params.query}`
          } else {
            formattedQuery = `!stackoverflow !github !ubuntu !superuser ${params.query}`
          }

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

          const request = HttpClientRequest.get(`${SEARXNG_URL}/search`).pipe(
            HttpClientRequest.setUrlParams({
              q: formattedQuery,
              format: "json",
              pageno: "1",
            }),
            HttpClientRequest.setHeaders({
              Accept: "application/json",
              "User-Agent": "OpenQCode-LocalLLM-Agent/1.0",
            }),
          )

          const response = yield* http.execute(request)
          const json = (yield* response.json) as {
            results?: Array<{
              title?: string
              url?: string
              content?: string
              snippet?: string
              engine?: string
            }>
          }

          const rawResults = json.results ?? []
          const cleanedResults = rawResults.slice(0, maxResults).map((item) => ({
            title: item.title?.trim() || "No Title",
            url: item.url ?? "",
            source: item.engine ?? "unknown",
            summary: (item.snippet || item.content || "").replace(/\s+/g, " ").trim(),
          }))

          if (cleanedResults.length === 0) {
            return {
              output: encode({
                status: "no_results",
                message: "No results found.",
              }),
              title: `Code Search: ${params.query}`,
              metadata: { category },
            }
          }

          return {
            output: encode({
              query_executed: params.query,
              engine_category: category,
              results_count: cleanedResults.length,
              results: cleanedResults,
            }),
            title: `Code Search: ${params.query}`,
            metadata: { category },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
