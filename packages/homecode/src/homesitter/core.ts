import path from "path"
import { FileIgnore } from "@/file/ignore"
import { hash } from "@/util/hash"
import { applyEmbeddingRecords, semanticScoresFor } from "./embedding"
import { fallbackStructuralParse, isIndexablePath, languageForPath } from "./structural"
import {
  INDEX_VERSION,
  type Candidate,
  type CandidateEvidence,
  type ExtractedUnit,
  type HomeSitterIndex,
  type IndexOptions,
  type IndexStatus,
  type IndexedFile,
  type LexicalIndex,
  type SearchOptions,
  type SemanticUnit,
  type SourceLanguage,
  type StructuralParser,
  type UnitKind,
} from "./types"

const DEFAULT_MAX_FILE_BYTES = 1_000_000
const BM25_K1 = 1.2
const BM25_B = 0.75
const WEIGHTS = { structural: 0.5, lexical: 0.35, semantic: 0.1, lsp: 0.05 } as const

export async function indexRepository(options: IndexOptions): Promise<HomeSitterIndex> {
  const root = path.resolve(options.root)
  const repositoryId = options.repositoryId ?? root
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const previousFiles = new Map(options.previous?.files.map((file) => [file.path, file]) ?? [])
  const previousUnits = new Map(options.previous?.units.map((unit) => [unit.id, unit]) ?? [])
  const patterns = await gitignorePatterns(root, [".homecode/homesitter/**", ...(options.ignore ?? [])])
  const onStatus = options.onStatus
  const status: IndexStatus = {
    structural: "partial",
    lexical: "unavailable",
    semantic: 0,
    lsp: "unavailable",
    files: 0,
    units: 0,
    reusedFiles: 0,
    reusedUnits: 0,
  }
  onStatus?.(status)

  const files: IndexedFile[] = []
  for await (const relative of new Bun.Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: true })) {
    assertNotAborted(options.signal)
    const normalized = normalizeRelativePath(relative)
    if (!isIndexablePath(normalized) || FileIgnore.match(normalized, patterns)) continue

    const file = Bun.file(path.join(root, relative))
    if (file.size > maxFileBytes) continue
    const source = await file.text().catch(() => undefined)
    if (source === undefined || source.includes("\u0000")) continue

    const sourceHash = hash(source)
    const language = languageForPath(normalized)
    const old = previousFiles.get(normalized)
    if (old?.hash === sourceHash && old.language === language) {
      files.push(old)
      status.reusedFiles++
      status.reusedUnits += old.units.length
      continue
    }

    const parsed = await parse({ path: normalized, language, source }, options.parser)
    const units = parsed.units.map((unit) => makeSemanticUnit(repositoryId, normalized, language, unit, previousUnits))
    status.reusedUnits += units.filter((unit) => previousUnits.has(unit.id)).length
    files.push({
      path: normalized,
      language,
      hash: sourceHash,
      size: file.size,
      imports: [...new Set(parsed.imports)].sort((a, b) => a.localeCompare(b)),
      exports: [...new Set(parsed.exports)].sort((a, b) => a.localeCompare(b)),
      isTest: units.some((unit) => unit.isTest),
      units,
    })
  }

  files.sort((left, right) => left.path.localeCompare(right.path))
  const units = files.flatMap((file) => file.units).sort(compareUnits)
  const importedBy = buildImportedBy(files)
  const lexical = buildLexicalIndex(units)
  const ready: IndexStatus = {
    structural: "ready",
    lexical: "ready",
    semantic: 0,
    lsp: "unavailable",
    files: files.length,
    units: units.length,
    reusedFiles: status.reusedFiles,
    reusedUnits: status.reusedUnits,
  }
  const result = applyEmbeddingRecords(
    {
      version: INDEX_VERSION,
      repositoryId,
      files,
      units,
      importedBy,
      lexical,
      status: ready,
    },
    Object.values(options.previous?.embeddings ?? {}),
  )
  onStatus?.(result.status)
  return result
}

