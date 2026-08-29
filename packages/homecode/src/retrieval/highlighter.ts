export interface Passage {
  readonly text: string
  readonly score: number
  readonly index: number
  readonly heading?: string
  readonly isCode: boolean
}

export interface HighlightOptions {
  readonly maxHighlights?: number
  readonly maxCharacters?: number
  readonly minScore?: number
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "when",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
])

function stem(word: string): string {
  if (word.length <= 3) return word
  return word.replace(/(?:ing|edly|ed|es|s|tion|ment|e)$/, "")
}

function tokenize(text: string): string[] {
  const rawWords = text.toLowerCase().match(/[a-z0-9_.-]+/g) || []
  const tokens: string[] = []

  for (const word of rawWords) {
    const clean = word.replace(/[.,:;!?()[\]{}"']/g, "")
    if (!clean) continue
    tokens.push(clean)
    const s = stem(clean)
    if (s.length >= 3 && s !== clean) tokens.push(s)
    const subWords = clean.split(/[._-]/).filter((w) => w.length > 1)
    for (const sw of subWords) {
      tokens.push(sw)
      const ss = stem(sw)
      if (ss.length >= 3 && ss !== sw) tokens.push(ss)
    }
  }

  return tokens
}

function extractPhrases(query: string): string[] {
  const phrases: string[] = []
  // Quoted phrases
  const quoted = query.match(/"([^"]+)"/g)
  if (quoted) {
    for (const q of quoted) {
      const clean = q.replace(/^"|"$/g, "").trim().toLowerCase()
      if (clean.length > 1) phrases.push(clean)
    }
  }

  const cleanQuery = query.replace(/["!]/g, "").trim().toLowerCase()
  const words = cleanQuery.split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    for (let i = 0; i < words.length - 1; i++) {
      phrases.push(`${words[i]} ${words[i + 1]}`)
      if (i < words.length - 2) {
        phrases.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
      }
    }
  }

  return phrases
}

export function segmentDocument(markdown: string): Array<{ text: string; heading?: string; isCode: boolean }> {
  const lines = markdown.split("\n")
  const passages: Array<{ text: string; heading?: string; isCode: boolean }> = []

  let currentHeading: string | undefined = undefined
  let currentBuffer: string[] = []
  let insideCodeFence = false
  let codeLang = ""

  const flushBuffer = () => {
    const trimmed = currentBuffer.join("\n").trim()
    if (trimmed.length > 0) {
      passages.push({
        text: trimmed,
        heading: currentHeading,
        isCode: false,
      })
    }
    currentBuffer = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmedLine = line.trim()

    if (trimmedLine.startsWith("```")) {
      if (!insideCodeFence) {
        flushBuffer()
        insideCodeFence = true
        codeLang = trimmedLine.slice(3).trim()
        currentBuffer.push(line)
      } else {
        currentBuffer.push(line)
        insideCodeFence = false
        const codeBlock = currentBuffer.join("\n").trim()
        if (codeBlock.length > 0) {
          passages.push({
            text: codeBlock,
            heading: currentHeading,
            isCode: true,
          })
        }
        currentBuffer = []
      }
      continue
    }

    if (insideCodeFence) {
      currentBuffer.push(line)
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      flushBuffer()
      currentHeading = headingMatch[2].trim()
      passages.push({
        text: line,
        heading: currentHeading,
        isCode: false,
      })
      continue
    }

    if (trimmedLine.length === 0) {
      if (currentBuffer.length >= 3 || currentBuffer.join(" ").length > 300) {
        flushBuffer()
      } else if (currentBuffer.length > 0) {
        currentBuffer.push("")
      }
      continue
    }

    if (trimmedLine.startsWith("|") && trimmedLine.endsWith("|")) {
      currentBuffer.push(line)
      // Check if next line is not a table row
      if (i + 1 >= lines.length || !lines[i + 1].trim().startsWith("|")) {
        flushBuffer()
      }
      continue
    }

    currentBuffer.push(line)
  }

  flushBuffer()

  return passages
}

export function scorePassage(
  passage: { text: string; heading?: string; isCode: boolean },
  queryTokens: string[],
  phrases: string[],
  avgDocLen = 200,
): number {
  const textLower = passage.text.toLowerCase()
  const headingLower = (passage.heading || "").toLowerCase()
  const passageTokens = tokenize(passage.text)
  const docLen = passageTokens.length

  if (docLen === 0) return 0

  let score = 0
  const k1 = 1.2
  const b = 0.75

  const tokenFreqMap = new Map<string, number>()
  for (const token of passageTokens) {
    tokenFreqMap.set(token, (tokenFreqMap.get(token) || 0) + 1)
  }

  const contentTokens = queryTokens.filter((t) => !STOPWORDS.has(t))
  const effectiveTokens = contentTokens.length > 0 ? contentTokens : queryTokens

  for (const queryToken of effectiveTokens) {
    const tf = tokenFreqMap.get(queryToken) || 0
    if (tf > 0) {
      const termScore = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLen) / avgDocLen))
      score += termScore * (queryToken.length > 3 ? 2.0 : 1.2)
    }

    if (headingLower.includes(queryToken)) {
      score += 2.5
    }
  }

  for (const phrase of phrases) {
    if (textLower.includes(phrase)) {
      score += phrase.length > 10 ? 8.0 : 4.0
    }
    if (headingLower.includes(phrase)) {
      score += 6.0
    }
  }

  if (passage.isCode && score > 0) {
    score *= 1.3
  }

  return score
}

export function extractHighlights(query: string, markdownOrText: string, options?: HighlightOptions): string[] {
  if (!markdownOrText || markdownOrText.trim().length === 0) return []
  if (!query || query.trim().length === 0) {
    const passages = segmentDocument(markdownOrText)
    return passages.slice(0, options?.maxHighlights || 3).map((p) => p.text)
  }

  const queryTokens = tokenize(query)
  const phrases = extractPhrases(query)
  const segments = segmentDocument(markdownOrText)

  if (segments.length === 0) return []

  const scoredPassages: Passage[] = segments.map((seg, index) => ({
    text: seg.text,
    score: scorePassage(seg, queryTokens, phrases),
    index,
    heading: seg.heading,
    isCode: seg.isCode,
  }))

  const minScore = options?.minScore ?? 0.5
  const maxHighlights = options?.maxHighlights ?? 5
  const maxCharacters = options?.maxCharacters ?? 4000

  const relevant = scoredPassages.filter((p) => p.score >= minScore)

  if (relevant.length === 0) {
    return segments.length > 0 ? [segments[0].text.slice(0, maxCharacters)] : []
  }

  const sorted = [...relevant].sort((a, b) => b.score - a.score)
  const selected = sorted.slice(0, maxHighlights)

  selected.sort((a, b) => a.index - b.index)

  const highlights: string[] = []
  let totalChars = 0

  for (const passage of selected) {
    const text = passage.text.trim()
    if (totalChars + text.length > maxCharacters && highlights.length > 0) {
      break
    }
    highlights.push(text)
    totalChars += text.length
  }

  return highlights
}

export * as Highlighter from "./highlighter"
