import path from "path"
import { mkdir } from "node:fs/promises"
import { hash } from "@/util/hash"
import { INPUT_REPRESENTATION_VERSION } from "./types"
import type { EmbeddingRecord, HomeSitterIndex, SemanticUnit } from "./types"

export const EMBEDDING_MODEL_ID = "homesitter-feature"
export const EMBEDDING_MODEL_VERSION = "1"
export const EMBEDDING_DIMENSIONS = 128
export const EMBEDDING_RECORD_VERSION = 1
export const SEMANTIC_STATE_PATH = ".homecode/homesitter/semantic.json"

type SemanticState = {
  version: number
  repositoryId: string
  modelId: string
  modelVersion: string
  representationVersion: number
  dimensions: number
  records: EmbeddingRecord[]
}

export function embedUnit(unit: SemanticUnit): EmbeddingRecord {
  return {
    unitId: unit.id,
    sourceHash: unit.sourceHash,
    modelId: EMBEDDING_MODEL_ID,
    modelVersion: EMBEDDING_MODEL_VERSION,
    representationVersion: INPUT_REPRESENTATION_VERSION,
    dimensions: EMBEDDING_DIMENSIONS,
    vector: embedText(unit.searchText),
  }
}

export function embedText(value: string) {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0)
  const tokens = tokenize(value)
  for (const token of tokens) {
    addFeature(vector, token, 1)
    for (let index = 0; index < token.length - 2; index++) addFeature(vector, token.slice(index, index + 3), 0.35)
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (magnitude === 0) return vector
  return vector.map((value) => value / magnitude)
}

export function semanticScoresFor(index: HomeSitterIndex, query: string) {
  const queryVector = embedText(query)
  return Object.fromEntries(
    Object.entries(index.embeddings ?? {})
      .filter(([unitId, record]) => isCompatibleEmbedding(record) && index.units.some((unit) => unit.id === unitId))
      .map(([unitId, record]) => [unitId, Math.max(0, cosineSimilarity(queryVector, record.vector))]),
  )
}

export function applyEmbeddingRecords(index: HomeSitterIndex, records: EmbeddingRecord[]) {
  const units = new Map(index.units.map((unit) => [unit.id, unit]))
  const embeddings = Object.fromEntries(
    records
      .filter((record) => {
        const unit = units.get(record.unitId)
        return unit !== undefined && isCompatibleEmbedding(record) && record.sourceHash === unit.sourceHash
      })
      .sort((left, right) => left.unitId.localeCompare(right.unitId))
      .map((record) => [record.unitId, record]),
  )
  return withEmbeddingStatus(index, embeddings)
}

export async function indexSemantic(
  index: HomeSitterIndex,
  options: {
    batchSize?: number
    signal?: AbortSignal
    onProgress?: (index: HomeSitterIndex) => void | Promise<void>
  } = {},
) {
  const records = { ...(index.embeddings ?? {}) }
  const batchSize = Math.max(1, Math.min(64, Math.floor(options.batchSize ?? 16)))
  const pending = index.units.filter((unit) => !isCurrentEmbedding(records[unit.id], unit))
  let current = withEmbeddingStatus(index, records)
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    assertNotAborted(options.signal)
    for (const unit of pending.slice(offset, offset + batchSize)) records[unit.id] = embedUnit(unit)
    current = withEmbeddingStatus(index, records)
    await options.onProgress?.(current)
    if (offset + batchSize < pending.length) await yieldToInteractiveWork()
  }
  assertNotAborted(options.signal)
  return current
}

export async function loadEmbeddingRecords(root: string, repositoryId: string) {
  const value: unknown = await Bun.file(path.join(root, SEMANTIC_STATE_PATH))
    .json()
    .catch(() => undefined)
  if (!isSemanticState(value) || value.repositoryId !== repositoryId) return []
  return value.records.filter(isCompatibleEmbedding)
}

export async function saveEmbeddingRecords(root: string, repositoryId: string, index: HomeSitterIndex) {
  const state: SemanticState = {
    version: EMBEDDING_RECORD_VERSION,
    repositoryId,
    modelId: EMBEDDING_MODEL_ID,
    modelVersion: EMBEDDING_MODEL_VERSION,
    representationVersion: INPUT_REPRESENTATION_VERSION,
    dimensions: EMBEDDING_DIMENSIONS,
    records: Object.values(index.embeddings ?? {}).sort((left, right) => left.unitId.localeCompare(right.unitId)),
  }
  const filename = path.join(root, SEMANTIC_STATE_PATH)
  await mkdir(path.dirname(filename), { recursive: true })
  await Bun.write(filename, `${JSON.stringify(state, undefined, 2)}\n`)
}

export function isCompatibleEmbedding(value: unknown): value is EmbeddingRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<EmbeddingRecord>
  return (
    typeof record.unitId === "string" &&
    typeof record.sourceHash === "string" &&
    record.modelId === EMBEDDING_MODEL_ID &&
    record.modelVersion === EMBEDDING_MODEL_VERSION &&
    record.representationVersion === INPUT_REPRESENTATION_VERSION &&
    record.dimensions === EMBEDDING_DIMENSIONS &&
    Array.isArray(record.vector) &&
    record.vector.length === EMBEDDING_DIMENSIONS &&
    record.vector.every((value) => typeof value === "number" && Number.isFinite(value))
  )
}

function withEmbeddingStatus(index: HomeSitterIndex, embeddings: Record<string, EmbeddingRecord>) {
  return {
    ...index,
    embeddings: Object.fromEntries(Object.entries(embeddings).sort(([left], [right]) => left.localeCompare(right))),
    status: {
      ...index.status,
      semantic: coverage(index.units.length, embeddings),
    },
  }
}

function isCurrentEmbedding(record: EmbeddingRecord | undefined, unit: SemanticUnit) {
  return (
    record !== undefined &&
    isCompatibleEmbedding(record) &&
    record.unitId === unit.id &&
    record.sourceHash === unit.sourceHash
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

function addFeature(vector: number[], feature: string, weight: number) {
  const digest = hash(`${EMBEDDING_MODEL_ID}\u0000${feature}`)
  const dimension = Number.parseInt(digest.slice(0, 8), 16) % EMBEDDING_DIMENSIONS
  const sign = Number.parseInt(digest.slice(8, 10), 16) % 2 === 0 ? 1 : -1
  vector[dimension] += sign * weight
}

function tokenize(value: string) {
  return (
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9_$]+/g) ?? []
  )
}

function isSemanticState(value: unknown): value is SemanticState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<SemanticState>
  return (
    state.version === EMBEDDING_RECORD_VERSION &&
    typeof state.repositoryId === "string" &&
    state.modelId === EMBEDDING_MODEL_ID &&
    state.modelVersion === EMBEDDING_MODEL_VERSION &&
    state.representationVersion === INPUT_REPRESENTATION_VERSION &&
    state.dimensions === EMBEDDING_DIMENSIONS &&
    Array.isArray(state.records)
  )
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("HomeSitter semantic indexing aborted")
}

async function yieldToInteractiveWork() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export * as HomeSitterEmbedding from "./embedding"
