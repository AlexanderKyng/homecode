import { Effect, Schema, Schedule } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"
import { Readability } from "@mozilla/readability"
// @ts-ignore - jsdom v29 lacks TypeScript declarations
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
      ): Effect.Effect<FetchToolResult, never, never> =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          const safe = yield* isSafeUrl(params.url)
          if (!safe) {
            throw new Error("Fetching private or internal addresses is not allowed")
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

          const timeout = params.timeout != null ? Math.min(params.timeout * 1000, MAX_TIMEOUT) : DEFAULT_TIMEOUT

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

          const maxLen = params.max_chars ?? 150_000

          const response = yield* httpClient.execute(request).pipe(
            Effect.catchIf(
              (err: any) =>
                err.reason._tag === "StatusCodeError" &&
                err.reason.response.status === 403 &&
                err.reason.response.headers["cf-mitigated"] === "challenge",
              () =>
                httpClient.execute(
                  HttpClientRequest.get(params.url).pipe(
                    HttpClientRequest.setHeaders({ ...headers, "User-Agent": "homecode" }),
                  ),
                ),
            ),
            Effect.retry(Schedule.exponential("1 second").pipe(Schedule.both(Schedule.recurs(2)))),
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

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

          if (mime === "application/json" || mime === "text/json") {
            const formatted = formatJSON(content, maxLen)
            finalPayload = encode({
              status: "success",
              url: params.url,
              format: "json",
              content: formatted.content,
            })
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
                  if (content.length > 2_000_000) {
                    finalPayload = encode({ status: "error", message: "Page too large to process safely" })
                  } else {
                    const cleaned = extractReadableContent(content, params.url)
                    const markdown = cleanMarkdown(convertHTMLToMarkdown(cleaned)).slice(0, maxLen)
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
                    content: cleanMarkdown(content).slice(0, maxLen),
                  })
                }
                break

              case "text":
                if (mime === "text/html" || mime === "application/xhtml+xml") {
                  if (content.length > 2_000_000) {
                    finalPayload = encode({ status: "error", message: "Page too large to process safely" })
                  } else {
                    const readable = extractReadableContent(content, params.url, false)
                    const text = extractTextFromHTML(readable)
                    finalPayload = encode({
                      status: "success",
                      url: params.url,
                      content: cleanText(text).slice(0, maxLen),
                    })
                  }
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

          return {
            output: finalPayload,
            title,
            metadata: {},
          }
        }).pipe(Effect.orDie, Effect.provideService(HttpClient.HttpClient, http)) as any,
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const skippedTags = new Set(["script", "style", "noscript", "iframe", "object", "embed"])
  const blockTags = new Set([
    "p",
    "div",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "br",
    "tr",
    "blockquote",
    "section",
    "article",
    "pre",
  ])

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0) {
        skipDepth++
        return
      }
      if (skippedTags.has(name)) {
        skipDepth = 1
        return
      }
      if (blockTags.has(name) && text.length > 0 && !text.endsWith("\n")) {
        text += "\n"
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag(name) {
      if (skipDepth > 0) {
        skipDepth--
        return
      }
      if (blockTags.has(name)) {
        if (text.length > 0 && !text.endsWith("\n")) text += "\n"
      } else {
        if (text.length > 0 && !text.endsWith(" ") && !text.endsWith("\n")) text += " "
      }
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

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
      doc.querySelectorAll(sel).forEach((el: Element) => el.remove())
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
  turndownService.remove(["script", "style", "meta", "link", "video", "noscript", "figure", "figcaption"])
  turndownService.remove((node) => node.nodeName === "svg")
  turndownService.addRule("strip-decorative-images", {
    filter: (node: Node) => {
      if (node.nodeName !== "IMG") return false
      const alt = (node as HTMLElement).getAttribute("alt") || ""
      return !alt.trim()
    },
    replacement: () => "",
  })
  turndownService.addRule("fenced-code-blocks", {
    filter: (node: Node) => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
    replacement: (_content, node: Node) => {
      const code = node.firstChild as HTMLElement
      const className = code.getAttribute?.("class") || ""
      const lang = (className.match(/language-(\S+)/) || [])[1] || ""
      const text = code.textContent || ""
      return `\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n`
    },
  })
  turndownService.addRule("clean-links", {
    filter: "a",
    replacement: (content, node: Node) => {
      const href = (node as HTMLElement).getAttribute?.("href") || ""
      const text = content.trim()
      if (!text) return ""
      if (href.startsWith("http") && text !== href) {
        return `[${text}](${href})`
      }
      return text
    },
  })
  html = html.replace(/data:image\/[^;]+;base64,[^"]+/gi, "")
  return turndownService.turndown(html)
}

function cleanMarkdown(markdown: string) {
  return markdown
    .replace(/[ \t]+/g, " ")
    .replace(/\\?\[\\?\*\\?\]/g, "")
    .replace(/^Fig\.?\s*\d+\.?\s*$/gim, "")
    .replace(/^Your browser does not support.*$/gim, "")
    .replace(/^\s*-\s*\n/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}

function cleanText(text: string): string {
  return text
    .replace(/\[\*\]/g, "")
    .replace(/Fig\.?\s*\d+\.?/gi, "")
    .replace(/Your browser does not support[^.]*\./gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
}

function isPrivateIP(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) {
    if (ip.startsWith("127.")) return true
    if (ip.startsWith("10.")) return true
    if (ip.startsWith("192.168.")) return true
    if (ip.startsWith("169.254.")) return true
    if (ip.startsWith("0.")) return true
    if (ip.startsWith("172.")) {
      const second = parseInt(ip.split(".")[1], 10)
      if (second >= 16 && second <= 31) return true
    }
  } else if (version === 6) {
    if (ip === "::1" || ip === "::") return true
    if (ip.startsWith("fe80:")) return true
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true
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
