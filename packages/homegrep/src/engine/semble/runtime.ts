import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SembleChunk = {
  path: string;
  start_line: number;
  end_line: number;
  start_offset: number;
  end_offset: number;
  language: string | null;
  content: string;
  score: number;
};

export type SembleSearchResult = {
  root: string;
  generation: string;
  engine_revision: string;
  freshness_ms: number;
  refresh_ms: number;
  semble_search_ms: number;
  results: SembleChunk[];
};

export type SembleIndexResult = {
  root: string;
  generation: string;
  files: number;
  chunks: number;
  reused_files: number;
  files_added: number;
  files_modified: number;
  files_deleted: number;
  files_unchanged: number;
  scan_diagnostics?: {
    skipped_files: number;
    skipped_by_reason: Record<"empty" | "too_large" | "unsupported" | "binary", number>;
    skipped_samples: Array<{
      absolute_path: string;
      relative_path: string;
      reason: "empty" | "too_large" | "unsupported" | "binary";
      size_bytes?: number;
      limit_bytes?: number;
    }>;
  };
  engine_revision: string;
};

export type SembleWorkspaceStatus = {
  root: string;
  indexed: boolean;
  index_policy: "enabled" | "disabled";
  files: number;
  chunks: number;
  generation: string | null;
  engine_revision: string;
  index_path: string;
  stale: boolean;
  created_time: number | null;
  updated_time: number | null;
};

type RuntimeResponse<T> = {
  id: string;
  ok: boolean;
  result?: T;
  error?: { type: string; message: string };
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

const ENGINE_REVISION = "8ee6463efbb1ff755c339e965c7298b7afd7db5b";
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../",
);
const DEFAULT_PYTHON_PROJECT = join(PACKAGE_ROOT, "python");
const SHARED_RUNTIMES = new Map<
  string,
  { runtime: SembleRuntime; users: number }
>();

