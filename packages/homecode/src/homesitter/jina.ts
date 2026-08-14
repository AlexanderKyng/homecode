import path from "path"
import { mkdir } from "node:fs/promises"
import { Global } from "@homecode-ai/core/global"
import { INPUT_REPRESENTATION_VERSION } from "./types"
import { SEMANTIC_STATE_PATH } from "./embedding"
import type { EmbeddingRecord, HomeSitterIndex, SemanticUnit } from "./types"

export const JINA_CODE_MODEL_ID = "jinaai/jina-embeddings-v2-base-code"
export const JINA_CODE_MODEL_VERSION = "1"
export const JINA_CODE_DIMENSIONS = 768
export const JINA_CODE_RECORD_VERSION = 1

type SemanticState = {
  version: number
  repositoryId: string
  modelId: string
  modelVersion: string
  representationVersion: number
  dimensions: number
  records: EmbeddingRecord[]
}

type JinaPipeline = {
  (
    texts: string | string[],
    options?: { pooling?: "none" | "mean"; normalize?: boolean },
  ): Promise<{ tolist(): unknown }>
}

let pipelinePromise: Promise<JinaPipeline> | undefined
let pipelineState: "idle" | "loading" | "ready" | "failed" = "idle"

export function jinaEncoderReady() {
  return pipelineState === "ready"
}

export async function indexJinaSemantic(
  index: HomeSitterIndex,
  options: {
    batchSize?: number
    signal?: AbortSignal
    onProgress?: (index: HomeSitterIndex) => void | Promise<void>
  } = {},
) {
  const records = { ...(index.embeddings ?? {}) }
  const batchSize = Math.max(1, Math.min(16, Math.floor(options.batchSize ?? 4)))
  const pending = index.units.filter((unit) => !isCurrentJinaEmbedding(records[unit.id], unit))
  let current = withJinaEmbeddingStatus(index, records)
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    assertNotAborted(options.signal)
    const batch = pending.slice(offset, offset + batchSize)
    const vectors = await encodeTexts(batch.map((unit) => unit.searchText))
    assertNotAborted(options.signal)
    if (vectors.length !== batch.length) throw new Error("Jina embedding batch size mismatch")
    batch.forEach((unit, index) => {
      records[unit.id] = makeJinaEmbedding(unit, vectors[index])
    })
    current = withJinaEmbeddingStatus(index, records)
    await options.onProgress?.(current)
    if (offset + batchSize < pending.length) await yieldToInteractiveWork()
  }
  assertNotAborted(options.signal)
  return current
}

export function applyJinaEmbeddingRecords(index: HomeSitterIndex, records: EmbeddingRecord[]) {
  const units = new Map(index.units.map((unit) => [unit.id, unit]))
  const embeddings = Object.fromEntries(
    records
      .filter((record) => {
        const unit = units.get(record.unitId)
        return unit !== undefined && isCompatibleJinaEmbedding(record) && record.sourceHash === unit.sourceHash
      })
      .sort((left, right) => left.unitId.localeCompare(right.unitId))
      .map((record) => [record.unitId, record]),
  )
  return withJinaEmbeddingStatus(index, embeddings)
}

export async function loadJinaEmbeddingRecords(root: string, repositoryId: string) {
  const value: unknown = await Bun.file(path.join(root, SEMANTIC_STATE_PATH))
    .json()
    .catch(() => undefined)
  if (!isSemanticState(value) || value.repositoryId !== repositoryId) return []
  return value.records.filter(isCompatibleJinaEmbedding)
}

export async function saveJinaEmbeddingRecords(root: string, repositoryId: string, index: HomeSitterIndex) {
  const state: SemanticState = {
    version: JINA_CODE_RECORD_VERSION,
    repositoryId,
    modelId: JINA_CODE_MODEL_ID,
    modelVersion: JINA_CODE_MODEL_VERSION,
    representationVersion: INPUT_REPRESENTATION_VERSION,
    dimensions: JINA_CODE_DIMENSIONS,
    records: Object.values(index.embeddings ?? {}).sort((left, right) => left.unitId.localeCompare(right.unitId)),
  }
  const filename = path.join(root, SEMANTIC_STATE_PATH)
  await mkdir(path.dirname(filename), { recursive: true })
  await Bun.write(filename, `${JSON.stringify(state, undefined, 2)}\n`)
}

export async function jinaSemanticScoresFor(index: HomeSitterIndex, query: string) {
  if (!jinaEncoderReady()) return {}
  const records = Object.entries(index.embeddings ?? {}).filter(([unitId, record]) => {
    const unit = index.units.find((candidate) => candidate.id === unitId)
    return unit !== undefined && isCurrentJinaEmbedding(record, unit)
  })
  if (records.length === 0) return {}
  const [queryVector] = await encodeTexts([query])
  return Object.fromEntries(
    records.map(([unitId, record]) => [unitId, Math.max(0, cosineSimilarity(queryVector, record.vector))]),
  )
}

