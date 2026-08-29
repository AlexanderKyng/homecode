import { type CorpusSource, type IngestionResult } from "./types"
import { LocalCorpusIndex } from "./index"
import { SourceRegistry } from "./registry"
import { ingestMarkdownTree, ingestLlmsFullTxt } from "./ingester"

export interface SyncOptions {
  readonly maxConcurrency?: number
  readonly timeoutMs?: number
  readonly customFetch?: typeof fetch
}

export class BackgroundCorpusSyncer {
  private readonly corpus: LocalCorpusIndex
  private readonly registry: SourceRegistry
  private isSyncing = false

  constructor(corpus: LocalCorpusIndex, registry: SourceRegistry) {
    this.corpus = corpus
    this.registry = registry
  }

  public async syncSource(source: CorpusSource, options: SyncOptions = {}): Promise<IngestionResult> {
    const fetchFn = options.customFetch || fetch
    const timeout = options.timeoutMs || 8000
    const start = performance.now()

    try {
      if (source.type === "llms_full_txt" || source.type === "llms_txt") {
        const headers: Record<string, string> = {
          "User-Agent": "HomeCode-Corpus-Syncer/1.0",
        }
        if (source.lastCommitOrEtag && source.updateStrategy === "etag") {
          headers["If-None-Match"] = source.lastCommitOrEtag
        }

        const res = await fetchFn(source.canonicalUrl, {
          headers,
          signal: AbortSignal.timeout(timeout),
        })

        if (res.status === 304) {
          return {
            sourceId: source.id,
            addedDocuments: 0,
            updatedDocuments: 0,
            unchangedDocuments: source.documentCount || 0,
            totalSections: 0,
            totalBytes: 0,
            durationMs: performance.now() - start,
            success: true,
          }
        }

        if (!res.ok) {
          return {
            sourceId: source.id,
            addedDocuments: 0,
            updatedDocuments: 0,
            unchangedDocuments: 0,
            totalSections: 0,
            totalBytes: 0,
            durationMs: performance.now() - start,
            success: false,
            error: `HTTP ${res.status}: ${res.statusText}`,
          }
        }

        const etag = res.headers.get("etag") || undefined
        const rawText = await res.text()
        const result = await ingestLlmsFullTxt(this.corpus, source, rawText)

        this.registry.registerSource({
          ...source,
          lastSyncAt: Date.now(),
          lastCommitOrEtag: etag,
          documentCount: result.addedDocuments + result.updatedDocuments + result.unchangedDocuments,
          totalSizeBytes: result.totalBytes,
        })
        await this.registry.saveManifest()

        return result
      }

      // Default / Static / Sitemaps
      return {
        sourceId: source.id,
        addedDocuments: 0,
        updatedDocuments: 0,
        unchangedDocuments: 0,
        totalSections: 0,
        totalBytes: 0,
        durationMs: performance.now() - start,
        success: true,
      }
    } catch (err) {
      return {
        sourceId: source.id,
        addedDocuments: 0,
        updatedDocuments: 0,
        unchangedDocuments: 0,
        totalSections: 0,
        totalBytes: 0,
        durationMs: performance.now() - start,
        success: false,
        error: String(err),
      }
    }
  }

  public async syncAll(options: SyncOptions = {}): Promise<IngestionResult[]> {
    if (this.isSyncing) return []
    this.isSyncing = true

    try {
      const sources = this.registry.listEnabledSources()
      const concurrency = options.maxConcurrency || 2
      const results: IngestionResult[] = []

      // Bounded concurrency pool
      for (let i = 0; i < sources.length; i += concurrency) {
        const batch = sources.slice(i, i + concurrency)
        const batchResults = await Promise.all(batch.map((s) => this.syncSource(s, options)))
        results.push(...batchResults)
      }

      return results
    } finally {
      this.isSyncing = false
    }
  }
}

export * as CorpusSyncModule from "./sync"