export function search(index: HomeSitterIndex, query: string, options: SearchOptions = {}) {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const allowedPaths = options.paths ? new Set(options.paths.map(normalizeRelativePath)) : undefined
  const allowedKinds = options.kinds ? new Set(options.kinds) : undefined
  const lexicalScores = lexicalScoresFor(index, terms)
  const maxLexical = Math.max(...lexicalScores.values(), 0)
  const maxStructural = Math.max(...index.units.map((unit) => structuralScore(unit, terms)), 0)
  const semanticScores = options.semanticScores ?? index.semanticScores ?? semanticScoresFor(index, query)
  const maxSemantic = Math.max(...Object.values(semanticScores), 0)
  const maxLsp = Math.max(...Object.values(index.lspScores ?? {}), 0)
  const tests = index.units.filter((unit) => unit.isTest).sort(compareUnits)

  return index.units
    .filter((unit) => !allowedPaths || allowedPaths.has(unit.path))
    .filter((unit) => !allowedKinds || allowedKinds.has(unit.kind))
    .map((unit) => {
      const structural = normalizeScore(structuralScore(unit, terms), maxStructural)
      const lexical = normalizeScore(lexicalScores.get(unit.id) ?? 0, maxLexical)
      const semantic = normalizeScore(semanticScores[unit.id] ?? 0, maxSemantic)
      const lsp = normalizeScore(index.lspScores?.[unit.id] ?? 0, maxLsp)
      const evidence = evidenceFor(index, unit, terms, tests)
      const relevance = roundScore(
        structural * WEIGHTS.structural + lexical * WEIGHTS.lexical + semantic * WEIGHTS.semantic + lsp * WEIGHTS.lsp,
      )
      return {
        id: unit.id,
        path: unit.path,
        range: unit.range,
        ...(unit.name ? { symbol: unit.name } : {}),
        kind: unit.kind,
        scores: {
          structural: roundScore(structural),
          lexical: roundScore(lexical),
          semantic: roundScore(semantic),
          lsp: roundScore(lsp),
        },
        relevance,
        evidence,
        symbols: unit.name ? [`${unit.name} L${unit.range.start.line}-L${unit.range.end.line}`] : [],
        semanticCoverage: index.status.semantic,
      } satisfies Candidate
    })
    .filter((candidate) => candidate.relevance > 0)
    .sort(compareCandidates)
    .slice(0, options.limit ?? 20)
}

export function symbol(index: HomeSitterIndex, name: string, options: SearchOptions = {}) {
  const normalized = normalize(name)
  return search(index, name, options).filter((candidate) => normalize(candidate.symbol ?? "").includes(normalized))
}

export function references(index: HomeSitterIndex, name: string, options: SearchOptions = {}) {
  return search(index, name, options)
}

export function relatedFiles(index: HomeSitterIndex, filepath: string) {
  const normalized = normalizeRelativePath(filepath)
  const imported = index.files.find((file) => file.path === normalized)?.imports ?? []
  const importedBy = index.importedBy[normalized] ?? []
  return [
    ...new Set([...importedBy, ...imported.flatMap((specifier) => resolveImport(index, normalized, specifier))]),
  ].sort((a, b) => a.localeCompare(b))
}

export function testsFor(index: HomeSitterIndex, target: string) {
  const normalized = normalizeRelativePath(target)
  const matching = index.units.filter(
    (unit) => unit.isTest && (unit.path === normalized || normalize(unit.name ?? "").includes(normalize(target))),
  )
  if (matching.length > 0) return matching.sort(compareUnits)
  return index.units
    .filter((unit) => unit.isTest && relatedFiles(index, unit.path).includes(normalized))
    .sort(compareUnits)
}

export function indexStatus(index: HomeSitterIndex) {
  return index.status
}

export function serializeIndex(index: HomeSitterIndex, pretty = false) {
  const payload = serializedIndex(index)
  return JSON.stringify(payload, undefined, pretty ? 2 : undefined)
}

export function deserializeIndex(serialized: string): HomeSitterIndex {
  const value: unknown = JSON.parse(serialized)
  if (!isSerializedIndex(value)) throw new Error("Invalid HomeSitter index")
  return value
}

function parse(input: { path: string; language: SourceLanguage; source: string }, parser?: StructuralParser) {
  return Promise.resolve()
    .then(() => parser?.(input) ?? fallbackStructuralParse(input))
    .catch(() => fallbackStructuralParse(input))
}

