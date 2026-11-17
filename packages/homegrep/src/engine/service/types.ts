import type { EmbeddingModel } from "../models/index.js";
import type {
  CodeSymbolType,
  WorkspaceIndexPolicy,
  WorkspaceIndexStatus,
  WorkspaceIndexInfo,
  Content,
  EntityMetadata,
  IndexProgress,
  IndexResult,
  Range,
  RootPath,
  SearchPlanRoute,
  SearchHitTrace,
  SearchMatchedBy,
  TimingEntry,
} from "../types.js";

export type CreateHomeGrepOptions = {
  root?: string;
  home?: string;
  embeddingModel?: EmbeddingModel;
  embeddingModelOwnership?: "owned" | "borrowed";
  daemonInstanceToken?: string;
  embedding?: string;
  apiKey?: string;
  endpoint?: string;
  modelCacheDir?: string;
  device?: "auto" | "cpu" | "metal" | "vulkan" | "cuda";
  /** HomeGrep Python project directory when the package assets are staged externally. */
  pythonProject?: string;
  /** Default for index construction and refresh, never for query embeddings. */
  embeddingConcurrency?: number;
  authorizationSigningKeyPath?: string;
};

export type HomeGrepIndexOptions = {
  root?: string;
  rootPaths?: readonly (string | RootPath)[];
  rebuild?: boolean;
  resetPaths?: boolean;
  includePaths?: readonly string[];
  excludePaths?: readonly string[];
  globs?: readonly string[];
  insensitiveGlobs?: readonly string[];
  fileTypes?: readonly string[];
  excludedFileTypes?: readonly string[];
  hidden?: boolean;
  noIgnore?: boolean;
  ignoreFiles?: readonly string[];
  maxDepth?: number;
  maxFileSizeBytes?: number;
  follow?: boolean;
  embeddingConcurrency?: number;
  onProgress?: (progress: IndexProgress) => void;
  changedPaths?: readonly string[];
  signal?: AbortSignal;
  onWriterContext?: (
    context: HomeGrepWriterContext,
  ) => void | (() => void | Promise<void>);
};

export type HomeGrepWriterContext = (
  options: HomeGrepContextOptions,
) => Promise<HomeGrepContextResult>;

export type HomeGrepInfoOptions = {
  root?: string;
  includeStatus?: boolean;
};

export type HomeGrepInfoResult = {
  root: string;
  indexed: boolean;
  indexPolicy: WorkspaceIndexPolicy | "undecided";
  home: string;
  indexPath: string;
  source: "index" | "unindexed";
  workspaceIndex?: WorkspaceIndexInfo;
  status?: WorkspaceIndexStatus | null;
  suggestion?: string;
};

export type HomeGrepContextRoute = SearchPlanRoute;

export type HomeGrepContextOptions = {
  signal?: AbortSignal;
  query?: string;
  queries?: readonly string[];
  rg?: boolean;
  rgOptions?: HomeGrepSearchOptions;
  rgPaths?: readonly string[];
  routes?: readonly HomeGrepContextRoute[];
  /** Fuse every query group into one ranked search plan. */
  fuse?: boolean;
  /** Experimental dense weight from 0 (BM25) to 1 (vectors); undefined uses Semble's default. */
  hybridAlpha?: number;
  root?: string;
  limit?: number;
  autoUpdate?: boolean;
  onAutoUpdateProgress?: (progress: IndexProgress) => void;
  trace?: boolean;
  /** Internal benchmark hook; omitted from normal CLI/MCP requests. */
  benchmarkCandidatePool?: boolean;
  /** Opt-in Semble-derived ranking; HomeGrep RRF remains the default. */
  ranking?: "homegrep" | "semble";
  preferSymbol?: boolean;
  symbolTypes?: readonly CodeSymbolType[];
  includePaths?: readonly string[];
  excludePaths?: readonly string[];
  globs?: readonly string[];
  insensitiveGlobs?: readonly string[];
  fileTypes?: readonly string[];
  excludedFileTypes?: readonly string[];
  hidden?: boolean;
  noIgnore?: boolean;
  ignoreFiles?: readonly string[];
  maxDepth?: number;
  maxFileSizeBytes?: number;
  follow?: boolean;
  modifiedAfter?: number;
  modifiedBefore?: number;
  embeddingConcurrency?: number;
};

export type HomeGrepSearchOptions = {
  extraArgs?: readonly string[];
  patternFiles?: readonly string[];
  fixedStrings?: boolean;
  ignoreCase?: boolean;
  wordRegexp?: boolean;
  beforeContext?: number;
  afterContext?: number;
  hidden?: boolean;
};

