import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import DESCRIPTION from "./webfetch.txt"
import { encode } from "@toon-format/toon"
import { validateSafeUrl } from "../retrieval/ssrf"
import { extractFromHtml, extractFromJson } from "../retrieval/extractor"
import { extractHighlights } from "../retrieval/highlighter"
import { isDynamicSPA, renderWithHeadlessBrowser } from "../retrieval/playwright"
import { RetrievalCache } from "../retrieval/cache"
import { InstallationVersion } from "@homecode-ai/core/installation/version"

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "The HTTP or HTTPS URL to fetch content from",
  }),
  format: Schema.optional(Schema.Literals(["markdown", "text", "html"])).annotate({
    description: "Output format - 'markdown' (default), 'text', or 'html'",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Optional query to extract and focus on relevant passage highlights within the fetched document",
  }),
  maxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum character length for the output content (default: 20000)",
  }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const cache = yield* RetrievalCache.Service

    return {
      get description() {
        return DESCRIPTION
      },

      parameters: Parameters,

      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const rawUrl = params.url.trim()
          const format = params.format ?? "markdown"
          const maxChars = params.maxCharacters ?? 20000

          yield* ctx.metadata({
            title: `Web Fetch "${rawUrl}"`,
            metadata: { url: rawUrl, format },
          })

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [rawUrl],
            always: ["*"],
            metadata: { url: rawUrl, format, query: params.query },
          })

          // 1. SSRF and private network guard
          const parsedUrl = yield* validateSafeUrl(rawUrl)
          const targetUrl = parsedUrl.href

          // 2. Check local SQLite cache
          const cached = yield* cache.getDocument(targetUrl)
          if (cached && !params.query) {
            const output = encode({
              url: cached.url,
              title: cached.title,
              format,
              cached: true,
              content: cached.content.slice(0, maxChars),
            })
            return {
              title: `Web Fetch: ${cached.title || targetUrl}`,
              output,
              metadata: {
                url: targetUrl,
                status: cached.status,
                contentType: cached.contentType,
                format,
                cached: true,
              },
            }
          }

          // 3. Perform direct HTTP fetch with modern browser headers
          const request = HttpClientRequest.get(targetUrl).pipe(
            HttpClientRequest.setHeaders({
              "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (homecode/${InstallationVersion})`,
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
              "Accept-Language": "en-US,en;q=0.9",
            }),
          )

          const response = yield* http.execute(request).pipe(
            Effect.mapError((err) => new Error(`Failed to fetch URL ${targetUrl}: ${String(err)}`)),
          )

          const contentType = response.headers["content-type"] || ""
          const status = response.status
          const bodyText = yield* response.text

          let title = ""
          let extractedContent = ""
          let highlights: string[] | undefined = undefined

          if (contentType.includes("application/json") || bodyText.trim().startsWith("{") || bodyText.trim().startsWith("[")) {
            const extracted = extractFromJson(bodyText, { format, maxCharacters: maxChars })
            title = extracted.title
            extractedContent = extracted.content
          } else {
            let htmlToProcess = bodyText
            // Check dynamic SPA detection
            if (isDynamicSPA(bodyText)) {
              const rendered = yield* renderWithHeadlessBrowser(targetUrl)
              if (rendered.rendered && rendered.html) {
                htmlToProcess = rendered.html
              }
            }

            const extracted = extractFromHtml(htmlToProcess, { format, url: targetUrl, maxCharacters: maxChars })
            title = extracted.title
            extractedContent = extracted.content
          }

          // Query-conditioned passage highlighting if query was specified
          if (params.query && extractedContent) {
            highlights = extractHighlights(params.query, extractedContent, {
              maxHighlights: 5,
              maxCharacters: 6000,
            })
          }

          // Save to local cache
          yield* cache.setDocument({
            url: targetUrl,
            title,
            content: extractedContent,
            contentType,
            status,
          })

          const payload = {
            url: targetUrl,
            title: title || targetUrl,
            status,
            format,
            ...(highlights && highlights.length > 0
              ? { query: params.query, highlights, full_content: extractedContent }
              : { content: extractedContent }),
          }

          return {
            title: `Web Fetch: ${title || targetUrl}`,
            output: encode(payload),
            metadata: {
              url: targetUrl,
              status,
              contentType,
              format,
              cached: false,
            },
          }
        }).pipe(Effect.orDie),
    }
  }).pipe(Effect.provide(RetrievalCache.defaultLayer)),
)

export * as WebFetch from "./webfetch"
