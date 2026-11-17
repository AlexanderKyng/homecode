import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { runRgSearch } from "./lexical.js";
import { resolveHomeGrepRoot } from "./root.js";
import { readGlobalConfig } from "../config.js";
import { enrichLexicalItemsWithStructure } from "./structure-enrichment.js";
import { assertDaemonWriteAllowed } from "../utils/daemon-lease.js";
import { mergeQueryGroups } from "./query-groups.js";
import type {
  CreateHomeGrepOptions,
  HomeGrep,
  HomeGrepContextItem,
  HomeGrepContextOptions,
  HomeGrepContextResult,
  HomeGrepInfoOptions,
  HomeGrepInfoResult,
} from "./types.js";
import type {
  FileScanDiagnostics,
  IndexResult,
  RootPath,
  WorkspaceIndexInfo,
} from "../types.js";
import {
  acquireSembleRuntime,
  type SembleChunk,
  type SembleSearchResult,
} from "../semble/runtime.js";

const DEFAULT_POTION = "minishlab/potion-code-16M-v2";

/** HomeGrep product service backed by the pinned Semble runtime. */
export class SembleGrepService implements HomeGrep {
  readonly root: string;
  private readonly stateRoot: string;
  private readonly modelCacheDir?: string;
  private readonly daemonInstanceToken?: string;
  private readonly runtimeLease: ReturnType<typeof acquireSembleRuntime>;
  private closed = false;

