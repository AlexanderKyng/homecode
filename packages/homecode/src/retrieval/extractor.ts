import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import TurndownService from "turndown"

export interface ExtractedDocument {
  readonly title: string
  readonly content: string
  readonly format: "markdown" | "text" | "html"
  readonly byline?: string
  readonly excerpt?: string
  readonly siteName?: string
  readonly publishedTime?: string
  readonly length: number
}

export interface ExtractOptions {
  readonly url?: string
  readonly format?: "markdown" | "text" | "html"
  readonly maxCharacters?: number
}

function createTurndownService() {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    strongDelimiter: "**",
  })

  turndown.addRule("fencedCodeBlockWithLang", {
    filter: (node, options) =>
      options.codeBlockStyle === "fenced" &&
      node.nodeName === "PRE" &&
      Boolean(node.firstChild && (node.firstChild.nodeName === "CODE" || node.firstChild.nodeName === "#text")),
    replacement: (content, node) => {
      const firstChild = node.firstChild as any
      const className =
        (firstChild?.getAttribute?.("class") || "") + " " + ((node as any).getAttribute?.("class") || "")
      const langMatch = className.match(/(?:language|lang)-([a-zA-Z0-9_-]+)/i)
      const lang = langMatch ? langMatch[1] : ""
      const rawText = firstChild?.textContent || node.textContent || content
      return `\n\n\`\`\`${lang}\n${rawText.trim()}\n\`\`\`\n\n`
    },
  })

  // Rule to preserve markdown tables
  turndown.addRule("markdownTableRule", {
    filter: (node) =>
      node.nodeName === "PRE" &&
      Boolean((((node as any).getAttribute?.("class") || "") as string).includes("markdown-table")),
    replacement: (_content, node) => `\n\n${node.textContent?.trim() || ""}\n\n`,
  })

  // Ignore useless script/style/svg/noscript/nav/footer tags
  turndown.remove(["script", "style", "noscript", "iframe"] as any)

  return turndown
}

const turndownService = createTurndownService()

function tableToMarkdown(table: any): string {
  const rows = Array.from(table.querySelectorAll("tr")) as any[]
  if (!rows.length) return ""

  const matrix: string[][] = rows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll("th, td")) as any[]
    return cells.map((cell) => (cell.textContent?.trim() || "").replace(/\|/g, "\\|").replace(/\n+/g, " "))
  })

  if (!matrix.length || !matrix[0].length) return ""

  const colCount = Math.max(...matrix.map((r) => r.length))
  const paddedMatrix = matrix.map((row) => {
    const padded = [...row]
    while (padded.length < colCount) padded.push("")
    return padded
  })

  const headerRow = paddedMatrix[0]
  const headerLine = `| ${headerRow.join(" | ")} |`
  const delimiterLine = `| ${headerRow.map(() => "---").join(" | ")} |`
  const bodyLines = paddedMatrix.slice(1).map((row) => `| ${row.join(" | ")} |`)

  return [headerLine, delimiterLine, ...bodyLines].join("\n")
}

function preprocessTables(document: any) {
  const tables = Array.from(document.querySelectorAll("table")) as any[]
  for (const table of tables) {
    const md = tableToMarkdown(table)
    if (md) {
      const pre = document.createElement("pre")
      pre.setAttribute("class", "markdown-table")
      pre.textContent = md
      table.parentNode?.replaceChild(pre, table)
    }
  }
}

function sanitizeDOM(document: any) {
  const selectorsToRemove = [
    "script",
    "style",
    "noscript",
    "svg",
    "iframe",
    "nav",
    "footer",
    "header",
    ".ad",
    ".advertisement",
    ".cookie-banner",
    ".popup",
    "#cookie-consent",
  ]
  for (const selector of selectorsToRemove) {
    const elements = Array.from(document.querySelectorAll(selector)) as any[]
    for (const elem of elements) {
      elem.parentNode?.removeChild(elem)
    }
  }
}

export function extractFromJson(jsonStr: string, options?: ExtractOptions): ExtractedDocument {
  try {
    const parsed = JSON.parse(jsonStr)
    const formatted = JSON.stringify(parsed, null, 2)
    const content =
      options?.format === "markdown"
        ? `\`\`\`json\n${formatted}\n\`\`\``
        : formatted

    return {
      title: "JSON Response",
      content: options?.maxCharacters ? content.slice(0, options.maxCharacters) : content,
      format: options?.format ?? "markdown",
      length: content.length,
    }
  } catch {
    return {
      title: "Raw Data",
      content: options?.maxCharacters ? jsonStr.slice(0, options.maxCharacters) : jsonStr,
      format: options?.format ?? "text",
      length: jsonStr.length,
    }
  }
}

export function extractFromHtml(html: string, options?: ExtractOptions): ExtractedDocument {
  const format = options?.format ?? "markdown"
  const { document } = parseHTML(html)

  // Extract meta tags for fallback metadata
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content")
  const metaTitle = document.querySelector("title")?.textContent?.trim()
  const h1Title = document.querySelector("h1")?.textContent?.trim()
  const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute("content")
  const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute("content")
  const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")
  const articlePublishedTime = document.querySelector('meta[property="article:published_time"]')?.getAttribute("content")
  const author = document.querySelector('meta[name="author"]')?.getAttribute("content")

  // Preprocess and preserve HTML tables before Readability
  preprocessTables(document)

  // Try Readability first
  let article: ReturnType<InstanceType<typeof Readability>["parse"]> = null
  try {
    const reader = new Readability(document as any, {
      charThreshold: 20,
      keepClasses: true,
    })
    article = reader.parse()
  } catch {
    article = null
  }

  const title = article?.title?.trim() || ogTitle || metaTitle || h1Title || "Untitled"
  const excerpt = article?.excerpt?.trim() || ogDescription || metaDescription || undefined
  const siteName = article?.siteName || ogSiteName || undefined
  const byline = article?.byline || author || undefined
  const publishedTime = articlePublishedTime || undefined

  let content = ""

  if (format === "html") {
    content = String(article?.content || html)
  } else if (article?.content) {
    if (format === "text") {
      content = (article.textContent?.replace(/\n\s*\n/g, "\n\n").trim() || "") as string
    } else {
      content = turndownService.turndown(String(article.content)).replace(/\n\s*\n\s*\n/g, "\n\n").trim()
    }
  } else {
    // Fallback if Readability fails or produces empty output
    sanitizeDOM(document)
    const body = (document.body || document.documentElement) as any
    if (format === "text") {
      content = (body?.textContent?.replace(/\n\s*\n/g, "\n\n").trim() || "") as string
    } else {
      const bodyHtml = String(body?.innerHTML || html)
      content = turndownService.turndown(bodyHtml).replace(/\n\s*\n\s*\n/g, "\n\n").trim()
    }
  }

  if (options?.maxCharacters && content.length > options.maxCharacters) {
    content = content.slice(0, options.maxCharacters) + "\n\n... [Content Truncated]"
  }

  return {
    title,
    content,
    format,
    byline,
    excerpt,
    siteName,
    publishedTime,
    length: content.length,
  }
}

export * as Extractor from "./extractor"