export class SembleRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pythonProject: string;
  private readonly stateRoot: string;

  constructor(options: { pythonProject?: string; stateRoot: string }) {
    this.pythonProject = resolve(options.pythonProject ?? DEFAULT_PYTHON_PROJECT);
    this.stateRoot = resolve(options.stateRoot);
  }

  index(
    root: string,
    options: {
      rebuild?: boolean;
      modelPath?: string;
      modelCacheDir?: string;
    } = {},
  ): Promise<SembleIndexResult> {
    return this.request<SembleIndexResult>(
      "index",
      {
        root,
        rebuild: options.rebuild ?? false,
        model_path: options.modelPath,
        model_cache_dir: options.modelCacheDir,
      },
      10 * 60_000,
    );
  }

  async search(
    root: string,
    query: string,
    options: {
      limit?: number;
      alpha?: number;
      autoRefresh?: boolean;
      filters?: {
        paths?: readonly string[];
        includePaths?: readonly string[];
        excludePaths?: readonly string[];
        globs?: readonly string[];
        insensitiveGlobs?: readonly string[];
        fileTypes?: readonly string[];
        excludedFileTypes?: readonly string[];
        hidden?: boolean;
        maxDepth?: number;
        modifiedAfter?: number;
        modifiedBefore?: number;
        languages?: readonly string[];
        symbolTypes?: readonly string[];
      };
      signal?: AbortSignal;
    } = {},
  ): Promise<SembleSearchResult> {
    return this.request<SembleSearchResult>(
      "search",
      {
        root,
        query,
        limit: options.limit ?? 10,
        alpha: options.alpha,
        auto_refresh: options.autoRefresh ?? true,
        filters: {
          paths: options.filters?.paths,
          include_paths: options.filters?.includePaths,
          exclude_paths: options.filters?.excludePaths,
          globs: options.filters?.globs,
          insensitive_globs: options.filters?.insensitiveGlobs,
          file_types: options.filters?.fileTypes,
          excluded_file_types: options.filters?.excludedFileTypes,
          hidden: options.filters?.hidden,
          max_depth: options.filters?.maxDepth,
          modified_after: options.filters?.modifiedAfter,
          modified_before: options.filters?.modifiedBefore,
          languages: options.filters?.languages,
          symbol_types: options.filters?.symbolTypes,
        },
      },
      60_000,
      options.signal,
    );
  }

  status(root: string): Promise<SembleWorkspaceStatus> {
    return this.request("status", { root });
  }

  setPolicy(
    root: string,
    operation: "disable" | "enable" | "drop",
  ): Promise<{ policy?: string; dropped?: boolean }> {
    return this.request(operation, { root });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.request("close", {}, 5_000);
      await new Promise<void>((resolveExit) => {
        if (child.exitCode !== null) {
          resolveExit();
          return;
        }
        const timer = setTimeout(resolveExit, 5_000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    } catch {
      // Forced termination is only the bounded fallback for a wedged runtime.
      child.kill();
    }
    if (this.child === child) this.child = undefined;
  }

  private request<T>(
    operation:
      "index" | "search" | "status" | "disable" | "enable" | "drop" | "close",
    payload: Record<string, unknown>,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Semble request cancelled"));
    const child = this.ensureStarted();
    const id = randomUUID();
    const request = new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Semble ${operation} request timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timer,
      });
      child.stdin.write(
        `${JSON.stringify({ id, operation, state_root: this.stateRoot, ...payload })}\n`,
        (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(error);
        },
      );
    });
    if (!signal) return request;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const cancel = () => rejectRequest(signal.reason ?? new Error("Semble request cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      request.then(resolveRequest, rejectRequest).finally(() => signal.removeEventListener("abort", cancel));
    });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    const child = spawn(
      process.env.HOMEGREP_UV ?? "uv",
      [
        "run",
        "--project",
        this.pythonProject,
        "--no-dev",
        "--",
        "python",
        "-m",
        "homegrep_semble.bridge",
      ],
      {
        cwd: this.pythonProject,
        env: {
          ...process.env,
          UV_PROJECT_ENVIRONMENT: join(
            this.stateRoot,
            "runtimes",
            `semble-${ENGINE_REVISION}`,
          ),
          UV_LINK_MODE: "copy",
          CUDA_VISIBLE_DEVICES: "",
          OMP_NUM_THREADS: "1",
          OPENBLAS_NUM_THREADS: "1",
          MKL_NUM_THREADS: "1",
          PYTHONUNBUFFERED: "1",
          HF_HUB_DISABLE_PROGRESS_BARS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => this.handleResponse(line));
    child.stderr.on("data", (data: Buffer) => {
      process.stderr.write(`[HomeGrep Semble] ${data.toString("utf8")}`);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const actionable =
        error.code === "ENOENT"
          ? new Error(
              "HomeGrep's pinned Semble engine requires uv. Install uv or set HOMEGREP_UV to its executable path.",
              { cause: error },
            )
          : error;
      this.failAll(actionable);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.failAll(
        new Error(
          `Semble runtime exited (${signal ? `signal ${signal}` : `code ${code}`})`,
        ),
      );
    });
    return child;
  }

  private handleResponse(line: string): void {
    let response: RuntimeResponse<unknown>;
    try {
      response = JSON.parse(line) as RuntimeResponse<unknown>;
    } catch (error) {
      this.failAll(
        new Error("Semble runtime emitted invalid protocol data", {
          cause: error,
        }),
      );
      this.child?.kill();
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (!response.ok) {
      pending.reject(
        new Error(response.error?.message ?? "Semble runtime request failed"),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function acquireSembleRuntime(stateRoot: string, pythonProject = DEFAULT_PYTHON_PROJECT): {
  runtime: SembleRuntime;
  release(): Promise<void>;
} {
  const resolvedPythonProject = resolve(pythonProject);
  const key = `${resolve(stateRoot)}\0${resolvedPythonProject}`;
  let shared = SHARED_RUNTIMES.get(key);
  if (!shared) {
    shared = { runtime: new SembleRuntime({ stateRoot, pythonProject: resolvedPythonProject }), users: 0 };
    SHARED_RUNTIMES.set(key, shared);
  }
  shared.users += 1;
  let released = false;
  return {
    runtime: shared.runtime,
    async release() {
      if (released) return;
      released = true;
      shared!.users -= 1;
      if (shared!.users === 0) {
        SHARED_RUNTIMES.delete(key);
        await shared!.runtime.close();
      }
    },
  };
}
