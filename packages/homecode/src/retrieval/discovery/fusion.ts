import { type DiscoveryCandidate, type FusedCandidate, type SourceType } from "./types"

export interface FusionConfig {
  readonly k: number
  readonly providerWeights: Readonly<Record<string, number>>
  readonly consensusBonusMultiplier: number
}

export const DEFAULT_FUSION_CONFIG: FusionConfig = {
  k: 60,
  providerWeights: {
    local_corpus: 1.3,
    github: 1.2,
    stackexchange: 1.15,
    searxng: 1.0,
  },
  consensusBonusMultiplier: 0.5,
}

export function canonicalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.hash = ""
    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "source",
      "fbclid",
      "gclid",
    ]
    for (const p of trackingParams) {
      parsed.searchParams.delete(p)
    }
    return parsed.toString().replace(/\/$/, "")
  } catch {
    return rawUrl.trim().replace(/\/$/, "")
  }
}

export function fuseCandidates(
  candidatesByProvider: ReadonlyArray<ReadonlyArray<DiscoveryCandidate>>,
  config: FusionConfig = DEFAULT_FUSION_CONFIG,
): FusedCandidate[] {
  const urlMap = new Map<
    string,
    {
      url: string
      titles: string[]
      snippets: string[]
      sourceTypes: Set<SourceType>
      matchedProviders: Set<string>
      providerRanks: Record<string, number>
      providerScores: Record<string, number>
      metadata: Record<string, unknown>
    }
  >()

  for (const providerList of candidatesByProvider) {
    for (const item of providerList) {
      const canonical = canonicalizeUrl(item.url)
      if (!canonical) continue

      const existing = urlMap.get(canonical) || {
        url: canonical,
        titles: [],
        snippets: [],
        sourceTypes: new Set<SourceType>(),
        matchedProviders: new Set<string>(),
        providerRanks: {},
        providerScores: {},
        metadata: {},
      }

      if (item.title) existing.titles.push(item.title)
      if (item.snippet) existing.snippets.push(item.snippet)
      existing.sourceTypes.add(item.sourceType)
      existing.matchedProviders.add(item.provider)
      existing.providerRanks[item.provider] = item.providerRank
      if (item.providerScore !== undefined) {
        existing.providerScores[item.provider] = item.providerScore
      }
      if (item.metadata) {
        Object.assign(existing.metadata, item.metadata)
      }

      urlMap.set(canonical, existing)
    }
  }

  const fusedList: FusedCandidate[] = []

  for (const entry of urlMap.values()) {
    let rrfScore = 0

    for (const [provider, rank] of Object.entries(entry.providerRanks)) {
      const weight = config.providerWeights[provider] ?? 1.0
      rrfScore += weight / (config.k + rank)
    }

    // Consensus Bonus: reward candidates discovered by multiple independent providers
    const providerCount = entry.matchedProviders.size
    if (providerCount > 1) {
      rrfScore *= 1 + config.consensusBonusMultiplier * (providerCount - 1)
    }

    // Pick best title (longest informative title)
    const bestTitle = entry.titles.sort((a, b) => b.length - a.length)[0] || entry.url
    const bestSnippet = entry.snippets.sort((a, b) => b.length - a.length)[0] || ""
    const sourceTypesArray = Array.from(entry.sourceTypes)
    const primarySourceType = sourceTypesArray[0] || "web"

    fusedList.push({
      url: entry.url,
      title: bestTitle,
      snippet: bestSnippet,
      primarySourceType,
      sourceTypes: sourceTypesArray,
      matchedProviders: Array.from(entry.matchedProviders),
      providerRanks: entry.providerRanks,
      providerScores: entry.providerScores,
      fusionScore: rrfScore,
      metadata: entry.metadata,
    })
  }

  return fusedList.sort((a, b) => b.fusionScore - a.fusionScore)
}

export * as Fusion from "./fusion"
