import { Cause, Effect, Schema, Schedule } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"
import { Readability } from "@mozilla/readability"
// @ts-ignore
import { JSDOM } from "jsdom"
import { encode } from "@toon-format/toon"
import { isIP } from "node:net"
import { Resolver } from "node:dns/promises"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT = 30 * 1000
const MAX_TIMEOUT = 120 * 1000

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback", "broadcasthost"])

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
  max_chars: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 500, maximum: 150_000 }))),
  ).annotate({
    description: "Limit extracted content to N characters. Useful for tighter token budgets.",
  }),
})

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

function returnError(url: string, message: string): FetchToolResult {
  return {
    title: `${url} (error)`,
    output: encode({ status: "error", message }),
    metadata: {},
  }
}

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)
    const httpClient = HttpClient.followRedirects(httpOk)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<FetchToolResult, never, never> => {
        const pipeline = Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            return returnError(params.url, "URL must start with http:// or https://")
          }

          const safe = yield* isSafeUrl(params.url)
          if (!safe) {
            return returnError(params.url, "Fetching private or internal addresses is not allowed")
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: { url: params.url, format: params.format, timeout: params.timeout },
          })

          const timeout = params.timeout != null ? Math.min(params.timeout * 1000, MAX_TIMEOUT) : DEFAULT_TIMEOUT

          const headers = {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
          }

          const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))
          const maxLen = params.max_chars ?? 150_000

          const response = yield* httpClient.execute(request).pipe(
            Effect.catchIf(
              (err: any) => err.reason?._tag === "StatusCodeError" && err.reason.response?.status === 403,
              () =>
                httpClient.execute(
                  HttpClientRequest.get(params.url).pipe(
                    HttpClientRequest.setHeaders({
                      ...headers,
                      "User-Agent":
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
                    }),
                  ),
                ),
            ),
            Effect.retry(Schedule.exponential("1 second").pipe(Schedule.both(Schedule.recurs(2)))),
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

          const contentLength = response.headers["content-length"]
          if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
            return returnError(params.url, "Response too large (exceeds 5MB limit)")
          }

          const arrayBuffer = yield* response.arrayBuffer
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            return returnError(params.url, "Response too large (exceeds 5MB limit)")
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
              attachments: [{ type: "file" as const, mime, url: `data:${mime};base64,${base64Content}` }],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)
          let finalPayload = ""

          if (mime === "application/json" || mime === "text/json") {
            const formatted = formatJSON(content, maxLen)
            finalPayload = encode({ status: "success", url: params.url, format: "json", content: formatted.content })
          } else if (mime === "application/xml" || mime === "text/xml") {
            finalPayload = encode({
              status: "success",
              url: params.url,
              format: "xml",
              content: formatXML(content, maxLen),
            })
          } else {
            switch (params.format) {
              case "markdown":
                if (contentType.includes("text/html")) {
                  const cleaned = extractReadableContent(content, params.url)
                  const markdown = cleanMarkdown(convertHTMLToMarkdown(cleaned)).slice(0, maxLen)
                  finalPayload = encode({ status: "success", url: params.url, format: "markdown", content: markdown })
                } else {
                  finalPayload = encode({
                    status: "success",
                    url: params.url,
                    format: "markdown",
                    content: cleanMarkdown(content).slice(0, maxLen),
                  })
                }
                break

              case "text":
                if (mime === "text/html" || mime === "application/xhtml+xml") {
                  const readable = extractReadableContent(content, params.url, false)
                  const dom = new JSDOM(readable)
                  const text = dom.window.document.body?.textContent || ""
                  finalPayload = encode({
                    status: "success",
                    url: params.url,
                    content: cleanText(text).slice(0, maxLen),
                  })
                } else {
                  finalPayload = encode({
                    status: "success",
                    url: params.url,
                    content: cleanText(content).slice(0, maxLen),
                  })
                }
                break

              case "html":
                finalPayload = encode({
                  status: "success",
                  url: params.url,
                  format: "html",
                  content: content.slice(0, maxLen),
                })
                break

              default:
                finalPayload = encode({
                  status: "success",
                  url: params.url,
                  format: "raw",
                  content: content.slice(0, maxLen),
                })
            }
          }

          return { output: finalPayload, title, metadata: {} }
        })

        return pipeline.pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({
              title: `${params.url} (fault)`,
              output: encode({ status: "error", message: Cause.pretty(cause) }),
              metadata: {},
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, http),
        )
      },
    }
  }),
)

function extractReadableContent(html: string, url?: string, withMarkdownMeta = true): string {
  let dom: JSDOM | null = null
  try {
    dom = new JSDOM(html, { url })
    const doc = dom.window.document

    for (const sel of [
      "nav",
      "footer",
      "header",
      "aside",
      ".cookie-banner",
      "[aria-label='advertisement']",
      ".sidebar",
      "#sidebar",
    ]) {
      doc.querySelectorAll(sel).forEach((el: any) => el.remove())
    }

    const reader = new Readability(doc)
    const article = reader.parse()

    if (article?.content && article.content.length > 200) {
      if (!withMarkdownMeta) return article.content
      const parts = [
        article.title ? `# ${article.title}` : "",
        article.siteName ? `*Source: ${article.siteName}*` : "",
        url ? `*URL: ${url}*` : "",
      ].filter(Boolean)
      const meta = parts.length ? `${parts.join("\n")}\n\n` : ""
      return meta + article.content
    }

    const main = doc.querySelector("main, article, [role='main'], #content, .content")
    if (main) return main.innerHTML

    return doc.body?.innerHTML ?? html
  } catch {
    return html
  } finally {
    dom?.window.close()
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
  turndownService.remove(["script", "style", "meta", "link", "video", "noscript", "figure", "figcaption", "svg"])
  return turndownService.turndown(html)
}

function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function cleanText(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function isPrivateIP(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) {
    if (
      ip.startsWith("127.") ||
      ip.startsWith("10.") ||
      ip.startsWith("192.168.") ||
      ip.startsWith("169.254.") ||
      ip.startsWith("0.")
    )
      return true
    if (ip.startsWith("172.")) {
      const second = parseInt(ip.split(".")[1], 10)
      if (second >= 16 && second <= 31) return true
    }
  } else if (version === 6) {
    if (ip === "::1" || ip === "::" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true
  }
  return false
}

export function isSafeUrl(url: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const parsed = new URL(url)
    const hostname = parsed.hostname

    if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) return false
    if (isPrivateIP(hostname)) return false

    const resolver = new Resolver()
    const [v4, v6] = yield* Effect.all([
      Effect.tryPromise({ try: () => resolver.resolve4(hostname), catch: () => [] as string[] }),
      Effect.tryPromise({ try: () => resolver.resolve6(hostname), catch: () => [] as string[] }),
    ])

    for (const addr of [...v4, ...v6]) {
      if (isPrivateIP(addr)) return false
    }
    return true
  }).pipe(Effect.orDie)
}

function formatJSON(content: string, maxLen: number): { content: string } {
  try {
    const parsed = JSON.parse(content)
    return { content: JSON.stringify(parsed, null, 2).slice(0, maxLen) }
  } catch {
    return { content: content.slice(0, maxLen) }
  }
}

function formatXML(content: string, maxLen: number): string {
  return content.replace(/>\s*</g, "><").trim().slice(0, maxLen)
}
