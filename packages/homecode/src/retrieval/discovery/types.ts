import { Effect, Schema } from "effect"
import { type QueryClassification } from "../classifier"

export type SourceType =
  | "web"
  | "github_repository"
  | "github_code"
  | "github_issue"
  | "stackoverflow"
  | "documentation"
  | "local_corpus"

export interface DiscoveryCandidate {
  readonly url: string
  readonly title: string
  readonly snippet?: string
  readonly provider: string
  readonly providerRank: number
  readonly providerScore?: number
  readonly sourceType: SourceType
  readonly publishedDate?: string
  readonly metadata?: Record<string, unknown>
}

export interface FusedCandidate {
  readonly url: string
  readonly title: string
  readonly snippet?: string
  readonly primarySourceType: SourceType
  readonly sourceTypes: readonly SourceType[]
  readonly matchedProviders: readonly string[]
  readonly providerRanks: Readonly<Record<string, number>>
  readonly providerScores: Readonly<Record<string, number>>
  readonly fusionScore: number
  readonly metadata?: Record<string, unknown>
}

export interface DiscoveryOptions {
  readonly limit?: number
  readonly timeoutMs?: number
  readonly classification?: QueryClassification
  readonly githubToken?: string
  readonly stackExchangeKey?: string
}

export interface ProviderTelemetry {
  readonly provider: string
  readonly candidateCount: number
  readonly latencyMs: number
  readonly success: boolean
  readonly rateLimitRemaining?: number
  readonly rateLimitResetMs?: number
  readonly backoffSeconds?: number
  readonly cacheHit: boolean
  readonly error?: string
}

export interface DiscoveryProvider {
  readonly id: string
  readonly name: string
  readonly supports: (classification: QueryClassification) => boolean
  readonly search: (
    query: string,
    options: DiscoveryOptions,
  ) => Effect.Effect<ReadonlyArray<DiscoveryCandidate>, Error>
}

export * as DiscoveryTypes from "./types"