function makeSemanticUnit(
  repositoryId: string,
  filepath: string,
  language: SourceLanguage,
  unit: ExtractedUnit,
  previousUnits: Map<string, SemanticUnit>,
): SemanticUnit {
  const sourceHash = hash(unit.source)
  const id = hash(
    [
      repositoryId,
      filepath,
      language,
      unit.kind,
      unit.name ?? "",
      unit.parent ?? "",
      unit.range.start.line,
      unit.range.end.line,
      sourceHash,
    ].join("\u0000"),
  )
  const existing = previousUnits.get(id)
  if (existing) return existing
  const searchText = [
    filepath,
    language,
    unit.kind,
    unit.name,
    unit.signature,
    unit.parent,
    ...unit.imports,
    ...unit.exports,
    unit.isTest ? "test" : undefined,
    unit.isConfig ? "config" : undefined,
    unit.source,
  ]
    .filter(Boolean)
    .join(" ")
  return { ...unit, id, path: filepath, language, sourceHash, searchText }
}

function buildLexicalIndex(units: SemanticUnit[]): LexicalIndex {
  const documentFrequency = new Map<string, number>()
  let totalLength = 0
  for (const unit of units) {
    const terms = tokenize(unit.searchText)
    totalLength += terms.length
    for (const term of new Set(terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  }
  return {
    averageDocumentLength: units.length === 0 ? 0 : totalLength / units.length,
    documentFrequency: Object.fromEntries([...documentFrequency].sort(([left], [right]) => left.localeCompare(right))),
  }
}

function lexicalScoresFor(index: HomeSitterIndex, terms: string[]) {
  const documentCount = index.units.length
  const averageLength = index.lexical.averageDocumentLength
  const result = new Map<string, number>()
  for (const unit of index.units) {
    const tokens = tokenize(unit.searchText)
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    let score = 0
    for (const term of terms) {
      const frequency = counts.get(term) ?? 0
      if (!frequency) continue
      const documentFrequency = index.lexical.documentFrequency[term] ?? 0
      const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
      const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / (averageLength || 1)))
      score += idf * ((frequency * (BM25_K1 + 1)) / denominator)
    }
    result.set(unit.id, score)
  }
  return result
}

function structuralScore(unit: SemanticUnit, terms: string[]) {
  const name = normalize(unit.name ?? "")
  const filepath = normalize(unit.path)
  const signature = normalize(unit.signature ?? "")
  const joined = terms.join(" ")
  let score = 0
  for (const term of terms) {
    if (name === term) score = Math.max(score, 1)
    else if (name.includes(term)) score = Math.max(score, 0.85)
    else if (signature.includes(term)) score = Math.max(score, 0.65)
    else if (filepath.includes(term)) score = Math.max(score, 0.45)
    else if (unit.imports.some((item) => normalize(item).includes(term))) score = Math.max(score, 0.35)
    else if (joined.includes(term) && unit.isTest) score = Math.max(score, 0.25)
  }
  return score
}

function evidenceFor(
  index: HomeSitterIndex,
  unit: SemanticUnit,
  terms: string[],
  tests: SemanticUnit[],
): CandidateEvidence {
  const lowerTerms = new Set(terms)
  return {
    symbolMatches: unit.name && terms.every((term) => normalize(unit.name ?? "").includes(term)) ? [unit.name] : [],
    matchedTerms: terms.filter((term) => tokenize(unit.searchText).includes(term)),
    imports: [...unit.imports].sort((a, b) => a.localeCompare(b)),
    importedBy: [...(index.importedBy[unit.path] ?? [])].sort((a, b) => a.localeCompare(b)),
    relatedTests: tests
      .filter(
        (test) =>
          test.path === unit.path ||
          relatedFiles(index, test.path).includes(unit.path) ||
          [...lowerTerms].some((term) => normalize(test.name ?? "").includes(term) && test.path !== unit.path),
      )
      .map((test) => test.path)
      .filter((value, position, values) => values.indexOf(value) === position)
      .sort((left, right) => left.localeCompare(right)),
  }
}

function buildImportedBy(files: IndexedFile[]) {
  const result = new Map<string, Set<string>>()
  for (const file of files) {
    for (const specifier of file.imports) {
      for (const imported of resolveImportFromFiles(files, file.path, specifier)) {
        const consumers = result.get(imported) ?? new Set<string>()
        consumers.add(file.path)
        result.set(imported, consumers)
      }
    }
  }
  return Object.fromEntries(
    [...result]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].sort((left, right) => left.localeCompare(right))]),
  )
}

function resolveImport(index: HomeSitterIndex, filepath: string, specifier: string) {
  return resolveImportFromFiles(index.files, filepath, specifier)
}

