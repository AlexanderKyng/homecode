import { BENCHMARK_ITEMS, type BenchmarkItem } from "../../../test/retrieval/benchmark-dataset"
import { type CorpusMissAnalysis, type CorpusSource } from "./types"

export interface RankedSourceCandidate {
  readonly source: CorpusSource
  readonly score: number
  readonly coveredBenchmarkQueries: readonly string[]
  readonly estimatedDocCount: number
  readonly estimatedSizeBytes: number
  readonly rationale: string
}

export function analyzeBenchmarkMisses(
  testedResults: ReadonlyArray<{ item: BenchmarkItem; hit: boolean; localHit: boolean }>,
): {
  readonly totalMisses: number
  readonly missTaxonomy: Readonly<Record<string, number>>
  readonly analyses: readonly CorpusMissAnalysis[]
} {
  const taxonomy: Record<string, number> = {
    documentation_not_indexed: 0,
    repository_docs_not_indexed: 0,
    deep_repo_file_missing: 0,
    github_issue_missing: 0,
    stackoverflow_content_missing: 0,
    version_specific_docs_missing: 0,
    release_notes_changelog_missing: 0,
    academic_paper: 0,
    query_vocabulary_mismatch: 0,
    lexical_fts_failure_present_locally: 0,
    source_fetched_not_promoted: 0,
    other: 0,
  }

  const analyses: CorpusMissAnalysis[] = []

  for (const { item, hit, localHit } of testedResults) {
    if (hit) continue

    const qLower = item.query.toLowerCase()
    let reason: CorpusMissAnalysis["failureReason"] = "documentation_not_indexed"

    if (item.category === "Stack Traces & Runtime Errors") {
      reason = "stackoverflow_content_missing"
    } else if (item.category === "GitHub Issue & Source Discovery") {
      reason = qLower.includes("issue") ? "github_issue_missing" : "deep_repo_file_missing"
    } else if (item.category === "Version-Sensitive API Documentation") {
      reason = "version_specific_docs_missing"
    } else if (item.category === "Freshness-Sensitive Lookups") {
      reason = "release_notes_changelog_missing"
    } else if (item.category === "Academic / IR Theory") {
      reason = "academic_paper"
    } else if (item.category === "Poor Initial Terminology" || item.category === "Acronym Expansion") {
      reason = "query_vocabulary_mismatch"
    } else if (item.category === "Repository / Project Discovery") {
      reason = "repository_docs_not_indexed"
    } else if (localHit) {
      reason = "lexical_fts_failure_present_locally"
    } else {
      reason = "documentation_not_indexed"
    }

    taxonomy[reason] = (taxonomy[reason] || 0) + 1

    analyses.push({
      query: item.query,
      category: item.category,
      split: item.split,
      targetDomain: item.authoritativeDomains[0] || "unknown",
      failureReason: reason,
    })
  }

  return {
    totalMisses: analyses.length,
    missTaxonomy: taxonomy,
    analyses,
  }
}

export function planCorpusPriorities(
  missAnalyses: ReadonlyArray<CorpusMissAnalysis>,
  knownSources: ReadonlyArray<CorpusSource>,
): ReadonlyArray<RankedSourceCandidate> {
  const domainMissMap = new Map<string, string[]>()

  for (const miss of missAnalyses) {
    const d = miss.targetDomain.toLowerCase()
    const list = domainMissMap.get(d) || []
    list.push(miss.query)
    domainMissMap.set(d, list)
  }

  const candidates: RankedSourceCandidate[] = knownSources.map((source) => {
    let coveredQueries: string[] = []

    for (const [domain, queries] of domainMissMap.entries()) {
      if (source.canonicalUrl.toLowerCase().includes(domain) || (source.project && domain.includes(source.project.toLowerCase()))) {
        coveredQueries = [...coveredQueries, ...queries]
      }
    }

    // Scoring formula: (Coverage * 4.0) + Authority Bonus + Priority
    const authorityMultiplier = source.authority === "official" ? 2.0 : source.authority === "trusted" ? 1.5 : 1.0
    const coverageScore = coveredQueries.length * 4.0
    const finalScore = (coverageScore + source.priority) * authorityMultiplier

    return {
      source,
      score: finalScore,
      coveredBenchmarkQueries: coveredQueries,
      estimatedDocCount: source.documentCount || 50,
      estimatedSizeBytes: source.totalSizeBytes || 250_000,
      rationale: `Covers ${coveredQueries.length} benchmark misses with ${source.authority} authority.`,
    }
  })

  return candidates.sort((a, b) => b.score - a.score)
}

export * as CorpusPlanner from "./planner"
