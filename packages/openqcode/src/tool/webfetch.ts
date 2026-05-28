import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"
import { Readability } from "@mozilla/readability"
import { JSDOM } from "jsdom"
import { encode } from "@toon-format/toon"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

// Définition d'une interface unique de retour pour satisfaire le typage strict d'OpenQCode
interface FetchToolResult {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: Array<{
    type: "file"
    mime: string
    url: string
  }>
}

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const httpClient = httpOk.pipe(HttpClient.followRedirects)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<FetchToolResult, never, never> =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
          }

          const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))

          // L'appel est encapsulé et résolu avec le service http local pour éviter la fuite du type d'environnement 'unknown'
          const response = yield* httpClient.execute(request).pipe(
            Effect.catchIf(
              (err: any) =>
                err.reason._tag === "StatusCodeError" &&
                err.reason.response.status === 403 &&
                err.reason.response.headers["cf-mitigated"] === "challenge",
              () =>
                httpClient.execute(
                  HttpClientRequest.get(params.url).pipe(
                    HttpClientRequest.setHeaders({ ...headers, "User-Agent": "openqcode" }),
                  ),
                ),
            ),
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )
          const MAX_MARKDOWN_LENGTH = 150_000

          const contentLength = response.headers["content-length"]
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const arrayBuffer = yield* response.arrayBuffer
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(arrayBuffer).toString("base64")
            return {
              title,
              output: encode({ status: "success", message: "Image fetched successfully", mode: "binary_attachment" }),
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)
          let finalPayload = ""

          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                if (content.length > 2_000_000) {
                  finalPayload = encode({ status: "error", message: "Page too large to process safely" })
                } else {
                  const cleaned = extractReadableContent(content, params.url)
                  const markdown = cleanMarkdown(convertHTMLToMarkdown(cleaned)).slice(0, MAX_MARKDOWN_LENGTH)

                  finalPayload = encode({
                    status: "success",
                    url: params.url,
                    format: "markdown",
                    content: markdown,
                  })
                }
              } else {
                finalPayload = encode({
                  status: "success",
                  url: params.url,
                  format: "markdown",
                  content: cleanMarkdown(content).slice(0, MAX_MARKDOWN_LENGTH),
                })
              }
              break

            case "text":
              if (mime === "text/html" || mime === "application/xhtml+xml") {
                finalPayload = encode({
                  status: "success",
                  url: params.url,
                  format: "text",
                  content: extractTextFromHTML(content)
                    .replace(/[ \t]+/g, " ")
                    .slice(0, MAX_MARKDOWN_LENGTH),
                })
              } else {
                finalPayload = encode({
                  status: "success",
                  url: params.url,
                  format: "text",
                  content: content.replace(/[ \t]+/g, " ").slice(0, MAX_MARKDOWN_LENGTH),
                })
              }
              break

            case "html":
              finalPayload = encode({
                status: "success",
                url: params.url,
                format: "html",
                content: content.slice(0, MAX_MARKDOWN_LENGTH),
              })
              break

            default:
              finalPayload = encode({
                status: "success",
                url: params.url,
                format: "raw",
                content: content.slice(0, MAX_MARKDOWN_LENGTH),
              })
          }

          return {
            output: finalPayload,
            title,
            metadata: {},
          }
        }).pipe(
          Effect.orDie,
          // Résout explicitement le service HttpClient au niveau du wrapper d'exécution
          // pour transformer l'environnement HttpClient requis en environnement autonome 'never'
          Effect.provideService(HttpClient.HttpClient, http),
        ) as any, // Le cast structurel de sécurité final permet de court-circuiter les rigidités d'inférence d'unions imbriquées d'Effect
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const skippedTags = new Set(["script", "style", "noscript", "iframe", "object", "embed"])

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0) {
        skipDepth++
        return
      }

      if (skippedTags.has(name)) {
        skipDepth = 1
      }
    },

    ontext(input) {
      if (skipDepth === 0) {
        text += input
      }
    },

    onclosetag() {
      if (skipDepth > 0) {
        skipDepth--
      }
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function extractReadableContent(html: string, url?: string) {
  let dom: JSDOM | null = null
  try {
    dom = new JSDOM(html, { url })
    const reader = new Readability(dom.window.document)
    const article = reader.parse()

    if (article?.content && article.content.length > 200) {
      return article.content
    }
    return html
  } catch {
    return html
  } finally {
    if (dom) {
      dom.window.close()
    }
  }
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link", "svg"])
  turndownService.addRule("remove-link-urls", {
    filter: "a",
    replacement: (content) => content.trim(),
  })

  html = html.replace(/data:image\/[^;]+;base64,[^"]+/gi, "")
  return turndownService.turndown(html)
}

function cleanMarkdown(markdown: string) {
  return markdown
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}
