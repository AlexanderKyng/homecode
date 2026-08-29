import { Global } from "@homecode-ai/core/global"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"

export interface CandidateTelemetry {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly engine: string
  readonly rawRank: number
  readonly fusionScore?: number
  readonly rerankScore?: number
  readonly rerankRank?: number
}

export interface FetchTelemetry {
  readonly url: string
  readonly status: number
  readonly success: boolean
  readonly latencyMs: number
  readonly staticExtractionConfidence: number
  readonly playwrightFallbackUsed: boolean
  readonly extractedContentLength: number
}

export interface PassageTelemetry {
  readonly text: string
  readonly isCode: boolean
  readonly score: number
  readonly selected: boolean
}

export interface StageLatencies {
  readonly discoveryMs: number
  readonly dedupeMs: number
  readonly rerankMs: number
  readonly fetchMs: number
  readonly extractMs: number
  readonly highlightMs: number
  readonly totalMs: number
}

export interface RetrievalTrace {
  readonly id: string
  readonly timestamp: string
  readonly tool: "websearch" | "codesearch" | "webfetch"
  readonly query: string
  readonly classifiedIntent?: string
  readonly selectedEngines?: readonly string[]
  readonly searchMode?: string
  readonly rawCandidateCount: number
  readonly deduplicatedCandidateCount: number
  readonly candidates: readonly CandidateTelemetry[]
  readonly fetchAttempts: readonly FetchTelemetry[]
  readonly passages: readonly PassageTelemetry[]
  readonly cacheHit: boolean
  readonly stageLatencies: StageLatencies
  readonly outputCharacters: number
  readonly outputTokenEstimate: number
  readonly triplets?: ReadonlyArray<{
    readonly query: string
    readonly positiveUrl?: string
    readonly hardNegativeUrl?: string
    readonly positivePassage?: string
    readonly hardNegativePassage?: string
  }>
}

export interface Interface {
  readonly recordTrace: (trace: RetrievalTrace) => Effect.Effect<void>
  readonly getRecentTraces: (limit?: number) => Effect.Effect<ReadonlyArray<RetrievalTrace>>
  readonly exportTriplets: () => Effect.Effect<ReadonlyArray<Record<string, unknown>>>
}

export function makeTelemetry(logDir?: string): Interface {
  const telemetryDir = logDir ?? path.join(Global.Path.data, "telemetry", "retrieval")
  const telemetryFile = path.join(telemetryDir, "traces.jsonl")

  const ensureDir = async () => {
    await fs.mkdir(telemetryDir, { recursive: true }).catch(() => {})
  }

  return {
    recordTrace: (trace: RetrievalTrace) =>
      Effect.promise(async () => {
        try {
          await ensureDir()
          const line = JSON.stringify(trace) + "\n"
          await fs.appendFile(telemetryFile, line, "utf8")
        } catch {
          // Non-blocking telemetry logging
        }
      }),

    getRecentTraces: (limit = 100) =>
      Effect.promise(async () => {
        try {
          const content = await fs.readFile(telemetryFile, "utf8").catch(() => "")
          if (!content.trim()) return []
          const lines = content.trim().split("\n").filter(Boolean)
          const parsed = lines
            .slice(-limit)
            .map((line) => {
              try {
                return JSON.parse(line) as RetrievalTrace
              } catch {
                return null
              }
            })
            .filter((t): t is RetrievalTrace => t !== null)
          return parsed
        } catch {
          return []
        }
      }),

    exportTriplets: () =>
      Effect.promise(async () => {
        try {
          const content = await fs.readFile(telemetryFile, "utf8").catch(() => "")
          if (!content.trim()) return []
          const lines = content.trim().split("\n").filter(Boolean)
          const triplets: Array<Record<string, unknown>> = []

          for (const line of lines) {
            try {
              const trace = JSON.parse(line) as RetrievalTrace
              if (trace.triplets && trace.triplets.length > 0) {
                triplets.push(...trace.triplets)
              } else if (trace.candidates.length >= 2) {
                // Synthesize ranking pairs from top-1 vs lower candidates
                const top1 = trace.candidates[0]
                const lower = trace.candidates.slice(2, 6)
                for (const neg of lower) {
                  triplets.push({
                    query: trace.query,
                    positive_title: top1.title,
                    positive_url: top1.url,
                    positive_snippet: top1.snippet,
                    negative_title: neg.title,
                    negative_url: neg.url,
                    negative_snippet: neg.snippet,
                    positive_score: top1.rerankScore,
                    negative_score: neg.rerankScore,
                  })
                }
              }
            } catch {
              // skip invalid line
            }
          }
          return triplets
        } catch {
          return []
        }
      }),
  }
}

export * as RetrievalTelemetry from "./telemetry"
