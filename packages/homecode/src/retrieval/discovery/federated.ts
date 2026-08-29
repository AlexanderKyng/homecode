import { Context, Effect, Layer } from "effect"
import {
  type DiscoveryCandidate,
  type DiscoveryOptions,
  type DiscoveryProvider,
  type FusedCandidate,
  type ProviderTelemetry,
} from "./types"
import { createGitHubProvider } from "./github"
import { createStackExchangeProvider } from "./stackexchange"
import { createSearXNGProvider } from "./searxng"
import { createLocalCorpusProvider, LocalCorpusIndex } from "./local-corpus"
import { fuseCandidates, type FusionConfig, DEFAULT_FUSION_CONFIG } from "./fusion"
import { classifyQuery, type QueryClassification } from "../classifier"

export interface FederatedDiscoveryResult {
  readonly query: string
  readonly classification: QueryClassification
  readonly candidates: readonly FusedCandidate[]
  readonly telemetry: readonly ProviderTelemetry[]
  readonly totalCandidatesRaw: number
  readonly totalCandidatesFused: number
  readonly totalLatencyMs: number
}

export interface Interface {
  readonly search: (
    query: string,
    options?: DiscoveryOptions,
    fusionConfig?: FusionConfig,
  ) => Effect.Effect<FederatedDiscoveryResult, Error>
  readonly getLocalCorpus: () => LocalCorpusIndex
}

export class Service extends Context.Service<Service, Interface>()(
  "@homecode/retrieval/FederatedDiscovery",
) {
  static readonly defaultLayer = Layer.succeed(
    Service,
    createFederatedDiscoveryService(),
  )
}

export function createFederatedDiscoveryService(
  customProviders?: DiscoveryProvider[],
  corpusIndex?: LocalCorpusIndex,
): Interface {
  const corpus = corpusIndex ?? new LocalCorpusIndex()
  const providers: DiscoveryProvider[] = customProviders ?? [
    createLocalCorpusProvider(corpus),
    createGitHubProvider(),
    createStackExchangeProvider(),
    createSearXNGProvider(),
  ]

  return {
    getLocalCorpus: () => corpus,
    search: (query: string, options: DiscoveryOptions = {}, fusionConfig: FusionConfig = DEFAULT_FUSION_CONFIG) =>
      Effect.tryPromise({
        try: async () => {
          const startTime = performance.now()
          const classification = options.classification ?? classifyQuery(query)

          // 1. Select matching providers
          const activeProviders = providers.filter((p) => p.supports(classification))
          const providerTelemetry: ProviderTelemetry[] = []
          const candidateLists: Array<ReadonlyArray<DiscoveryCandidate>> = []

          // 2. Concurrently execute all active providers with individual timeouts
          const searchPromises = activeProviders.map(async (provider) => {
            const pStart = performance.now()
            try {
              const res = await Effect.runPromise(
                provider.search(query, {
                  ...options,
                  classification,
                }),
              )
              const pLatency = performance.now() - pStart
              providerTelemetry.push({
                provider: provider.id,
                candidateCount: res.length,
                latencyMs: pLatency,
                success: true,
                cacheHit: false,
              })
              return res
            } catch (err) {
              const pLatency = performance.now() - pStart
              providerTelemetry.push({
                provider: provider.id,
                candidateCount: 0,
                latencyMs: pLatency,
                success: false,
                cacheHit: false,
                error: String(err),
              })
              return []
            }
          })

          const results = await Promise.all(searchPromises)
          for (const list of results) {
            if (list.length > 0) {
              candidateLists.push(list)
            }
          }

          // 3. Calculate raw candidate count
          const totalCandidatesRaw = candidateLists.reduce((acc, l) => acc + l.length, 0)

          // 4. Cross-provider candidate fusion with consensus bonus
          const fused = fuseCandidates(candidateLists, fusionConfig)
          const totalLatencyMs = performance.now() - startTime

          return {
            query,
            classification,
            candidates: fused,
            telemetry: providerTelemetry,
            totalCandidatesRaw,
            totalCandidatesFused: fused.length,
            totalLatencyMs,
          }
        },
        catch: (err) => new Error(`Federated discovery failed: ${String(err)}`),
      }),
  }
}

export * as FederatedDiscoveryModule from "./federated"