  constructor(options: CreateHomeGrepOptions = {}) {
    this.root = resolveHomeGrepRoot(options.root);
    this.stateRoot = resolve(
      process.env.HOMEGREP_HOME ??
        (options.home
          ? join(resolve(options.home), "homegrep-semble")
          : join(homedir(), ".homegrep")),
    );
    this.modelCacheDir =
      options.modelCacheDir ?? readGlobalConfig().defaults?.modelCacheDir;
    this.daemonInstanceToken = options.daemonInstanceToken;
    if (options.endpoint || options.apiKey) {
      throw new Error(
        "Remote embedding providers are not supported by the Semble runtime",
      );
    }
    if (options.embeddingModel) {
      throw new Error(
        "Custom in-process embedding models are not supported by the pinned Semble runtime",
      );
    }
    if (
      options.device === "cuda" ||
      options.device === "metal" ||
      options.device === "vulkan"
    ) {
      throw new Error(
        "The Semble migration currently supports CPU inference only",
      );
    }
    if (options.embedding) {
      const reference = options.embedding
        .trim()
        .toLowerCase()
        .replace(/^local\//, "");
      if (reference !== "potion-code-16m-v2" && reference !== DEFAULT_POTION) {
        throw new Error(
          "The pinned Semble runtime currently supports Potion-Code-16M-v2 only",
        );
      }
    }
    this.runtimeLease = acquireSembleRuntime(this.stateRoot, options.pythonProject);
  }

  async index(
    options: Parameters<HomeGrep["index"]>[0] = {},
  ): Promise<IndexResult> {
    this.ensureOpen();
    if (options.signal?.aborted)
      throw options.signal.reason ?? new Error("Indexing cancelled");
    const root = resolveHomeGrepRoot(options.root ?? this.root);
    const rootPaths = options.rootPaths?.map((path) =>
      typeof path === "string" ? { absolutePath: path, recursive: true } : path,
    );
    if (options.resetPaths) {
      throw new Error(
        "Resetting a filtered index scope is not supported by the pinned Semble walker",
      );
    }
    if (options.embeddingConcurrency !== undefined) {
      throw new Error(
        "Custom embedding concurrency is not supported by the pinned Semble indexer",
      );
    }
    if (
      rootPaths?.some(
        (path) =>
          resolve(path.absolutePath) !== root ||
          path.recursive !== true ||
          Boolean(
            path.include?.length ||
            path.exclude?.length ||
            path.globs?.length ||
            path.insensitiveGlobs?.length ||
            path.fileTypes?.length ||
            path.excludedFileTypes?.length ||
            path.hidden ||
            path.noIgnore ||
            path.ignoreFiles?.length ||
            path.maxDepth !== undefined ||
            path.maxFileSizeBytes !== undefined ||
            path.follow,
          ),
      )
    ) {
      throw new Error(
        "Custom index scopes are not yet supported by the pinned Semble walker",
      );
    }
    if (
      options.includePaths?.length ||
      options.excludePaths?.length ||
      options.globs?.length ||
      options.insensitiveGlobs?.length ||
      options.fileTypes?.length ||
      options.excludedFileTypes?.length ||
      options.hidden ||
      options.noIgnore ||
      options.ignoreFiles?.length ||
      options.maxDepth !== undefined ||
      options.maxFileSizeBytes !== undefined ||
      options.follow
    ) {
      throw new Error(
        "Custom index filters are not yet supported by the pinned Semble walker",
      );
    }
    const writeGuard = assertDaemonWriteAllowed(root, this.daemonInstanceToken);
    try {
      options.onProgress?.({
        phase: "scanning",
        detail: "Semble is discovering workspace files",
      });
      if (options.signal?.aborted)
        throw options.signal.reason ?? new Error("Indexing cancelled");
      const started = performance.now();
      let result;
      try {
        result = await this.runtimeLease.runtime.index(root, {
          rebuild: options.rebuild,
          modelCacheDir: this.modelCacheDir,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          /No supported files found under/.test(error.message)
        ) {
          throw new Error(
            "No indexable files were found. Run `hg --help file-types` to review supported file types and indexing rules.",
            { cause: error },
          );
        }
        throw error;
      }
      // Once the bridge request starts, wait for its transaction result so an
      // already published generation is reported as successful.
      const durationMs = performance.now() - started;
      options.onProgress?.({
        phase: "done",
        filesIndexed: result.files,
        filesTotal: result.files,
      });
      return {
        filesScanned: result.files,
        filesAdded: result.files_added,
        filesModified: result.files_modified,
        filesPending: 0,
        filesDeleted: result.files_deleted,
        filesUnchanged: result.files_unchanged,
        filesFailed: 0,
        entitiesCreated: result.chunks,
        durationMs,
        timings: [{ name: "semble_index", durationMs }],
        scanDiagnostics: result.scan_diagnostics
          ? ({
              skippedFiles: result.scan_diagnostics.skipped_files,
              skippedByReason: result.scan_diagnostics.skipped_by_reason,
              skippedSamples: result.scan_diagnostics.skipped_samples.map(
                (sample) => ({
                  absolutePath: sample.absolute_path,
                  relativePath: sample.relative_path,
                  reason: sample.reason,
                  sizeBytes: sample.size_bytes,
                  limitBytes: sample.limit_bytes,
                }),
              ),
            } satisfies FileScanDiagnostics)
          : undefined,
      };
    } finally {
      writeGuard?.release();
    }
  }

  async dropIndex(options: HomeGrepInfoOptions = {}): Promise<boolean> {
    this.ensureOpen();
    const root = resolveHomeGrepRoot(options.root ?? this.root);
    const writeGuard = assertDaemonWriteAllowed(root, this.daemonInstanceToken);
    try {
      const result = await this.runtimeLease.runtime.setPolicy(root, "drop");
      return result.dropped === true;
    } finally {
      writeGuard?.release();
    }
  }

  async disableIndex(
    options: HomeGrepInfoOptions = {},
  ): Promise<HomeGrepInfoResult> {
    this.ensureOpen();
    const root = resolveHomeGrepRoot(options.root ?? this.root);
    const writeGuard = assertDaemonWriteAllowed(root, this.daemonInstanceToken);
    try {
      await this.runtimeLease.runtime.setPolicy(root, "disable");
      return this.info({ root });
    } finally {
      writeGuard?.release();
    }
  }

  async info(options: HomeGrepInfoOptions = {}): Promise<HomeGrepInfoResult> {
    this.ensureOpen();
    const root = resolveHomeGrepRoot(options.root ?? this.root);
    const status = await this.runtimeLease.runtime.status(root);
    const rootPath: RootPath = { absolutePath: root, recursive: true };
    const workspaceIndex: WorkspaceIndexInfo | undefined = status.indexed
      ? {
          id: createHash("sha256").update(root).digest("hex").slice(0, 32),
          name: basename(root),
          path: status.index_path,
          rootPaths: [rootPath],
          indexPolicy: status.index_policy,
          embedding: {
            provider: "local",
            model: "potion-code-16m-v2",
            dimension: 256,
            metric: "cosine",
          },
          indexVersion: 1,
          createdTime: status.created_time ?? 0,
          updatedTime: status.updated_time ?? 0,
        }
      : undefined;
    const indexed = status.indexed && status.index_policy === "enabled";
    const emptyStatus = {
      filesScanned: status.files,
      filesStored: status.files,
      filesIndexed: status.files,
      entitiesIndexed: status.chunks,
      fragmentsTruncated: 0,
      filesPending: 0,
      filesFailed: 0,
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      filesUnchanged: status.files,
      pendingFiles: [],
      failedFiles: [],
      addedFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
    };
    return {
      root,
      indexed,
      indexPolicy: status.indexed ? status.index_policy : "undecided",
      home: this.stateRoot,
      indexPath: status.index_path,
      source: indexed ? "index" : "unindexed",
      workspaceIndex,
      status:
        options.includeStatus === false ? null : indexed ? emptyStatus : null,
      suggestion: indexed ? undefined : "hg --index or hg --rg",
    };
  }

  async context(
    options: HomeGrepContextOptions,
  ): Promise<HomeGrepContextResult> {
    this.ensureOpen();
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Search cancelled");
    const root = resolveHomeGrepRoot(options.root ?? this.root);
    const query =
      options.query ?? options.queries?.[0] ?? options.routes?.[0]?.query ?? "";
    if (options.rg) {
      const lexical = await runRgSearch({
        root,
        patterns: options.queries?.length ? options.queries : [query],
        paths: options.rgPaths,
        limit: options.limit,
        includePaths: options.includePaths,
        excludePaths: options.excludePaths,
        globs: options.globs,
        insensitiveGlobs: options.insensitiveGlobs,
        fileTypes: options.fileTypes,
        excludedFileTypes: options.excludedFileTypes,
        hidden: options.hidden,
        noIgnore: options.noIgnore,
        ignoreFiles: options.ignoreFiles,
        maxDepth: options.maxDepth,
        maxFileSizeBytes: options.maxFileSizeBytes,
        follow: options.follow,
        modifiedAfter: options.modifiedAfter,
        modifiedBefore: options.modifiedBefore,
        rgOptions: options.rgOptions,
      });
      const structural = await enrichLexicalItemsWithStructure(
        root,
        lexical.items,
        undefined,
        options.maxFileSizeBytes,
      );
      return {
        query,
        root,
        source: "rg",
        coverage: lexical.diagnostics.truncated
          ? "rg_truncated"
          : "rg_exhaustive",
        items: structural.items,
        diagnostics: {
          rg: lexical.diagnostics,
          structure: structural.diagnostics,
        },
      };
    }
    if (!query.trim()) {
      return {
        query,
        root,
        source: "index",
        coverage: "ranked_sample",
        items: [],
        diagnostics: { emptyReason: "no_matches" },
      };
    }
    if (
      options.preferSymbol ||
      options.trace ||
      options.benchmarkCandidatePool
    ) {
      throw new Error(
        "Symbol preference, detailed traces, and pre-ranking candidate pools are not supported by the Semble response adapter",
      );
    }
    if (options.ranking === "homegrep") {
      throw new Error(
        "The legacy HomeGrep ranker is not available on the Semble engine path",
      );
    }
    if (
      options.hybridAlpha !== undefined &&
      (!Number.isFinite(options.hybridAlpha) ||
        options.hybridAlpha < 0 ||
        options.hybridAlpha > 1)
    ) {
      throw new RangeError("Hybrid alpha must be a finite number between 0 and 1");
    }
    if (
      options.noIgnore ||
      options.ignoreFiles?.length ||
      options.follow ||
      options.hidden
    ) {
      throw new Error(
        "The pinned Semble walker does not support the requested file-discovery override",
      );
    }
    if (options.maxFileSizeBytes !== undefined) {
      throw new Error(
        "Custom maximum file sizes are not yet supported by the pinned Semble walker",
      );
    }
    const queryGroups = this.queryGroups(options, query);
    const filters = {
      includePaths: options.includePaths,
      excludePaths: options.excludePaths,
      globs: options.globs,
      insensitiveGlobs: options.insensitiveGlobs,
      fileTypes: options.fileTypes,
      excludedFileTypes: options.excludedFileTypes,
      hidden: options.hidden,
      maxDepth: options.maxDepth,
      modifiedAfter: options.modifiedAfter,
      modifiedBefore: options.modifiedBefore,
      symbolTypes: options.symbolTypes,
    };
    const results: Array<{
      query: string;
      alpha?: number;
      items: HomeGrepContextItem[];
      runtimeResult: SembleSearchResult;
    }> = [];
    for (const group of queryGroups) {
      const result = await this.runtimeLease.runtime.search(root, group.query, {
        limit: options.limit,
        alpha: group.alpha,
        autoRefresh: options.autoUpdate !== false,
        filters,
        signal: options.signal,
      });
      results.push({
        ...group,
        runtimeResult: result,
        items: result.results.map((chunk, rank) =>
          this.toContextItem(root, chunk, rank + 1, group.alpha),
        ),
      });
    }
    const groupResults = results.map((group, index) => ({
      id: `Q${index + 1}`,
      query: group.query,
      role: index === 0 ? ("primary" as const) : ("supplemental" as const),
      items: group.items,
    }));
    const items = mergeQueryGroups(
      groupResults,
      options.limit ?? 10,
      options.fuse ?? false,
    );
    return {
      query,
      root,
      source: "index",
      coverage: "ranked_sample",
      items,
      diagnostics: {
        emptyReason: items.length === 0 ? "no_matches" : undefined,
        index: {
          hitsReturned: items.length,
          queryGroups: groupResults.map(({ id, query, role }) => ({
            id,
            query,
            role,
          })),
          routes: results.flatMap((group) =>
            group.alpha === 0
              ? [
                  {
                    id: "semble-bm25",
                    mode: "fts" as const,
                    query: group.query,
                  },
                ]
              : group.alpha === 1
                ? [
                    {
                      id: "semble-dense",
                      mode: "vector" as const,
                      query: group.query,
                    },
                  ]
                : [
                    {
                      id: "semble-bm25",
                      mode: "fts" as const,
                      query: group.query,
                    },
                    {
                      id: "semble-dense",
                      mode: "vector" as const,
                      query: group.query,
                    },
                  ],
          ),
        },
        timings: [
          {
            name: "workspace_freshness_hash",
            durationMs: results.reduce(
              (sum, group) => sum + group.runtimeResult.freshness_ms,
              0,
            ),
          },
          {
            name: "semble_search",
            durationMs: results.reduce(
              (sum, group) => sum + group.runtimeResult.semble_search_ms,
              0,
            ),
          },
          {
            name: "automatic_refresh",
            durationMs: results.reduce(
              (sum, group) => sum + group.runtimeResult.refresh_ms,
              0,
            ),
          },
        ],
      },
      groupResults,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.runtimeLease.release();
  }

  private toContextItem(
    root: string,
    chunk: SembleChunk,
    rank: number,
    alpha: number | undefined,
  ): HomeGrepContextItem {
    const absolutePath = resolve(root, chunk.path);
    return {
      kind: "indexed_entity",
      rank,
      file: {
        absolutePath,
        relativePath: chunk.path,
        rootPath: root,
      },
      range: {
        kind: "text",
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        startOffset: chunk.start_offset,
        endOffset: chunk.end_offset,
      },
      content: chunk.content,
      status: "fresh",
      score: chunk.score,
      matchedBy: alpha === 0 ? "fts" : alpha === 1 ? "vector" : "fts+vector",
      entityId: createHash("sha256")
        .update(
          `${chunk.path}:${chunk.start_line}:${chunk.end_line}:${chunk.content}`,
        )
        .digest("hex"),
      selectionReason: "global_fill",
    };
  }

  private queryGroups(
    options: HomeGrepContextOptions,
    fallback: string,
  ): Array<{ query: string; alpha?: number }> {
    if (options.routes?.length) {
      const grouped = new Map<string, Set<"fts" | "vector">>();
      for (const route of options.routes) {
        const modes = grouped.get(route.query) ?? new Set<"fts" | "vector">();
        modes.add(route.mode);
        grouped.set(route.query, modes);
      }
      return [...grouped].map(([query, modes]) => ({
        query,
        alpha:
          modes.size > 1
            ? options.hybridAlpha
            : modes.has("fts")
              ? 0
              : 1,
      }));
    }
    return [
      ...new Set(options.queries?.length ? options.queries : [fallback]),
    ].map((query) => ({ query, alpha: options.hybridAlpha }));
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Semble service is already closed");
  }
}

export async function createSembleGrep(
  options: CreateHomeGrepOptions = {},
): Promise<HomeGrep> {
  return new SembleGrepService(options);
}

export function openWorkspaceReadSession(
  root: string,
  _embeddingModel?: unknown,
  options: { home?: string } = {},
): {
  readonly root: string;
  context(options: HomeGrepContextOptions): Promise<HomeGrepContextResult>;
  close(): Promise<void>;
} {
  const service = new SembleGrepService({ root, home: options.home });
  return {
    root: service.root,
    context: (options) =>
      service.context({ ...options, root, autoUpdate: false }),
    close: () => service.close(),
  };
}