export type HomeGrepContextSource = "index" | "rg";

export type HomeGrepContextCoverage =
  "ranked_sample" | "rg_exhaustive" | "rg_truncated";

export type HomeGrepContextFile = {
  absolutePath: string;
  relativePath: string;
  rootPath?: string;
};

export type HomeGrepContextItemKind = "indexed_entity" | "lexical_match";

export type HomeGrepContextContainer = {
  entityId: string;
  range: Range;
  metadata?: EntityMetadata;
};

export type HomeGrepContextQueryGroupMatch = {
  id: string;
  query: string;
  role: "primary" | "supplemental";
  rank: number;
  matchedBy: SearchMatchedBy;
};

export type HomeGrepContextSelectionReason = "coverage" | "global_fill";

export type HomeGrepContextItem = {
  kind: HomeGrepContextItemKind;
  rank: number;
  file: HomeGrepContextFile;
  range: Range;
  excerptRange?: Range;
  content: string;
  contentRole?: "source" | "outline";
  outline?: string;
  status: "fresh" | "possibly_stale";
  score?: number;
  matchedBy: SearchMatchedBy | "lexical";
  metadata?: EntityMetadata;
  entityId?: string;
  container?: HomeGrepContextContainer;
  trace?: SearchHitTrace;
  queryGroups?: readonly HomeGrepContextQueryGroupMatch[];
  selectionReason?: HomeGrepContextSelectionReason;
  coverageGroup?: string;
};

export type HomeGrepContextGroupResult = {
  id: string;
  query: string;
  role: "primary" | "supplemental";
  items: HomeGrepContextItem[];
  benchmarkCandidates?: Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    content: string;
    metadata?: EntityMetadata;
    origins: Array<{
      route: "bm25" | "vector" | "symbolic";
      route_id: string;
      rank: number;
      score: number;
    }>;
  }>;
};

export type HomeGrepContextWorkspaceIndex = {
  id: string;
  name: string;
  path: string;
};

export type HomeGrepRgDiagnostics = {
  backend: "bundled-rg" | "rg";
  command: string;
  args: readonly string[];
  ignoredDirectories: readonly string[];
  missingPaths?: readonly string[];
  searchedPaths?: readonly string[];
  limit?: number;
  truncated: boolean;
};

export type HomeGrepStructureEnrichmentDiagnostics = {
  source: "structural_extraction";
  fileLimit: number;
  matchedFiles: number;
  parsedFiles: number;
  enrichedFiles: number;
  enrichedItems: number;
  skippedFiles: number;
  truncated: boolean;
};

export type HomeGrepIndexDiagnostics = {
  hitsReturned: number;
  queryGroups?: readonly {
    id: string;
    query: string;
    role: "primary" | "supplemental";
  }[];
  routes: readonly {
    id: string;
    mode: "fts" | "vector";
    query: string;
  }[];
};

export type HomeGrepContextDiagnostics = {
  emptyReason?: "no_matches" | "no_searchable_files";
  index?: HomeGrepIndexDiagnostics;
  rg?: HomeGrepRgDiagnostics;
  structure?: HomeGrepStructureEnrichmentDiagnostics;
  timings?: readonly TimingEntry[];
};

export type HomeGrepContextResult = {
  query: string;
  root: string;
  source: HomeGrepContextSource;
  coverage: HomeGrepContextCoverage;
  workspaceIndex?: HomeGrepContextWorkspaceIndex;
  items: HomeGrepContextItem[];
  /** Per-query-group recall lists before cross-group deduplication and reranking. */
  groupResults?: HomeGrepContextGroupResult[];
  diagnostics: HomeGrepContextDiagnostics;
};

export type HomeGrep = {
  readonly root: string;
  index(options?: HomeGrepIndexOptions): Promise<IndexResult>;
  dropIndex(options?: HomeGrepInfoOptions): Promise<boolean>;
  disableIndex(options?: HomeGrepInfoOptions): Promise<HomeGrepInfoResult>;
  info(options?: HomeGrepInfoOptions): Promise<HomeGrepInfoResult>;
  context(options: HomeGrepContextOptions): Promise<HomeGrepContextResult>;
  close(): Promise<void>;
};

export type WorkspaceReadSession = {
  readonly root: string;
  context(options: HomeGrepContextOptions): Promise<HomeGrepContextResult>;
  close(): Promise<void>;
};

export type HomeGrepContent = Content;