async function encodeTexts(texts: string[]) {
  const extractor = await loadJinaPipeline()
  const output = await extractor(texts, { pooling: "mean", normalize: true })
  return vectorsFrom(output.tolist())
}

async function loadJinaPipeline() {
  if (pipelinePromise) return pipelinePromise
  pipelineState = "loading"
  pipelinePromise = import("@huggingface/transformers")
    .then(async ({ pipeline }) => {
      const extractor = await pipeline("feature-extraction", JINA_CODE_MODEL_ID, {
        device: "cpu",
        dtype: "fp32",
        cache_dir: path.join(Global.Path.data, "homesitter", "models"),
      })
      return extractor as unknown as JinaPipeline
    })
    .then((extractor) => {
      pipelineState = "ready"
      return extractor
    })
    .catch((cause) => {
      pipelinePromise = undefined
      pipelineState = "failed"
      throw cause
    })
  return pipelinePromise
}

function makeJinaEmbedding(unit: SemanticUnit, vector: number[]): EmbeddingRecord {
  return {
    unitId: unit.id,
    sourceHash: unit.sourceHash,
    modelId: JINA_CODE_MODEL_ID,
    modelVersion: JINA_CODE_MODEL_VERSION,
    representationVersion: INPUT_REPRESENTATION_VERSION,
    dimensions: JINA_CODE_DIMENSIONS,
    vector,
  }
}

function vectorsFrom(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(Array.isArray)) {
    throw new Error("Jina embedding output must be a non-empty matrix")
  }
  const vectors = value.map((row) => {
    if (!row.every((item): item is number => typeof item === "number" && Number.isFinite(item))) {
      throw new Error("Jina embedding output contains a non-finite value")
    }
    return [...row]
  })
  const dimensions = vectors[0].length
  if (dimensions !== JINA_CODE_DIMENSIONS || vectors.some((vector) => vector.length !== dimensions)) {
    throw new Error("Jina embedding output has an unexpected dimensionality")
  }
  return vectors
}

function withJinaEmbeddingStatus(index: HomeSitterIndex, embeddings: Record<string, EmbeddingRecord>) {
  return {
    ...index,
    embeddings: Object.fromEntries(Object.entries(embeddings).sort(([left], [right]) => left.localeCompare(right))),
    status: {
      ...index.status,
      semantic: coverage(index.units.length, embeddings),
    },
  }
}

function isCurrentJinaEmbedding(record: EmbeddingRecord | undefined, unit: SemanticUnit) {
  return (
    record !== undefined &&
    isCompatibleJinaEmbedding(record) &&
    record.unitId === unit.id &&
    record.sourceHash === unit.sourceHash
  )
}

function isCompatibleJinaEmbedding(value: unknown): value is EmbeddingRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<EmbeddingRecord>
  return (
    typeof record.unitId === "string" &&
    typeof record.sourceHash === "string" &&
    record.modelId === JINA_CODE_MODEL_ID &&
    record.modelVersion === JINA_CODE_MODEL_VERSION &&
    record.representationVersion === INPUT_REPRESENTATION_VERSION &&
    record.dimensions === JINA_CODE_DIMENSIONS &&
    Array.isArray(record.vector) &&
    record.vector.length === JINA_CODE_DIMENSIONS &&
    record.vector.every((item) => typeof item === "number" && Number.isFinite(item))
  )
}

function isSemanticState(value: unknown): value is SemanticState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<SemanticState>
  return (
    state.version === JINA_CODE_RECORD_VERSION &&
    typeof state.repositoryId === "string" &&
    state.modelId === JINA_CODE_MODEL_ID &&
    state.modelVersion === JINA_CODE_MODEL_VERSION &&
    state.representationVersion === INPUT_REPRESENTATION_VERSION &&
    state.dimensions === JINA_CODE_DIMENSIONS &&
    Array.isArray(state.records)
  )
}

function coverage(unitCount: number, embeddings: Record<string, EmbeddingRecord>) {
  if (unitCount === 0) return 0
  return Math.round((Object.keys(embeddings).length / unitCount) * 100)
}

function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    dot += left[index] * right[index]
    leftMagnitude += left[index] * left[index]
    rightMagnitude += right[index] * right[index]
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0
  return dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("HomeSitter semantic indexing aborted")
}

async function yieldToInteractiveWork() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export * as HomeSitterJina from "./jina"
