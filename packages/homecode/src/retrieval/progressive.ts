import { Effect } from "effect"
import { classifyQuery } from "./classifier"
import { type RerankOutput } from "./reranker"

export interface ProgressiveConfig {
  readonly initialFetchCount: number
  readonly maxFetchCount: number
  readonly minSufficiencyScore: number
  readonly minScoreMargin: number
  readonly maxPassageBudget: number
}

export const DEFAULT_PROGRESSIVE_CONFIG: ProgressiveConfig = {
  initialFetchCount: 2,
  maxFetchCount: 5,
  minSufficiencyScore: 6.0,
  minScoreMargin: 1.5,
  maxPassageBudget: 800,
}

const ACRONYM_MAP: Readonly<Record<string, string>> = {
  ast: "abstract syntax tree",
  crdt: "conflict-free replicated data type",
  lsp: "language server protocol",
  mrr: "mean reciprocal rank",
  ndcg: "normalized discounted cumulative gain",
  rag: "retrieval augmented generation",
  ipc: "inter process communication",
  simd: "single instruction multiple data",
  ssrf: "server side request forgery",
  toctou: "time of check time of use",
  fts: "full text search",
  rrf: "reciprocal rank fusion",
  wasm: "webassembly",
}

export function reformulateQuery(query: string): string {
  const clean = query.replace(/[.,:;!?()[\]{}"']/g, " ").replace(/\s+/g, " ").trim()
  const words = clean.split(" ")
  const expandedWords = words.map((w) => {
    const lower = w.toLowerCase()
    return ACRONYM_MAP[lower] ?? w
  })

  // Strip error line numbers and local file prefixes if present
  const result = expandedWords.join(" ")
  return result
}

export interface SufficiencyResult {
  readonly isSufficient: boolean
  readonly topScore: number
  readonly scoreMargin: number
  readonly reason: string
}

export function evaluateSufficiency(
  rankedCandidates: ReadonlyArray<RerankOutput>,
  passagesScored: ReadonlyArray<{ text: string; score: number }>,
  config: ProgressiveConfig = DEFAULT_PROGRESSIVE_CONFIG,
): SufficiencyResult {
  if (rankedCandidates.length === 0) {
    return {
      isSufficient: false,
      topScore: 0,
      scoreMargin: 0,
      reason: "zero_candidates",
    }
  }

  const topScore = rankedCandidates[0].score
  const secondScore = rankedCandidates.length > 1 ? rankedCandidates[1].score : 0
  const scoreMargin = topScore - secondScore

  const topPassageScore = passagesScored.length > 0 ? passagesScored[0].score : 0

  if (topScore >= config.minSufficiencyScore && topPassageScore >= 4.0) {
    return {
      isSufficient: true,
      topScore,
      scoreMargin,
      reason: "high_confidence_evidence",
    }
  }

  if (scoreMargin >= config.minScoreMargin && topScore >= 4.0) {
    return {
      isSufficient: true,
      topScore,
      scoreMargin,
      reason: "clear_dominant_candidate",
    }
  }

  return {
    isSufficient: false,
    topScore,
    scoreMargin,
    reason: "insufficient_score_or_margin",
  }
}

export * as Progressive from "./progressive"
