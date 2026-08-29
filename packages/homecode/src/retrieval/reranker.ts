import { Effect, Context, Layer } from "effect"

export interface RerankInput {
  readonly query: string
  readonly documents: ReadonlyArray<{ readonly id: string; readonly text: string }>
  readonly topK?: number
}

export interface RerankOutput {
  readonly id: string
  readonly score: number
  readonly index: number
}

export interface Interface {
  readonly rerank: (input: RerankInput) => Effect.Effect<ReadonlyArray<RerankOutput>>
}

export class Service extends Context.Service<Service, Interface>()("@homecode/retrieval/Reranker") {}

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
  const quoted = query.match(/"([^"]+)"/g)
  if (quoted) {
    for (const q of quoted) {
      const clean = q.replace(/^"|"$/g, "").trim().toLowerCase()
      if (clean.length > 1) phrases.push(clean)
    }
  }

  const words = query
    .toLowerCase()
    .replace(/["!]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1)

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

const STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "and", "or", "but", "if", "then", "else", "when", "how",
  "what", "which", "who", "whom", "this", "that", "these", "those",
])

function scoreDocument(
  docText: string,
  queryTokens: string[],
  phrases: string[],
  avgDocLen: number,
  originalRank: number,
  totalDocs: number,
): number {
  const textLower = docText.toLowerCase()
  const docTokens = tokenize(docText)
  const docLen = docTokens.length

  if (docLen === 0) return 0

  let bm25Score = 0
  const k1 = 1.2
  const b = 0.75

  const tokenFreqMap = new Map<string, number>()
  for (const token of docTokens) {
    tokenFreqMap.set(token, (tokenFreqMap.get(token) || 0) + 1)
  }

  const contentTokens = queryTokens.filter((t) => !STOPWORDS.has(t))
  const effectiveQueryTokens = contentTokens.length > 0 ? contentTokens : queryTokens

  let matchedContentTokens = 0
  for (const qToken of effectiveQueryTokens) {
    const tf = tokenFreqMap.get(qToken) || 0
    if (tf > 0) {
      matchedContentTokens++
      const weight = qToken.length > 4 ? 2.0 : 1.2
      const tfScore = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLen) / Math.max(avgDocLen, 10)))
      bm25Score += tfScore * weight
    }
  }

  // Coverage ratio bonus (percentage of content query terms present)
  const queryCoverage = effectiveQueryTokens.length > 0 ? matchedContentTokens / effectiveQueryTokens.length : 0
  const coverageBonus = queryCoverage * 4.0

  // Exact phrase match bonus
  let phraseScore = 0
  for (const phrase of phrases) {
    if (textLower.includes(phrase)) {
      phraseScore += phrase.length > 12 ? 5.0 : 3.0
    }
  }

  // Reciprocal rank prior from candidate generation (SERP order)
  const serpPrior = 1.0 / (60 + originalRank)

  // Total normalized score
  const totalScore = bm25Score + coverageBonus + phraseScore + serpPrior * 10
  return Number(totalScore.toFixed(4))
}

export function make(): Interface {
  return {
    rerank: (input: RerankInput) =>
      Effect.sync(() => {
        if (!input.documents.length) return []

        const queryTokens = tokenize(input.query)
        const phrases = extractPhrases(input.query)

        const totalDocLen = input.documents.reduce((sum, d) => sum + tokenize(d.text).length, 0)
        const avgDocLen = totalDocLen / input.documents.length

        const scored = input.documents.map((doc, index) => ({
          id: doc.id,
          score: scoreDocument(doc.text, queryTokens, phrases, avgDocLen, index, input.documents.length),
          index,
        }))

        // Sort descending by score
        scored.sort((a, b) => b.score - a.score)

        const topK = input.topK ?? scored.length
        return scored.slice(0, topK)
      }),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export * as Reranker from "./reranker"
