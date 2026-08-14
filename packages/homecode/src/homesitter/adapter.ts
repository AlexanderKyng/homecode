import { Context, Effect, Layer, Scope } from "effect"
import * as Log from "@homecode-ai/core/util/log"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { indexRepository, search } from "./core"
import { applyEmbeddingRecords, indexSemantic, loadEmbeddingRecords, saveEmbeddingRecords } from "./embedding"
import {
  applyJinaEmbeddingRecords,
  indexJinaSemantic,
  jinaSemanticScoresFor,
  loadJinaEmbeddingRecords,
  saveJinaEmbeddingRecords,
} from "./jina"
import type { Candidate, HomeSitterIndex, SemanticBackend } from "./types"

const log = Log.create({ service: "homesitter.adapter" })

export type ContextBlock = {
  source: "homesitter"
  text: string
  estimatedTokens: number
  priority: number
}

type State = {
  started: boolean
  index?: HomeSitterIndex
  error?: string
}

export interface Interface {
  readonly dynamicContext: (input: { query: string; tokenBudget: number }) => Effect.Effect<ContextBlock[]>
  readonly status: () => Effect.Effect<HomeSitterIndex["status"] | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@homecode/HomeSitterAdapter") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const scope = yield* Scope.Scope
    const state = yield* InstanceState.make<State>(() => Effect.succeed({ started: false }))

    const build = Effect.fn("HomeSitterAdapter.build")(function* (
      root: string,
      repositoryId: string,
      backend: SemanticBackend,
    ) {
      const current = yield* InstanceState.get(state)
      const controller = new AbortController()
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => controller.abort()),
      )
      current.error = undefined

      const structural = yield* Effect.tryPromise({
        try: () => indexRepository({ root, repositoryId, signal: controller.signal }),
        catch: (cause) => cause,
      })
      current.index = structural

      if (backend === "off") return

      if (backend === "jina-code") {
        const hydrated = applyJinaEmbeddingRecords(
          structural,
          yield* Effect.tryPromise({
            try: () => loadJinaEmbeddingRecords(root, repositoryId),
            catch: (cause) => cause,
          }),
        )
        current.index = hydrated

        const semantic = yield* Effect.tryPromise({
          try: () =>
            indexJinaSemantic(hydrated, {
              batchSize: 4,
              signal: controller.signal,
              onProgress: async (next) => {
                current.index = next
                await saveJinaEmbeddingRecords(root, repositoryId, next).catch((cause) => {
                  log.warn("HomeSitter Jina semantic progress could not be persisted", { cause })
                })
              },
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              current.error = String(cause)
              log.warn("HomeSitter Jina semantic indexing failed; structural and lexical retrieval remain available", {
                cause,
              })
              return current.index ?? hydrated
            }),
          ),
        )
        current.index = semantic
        return
      }

      const hydrated = applyEmbeddingRecords(
        structural,
        yield* Effect.tryPromise({
          try: () => loadEmbeddingRecords(root, repositoryId),
          catch: (cause) => cause,
        }),
      )
      current.index = hydrated

      const semantic = yield* Effect.tryPromise({
        try: () =>
          indexSemantic(hydrated, {
            batchSize: 16,
            signal: controller.signal,
            onProgress: async (next) => {
              current.index = next
              await saveEmbeddingRecords(root, repositoryId, next).catch((cause) => {
                log.warn("HomeSitter semantic progress could not be persisted", { cause })
              })
            },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            current.error = String(cause)
            log.warn("HomeSitter semantic indexing failed; structural and lexical retrieval remain available", {
              cause,
            })
            return current.index ?? hydrated
          }),
        ),
      )
      current.index = semantic
    })

    const start = Effect.fn("HomeSitterAdapter.start")(function* (backend: SemanticBackend) {
      const current = yield* InstanceState.get(state)
      if (current.started) return
      current.started = true
      const ctx = yield* InstanceState.context
      const root = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      yield* build(root, ctx.project.id, backend).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            current.error = String(cause)
            log.warn("HomeSitter indexing failed; structural context remains unavailable", { cause })
          }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    })

    const dynamicContext = Effect.fn("HomeSitterAdapter.dynamicContext")(function* (input: {
      query: string
      tokenBudget: number
    }) {
      const homesitter = (yield* config.get()).experimental?.homesitter
      if (homesitter?.automatic !== true) return []
      if (!input.query.trim()) return []
      const backend = homesitter.semantic_backend ?? "hash"

      yield* start(backend)
      const current = yield* InstanceState.get(state)
      const index = current.index
      if (!index) return []

      const semanticScores =
        backend === "jina-code"
          ? yield* Effect.tryPromise({
              try: () => jinaSemanticScoresFor(index, input.query),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) =>
                Effect.sync(() => {
                  log.warn("HomeSitter Jina query embedding failed; using structural and lexical retrieval", { cause })
                  return {}
                }),
              ),
            )
          : undefined

      return search(index, input.query, {
        limit: Math.max(1, Math.min(12, input.tokenBudget)),
        ...(semanticScores ? { semanticScores } : {}),
      }).map(toContextBlock)
    })

    const status = Effect.fn("HomeSitterAdapter.status")(function* () {
      return (yield* InstanceState.get(state)).index?.status
    })

    return Service.of({ dynamicContext, status })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

function toContextBlock(candidate: Candidate): ContextBlock {
  const text = [
    `path: ${candidate.path}`,
    `range: L${candidate.range.start.line}-L${candidate.range.end.line}`,
    ...(candidate.symbol ? [`symbol: ${candidate.symbol}`] : []),
    `kind: ${candidate.kind}`,
    `scores: structural=${candidate.scores.structural} lexical=${candidate.scores.lexical} semantic=${candidate.scores.semantic} lsp=${candidate.scores.lsp}`,
    `evidence: symbols=${list(candidate.evidence.symbolMatches)} terms=${list(candidate.evidence.matchedTerms)} imports=${list(candidate.evidence.imports)} imported_by=${list(candidate.evidence.importedBy)} related_tests=${list(candidate.evidence.relatedTests)}`,
    `semantic_coverage: ${candidate.semanticCoverage}%`,
  ].join("; ")
  return {
    source: "homesitter",
    text,
    estimatedTokens: Math.max(1, Math.ceil(text.length / 4)),
    priority: Math.round(candidate.relevance * 1_000_000),
  }
}

function list(values: string[]) {
  return values.length === 0 ? "-" : values.join(",")
}

export * as HomeSitterAdapter from "./adapter"