function resolveImportFromFiles(files: IndexedFile[], filepath: string, specifier: string) {
  if (!specifier.startsWith(".")) return []
  const normalized = normalizeRelativePath(path.posix.join(path.posix.dirname(filepath), specifier))
  const paths = new Set(files.map((file) => file.path))
  const candidates = [
    normalized,
    ...[".ts", ".tsx", ".js", ".jsx", ".json"].map((extension) => `${normalized}${extension}`),
  ]
  for (const candidate of candidates) {
    if (paths.has(candidate)) return [candidate]
  }
  const indexPath = path.posix.join(normalized, "index.ts")
  return paths.has(indexPath) ? [indexPath] : []
}

async function gitignorePatterns(root: string, additional: string[] = []) {
  const contents = await Bun.file(path.join(root, ".gitignore"))
    .text()
    .catch(() => "")
  const extra: string[] = [...additional]
  const whitelist: string[] = []
  for (const line of contents.split("\n")) {
    const pattern = line.trim()
    if (!pattern || pattern.startsWith("#")) continue
    if (pattern.startsWith("!")) whitelist.push(pattern.slice(1))
    else extra.push(pattern)
  }
  return { extra, whitelist }
}

function serializedIndex(index: HomeSitterIndex) {
  const result: {
    version: number
    repositoryId: string
    files: IndexedFile[]
    units: SemanticUnit[]
    importedBy: Record<string, string[]>
    lexical: LexicalIndex
    status: IndexStatus
    embeddings?: HomeSitterIndex["embeddings"]
    semanticScores?: Record<string, number>
    lspScores?: Record<string, number>
  } = {
    version: index.version,
    repositoryId: index.repositoryId,
    files: [...index.files].sort((left, right) => left.path.localeCompare(right.path)),
    units: [...index.units].sort(compareUnits),
    importedBy: sortedRecordOfArrays(index.importedBy),
    lexical: {
      averageDocumentLength: index.lexical.averageDocumentLength,
      documentFrequency: sortedRecord(index.lexical.documentFrequency),
    },
    status: index.status,
  }
  if (index.embeddings)
    result.embeddings = Object.fromEntries(
      Object.entries(index.embeddings).sort(([left], [right]) => left.localeCompare(right)),
    )
  if (index.semanticScores) result.semanticScores = sortedRecord(index.semanticScores)
  if (index.lspScores) result.lspScores = sortedRecord(index.lspScores)
  return result
}

function isSerializedIndex(value: unknown): value is HomeSitterIndex {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<HomeSitterIndex>
  return (
    candidate.version === INDEX_VERSION &&
    typeof candidate.repositoryId === "string" &&
    Array.isArray(candidate.files) &&
    Array.isArray(candidate.units) &&
    typeof candidate.importedBy === "object" &&
    candidate.importedBy !== null &&
    typeof candidate.lexical === "object" &&
    candidate.lexical !== null &&
    typeof candidate.status === "object" &&
    candidate.status !== null
  )
}

function sortedRecord(value: Record<string, number>) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

function sortedRecordOfArrays(value: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].sort((left, right) => left.localeCompare(right))]),
  )
}

function compareUnits(left: SemanticUnit, right: SemanticUnit) {
  return (
    left.path.localeCompare(right.path) ||
    left.range.start.offset - right.range.start.offset ||
    left.id.localeCompare(right.id)
  )
}

function compareCandidates(left: Candidate, right: Candidate) {
  return (
    right.relevance - left.relevance ||
    right.scores.structural - left.scores.structural ||
    right.scores.lexical - left.scores.lexical ||
    left.path.localeCompare(right.path) ||
    left.range.start.offset - right.range.start.offset ||
    left.id.localeCompare(right.id)
  )
}

function normalizeScore(value: number, maximum: number) {
  return maximum === 0 ? 0 : value / maximum
}

function roundScore(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function tokenize(value: string): string[] {
  return (
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLocaleLowerCase()
      .match(/[a-z0-9_$]+/g) ?? []
  )
}

function normalize(value: string) {
  return tokenize(value).join("")
}

function normalizeRelativePath(value: string) {
  const normalized = value.replaceAll("\\", "/")
  return path.posix.normalize(normalized).replace(/^\.\//, "")
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("HomeSitter indexing aborted")
}

export * as HomeSitterCore from "./core"
