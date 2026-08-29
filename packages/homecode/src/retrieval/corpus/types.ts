export type SourceType =
  | "git_repository"
  | "documentation_site"
  | "llms_txt"
  | "llms_full_txt"
  | "markdown_tree"
  | "sitemap"
  | "release_feed"

export type AuthorityLevel = "official" | "trusted" | "community"

export type DiscoveredBy = "manual" | "benchmark" | "agent_usage" | "provider"

export type UpdateStrategy = "etag" | "git_commit" | "content_hash" | "sitemap" | "manual"

export interface CorpusSource {
  readonly id: string
  readonly name: string
  readonly type: SourceType
  readonly canonicalUrl: string
  readonly project?: string
  readonly version?: string
  readonly authority: AuthorityLevel
  readonly updateStrategy: UpdateStrategy
  readonly includePatterns?: readonly string[]
  readonly excludePatterns?: readonly string[]
  readonly enabled: boolean
  readonly discoveredBy: DiscoveredBy
  readonly priority: number
  readonly lastSyncAt?: number
  readonly lastCommitOrEtag?: string
  readonly documentCount?: number
  readonly totalSizeBytes?: number
}

export interface CorpusDocument {
  readonly url: string
  readonly sourceId: string
  readonly project: string
  readonly version?: string
  readonly title: string
  readonly documentPath?: string
  readonly headings: string
  readonly content: string
  readonly codeBlocks: string
  readonly contentHash: string
  readonly etag?: string
  readonly lastModified?: string
  readonly authority: AuthorityLevel
  readonly updatedAt: number
  readonly accessCount: number
  readonly lastAccessedAt?: number
  readonly successfulRetrievalCount: number
}

export interface CorpusSection {
  readonly id: string
  readonly documentUrl: string
  readonly sourceId: string
  readonly project: string
  readonly version?: string
  readonly headingHierarchy: string
  readonly sectionTitle: string
  readonly sectionIndex: number
  readonly content: string
  readonly codeBlocks: string
  readonly tokenEstimate: number
}

export interface SearchCorpusOptions {
  readonly limit?: number
  readonly project?: string
  readonly version?: string
  readonly minScore?: number
  readonly includeSections?: boolean
}

export interface CorpusSearchResult {
  readonly url: string
  readonly title: string
  readonly project: string
  readonly version?: string
  readonly snippet: string
  readonly headings: string
  readonly codeBlocks: string
  readonly bm25Rank: number
  readonly score: number
  readonly authority: AuthorityLevel
  readonly matchedSection?: {
    readonly headingHierarchy: string
    readonly content: string
  }
}

export interface CorpusMissAnalysis {
  readonly query: string
  readonly category: string
  readonly split: "train" | "dev" | "test"
  readonly targetDomain: string
  readonly failureReason:
    | "documentation_not_indexed"
    | "repository_docs_not_indexed"
    | "deep_repo_file_missing"
    | "github_issue_missing"
    | "stackoverflow_content_missing"
    | "version_specific_docs_missing"
    | "release_notes_changelog_missing"
    | "academic_paper"
    | "query_vocabulary_mismatch"
    | "lexical_fts_failure_present_locally"
    | "source_fetched_not_promoted"
    | "other"
  readonly suggestedSource?: CorpusSource
}

export interface IngestionResult {
  readonly sourceId: string
  readonly addedDocuments: number
  readonly updatedDocuments: number
  readonly unchangedDocuments: number
  readonly totalSections: number
  readonly totalBytes: number
  readonly durationMs: number
  readonly success: boolean
  readonly error?: string
}

export * as CorpusTypes from "./types"
