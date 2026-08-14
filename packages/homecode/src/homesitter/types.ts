export const INDEX_VERSION = 1
export const INPUT_REPRESENTATION_VERSION = 1

export type SourceLanguage =
  | "bash"
  | "c"
  | "cpp"
  | "csharp"
  | "go"
  | "java"
  | "javascript"
  | "json"
  | "kotlin"
  | "markdown"
  | "powershell"
  | "python"
  | "rust"
  | "swift"
  | "toml"
  | "typescript"
  | "yaml"
  | "unknown"

export type UnitKind =
  | "class"
  | "config"
  | "declaration"
  | "enum"
  | "function"
  | "interface"
  | "method"
  | "module"
  | "test"
  | "type"

export type SemanticBackend = "off" | "hash" | "jina-code"

export type Position = {
  line: number
  column: number
  offset: number
}

export type SourceRange = {
  start: Position
  end: Position
}

export type ExtractedUnit = {
  kind: UnitKind
  name?: string
  signature?: string
  parent?: string
  range: SourceRange
  source: string
  imports: string[]
  exports: string[]
  isTest: boolean
  isConfig: boolean
}

export type StructuralParseResult = {
  units: ExtractedUnit[]
  imports: string[]
  exports: string[]
}

export type StructuralParser = (input: {
  path: string
  language: SourceLanguage
  source: string
}) => StructuralParseResult | Promise<StructuralParseResult>

export type SemanticUnit = Omit<ExtractedUnit, "source"> & {
  id: string
  path: string
  language: SourceLanguage
  sourceHash: string
  searchText: string
}

export type EmbeddingRecord = {
  unitId: string
  sourceHash: string
  modelId: string
  modelVersion: string
  representationVersion: number
  dimensions: number
  vector: number[]
}

export type IndexedFile = {
  path: string
  language: SourceLanguage
  hash: string
  size: number
  imports: string[]
  exports: string[]
  isTest: boolean
  units: SemanticUnit[]
}

export type IndexStatus = {
  structural: "ready" | "partial" | "unavailable"
  lexical: "ready" | "partial" | "unavailable"
  semantic: number
  lsp: "available" | "unavailable" | "partial"
  files: number
  units: number
  reusedFiles: number
  reusedUnits: number
}

export type LexicalIndex = {
  averageDocumentLength: number
  documentFrequency: Record<string, number>
}

export type HomeSitterIndex = {
  version: number
  repositoryId: string
  files: IndexedFile[]
  units: SemanticUnit[]
  importedBy: Record<string, string[]>
  lexical: LexicalIndex
  status: IndexStatus
  embeddings?: Record<string, EmbeddingRecord>
  semanticScores?: Record<string, number>
  lspScores?: Record<string, number>
}

export type IndexOptions = {
  root: string
  repositoryId?: string
  parser?: StructuralParser
  ignore?: string[]
  previous?: HomeSitterIndex
  signal?: AbortSignal
  maxFileBytes?: number
  onStatus?: (status: IndexStatus) => void
}

export type SearchOptions = {
  limit?: number
  paths?: string[]
  kinds?: UnitKind[]
  semanticScores?: Record<string, number>
}

export type SourceScores = {
  structural: number
  lexical: number
  semantic: number
  lsp: number
}

export type CandidateEvidence = {
  symbolMatches: string[]
  matchedTerms: string[]
  imports: string[]
  importedBy: string[]
  relatedTests: string[]
}

export type Candidate = {
  id: string
  path: string
  range: SourceRange
  symbol?: string
  kind: UnitKind
  scores: SourceScores
  relevance: number
  evidence: CandidateEvidence
  symbols: string[]
  semanticCoverage: number
}

export type SerializedHomeSitterIndex = {
  version: number
  repositoryId: string
  files: IndexedFile[]
  units: SemanticUnit[]
  importedBy: Record<string, string[]>
  lexical: LexicalIndex
  status: IndexStatus
  embeddings?: Record<string, EmbeddingRecord>
  semanticScores?: Record<string, number>
  lspScores?: Record<string, number>
}
