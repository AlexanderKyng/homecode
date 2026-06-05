import { Effect, Context, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@homecode-ai/core/util/log"
import { readFileSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { InstanceRef } from "@/effect/instance-ref"

const log = Log.create({ service: "python.sandbox" })

declare global {
  const OPENCODE_PYODIDE_WORKER_SOURCE: string
  const OPENCODE_PYODIDE_VERSION: string
}

function createWorkerBlobUrl(): string {
  // Production/NPM/Standalone: use embedded worker source
  if (typeof OPENCODE_PYODIDE_WORKER_SOURCE !== "undefined" && OPENCODE_PYODIDE_WORKER_SOURCE) {
    const blob = new Blob([OPENCODE_PYODIDE_WORKER_SOURCE], { type: "text/javascript" })
    return URL.createObjectURL(blob)
  }
  // Dev mode: read worker source relative to this file
  const workerUrl = new URL("./pyodide-worker.ts", import.meta.url)
  const src = readFileSync(fileURLToPath(workerUrl), "utf8")
  const blob = new Blob([src], { type: "text/javascript" })
  return URL.createObjectURL(blob)
}

function resolvePyodideIndexUrl(): string {
  try {
    const pyodideUrl = import.meta.resolve("pyodide/package.json")
    const pyodidePath = fileURLToPath(pyodideUrl)
    return path.dirname(pyodidePath) + "/"
  } catch {
    // Fallback to CDN for standalone binaries without local pyodide on disk
    const version = typeof OPENCODE_PYODIDE_VERSION !== "undefined" ? OPENCODE_PYODIDE_VERSION : "0.29.4"
    return `https://cdn.jsdelivr.net/pyodide/v${version}/full/`
  }
}

export interface ExecutionResult {
  stdout: string
  stderr: string
  plots: string[]
  result?: string
  error?: string
  executionTimeMs?: number
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
}

export interface Interface {
  ensureReady(): Effect.Effect<void, Error, any>
  executePython(code: string, timeoutSeconds?: number): Effect.Effect<ExecutionResult, Error, any>
  executeShell(command: string, timeoutSeconds?: number): Effect.Effect<CommandResult, Error, any>
  readFile(filePath: string): Effect.Effect<string, Error, any>
  writeFile(filePath: string, content: string): Effect.Effect<void, Error, any>
  reset(): Effect.Effect<void, Error, any>
  destroy(): Effect.Effect<void, Error, any>
}

export class Service extends Context.Service<Service, Interface>()("@homecode/PythonSandbox") {}

// Worker message types (mirror of pyodide-worker.ts)
interface WorkerResponse {
  id: number
  success: boolean
  error?: string
}

interface WorkerInitResponse extends WorkerResponse {
  type: "init"
}

interface WorkerExecutePythonResponse extends WorkerResponse {
  type: "executePython"
  stdout: string
  stderr: string
  plots: string[]
  result?: string
  executionTimeMs: number
}

interface WorkerExecuteShellResponse extends WorkerResponse {
  type: "executeShell"
  stdout: string
  stderr: string
  exitCode: number | null
}

interface WorkerReadFileResponse extends WorkerResponse {
  type: "readFile"
  content: string
}

interface WorkerWriteFileResponse extends WorkerResponse {
  type: "writeFile"
}

interface WorkerResetResponse extends WorkerResponse {
  type: "reset"
}

interface WorkerDestroyResponse extends WorkerResponse {
  type: "destroy"
}

interface WorkerPongResponse extends WorkerResponse {
  type: "pong"
}

type WorkerResponseMessage =
  | WorkerInitResponse
  | WorkerExecutePythonResponse
  | WorkerExecuteShellResponse
  | WorkerReadFileResponse
  | WorkerWriteFileResponse
  | WorkerResetResponse
  | WorkerDestroyResponse
  | WorkerPongResponse

function resolveWorkerPath(): string {
  return createWorkerBlobUrl()
}

function workerRequest<T extends WorkerResponseMessage>(
  worker: Worker,
  message: Record<string, unknown>,
  timeoutMs: number,
): Effect.Effect<T, Error, never> {
  return Effect.promise(() => {
    return new Promise<T>((resolve, reject) => {
      const id = (Date.now() ^ (Math.random() * 0xffffff)) | 0
      const timer = setTimeout(() => {
        worker.removeEventListener("message", handler)
        reject(new Error(`Python sandbox operation timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      function handler(event: MessageEvent<WorkerResponseMessage>): void {
        if (event.data.id === id) {
          clearTimeout(timer)
          worker.removeEventListener("message", handler)
          if (event.data.success) {
            resolve(event.data as T)
          } else {
            reject(new Error(event.data.error ?? "Worker returned failure"))
          }
        }
      }

      worker.addEventListener("message", handler)
      worker.postMessage({ ...message, id })
    })
  })
}

function workerRequestWithTerminate<T extends WorkerResponseMessage>(
  worker: Worker,
  message: Record<string, unknown>,
  timeoutMs: number,
): Effect.Effect<T, Error, never> {
  return Effect.promise(() => {
    return new Promise<T>((resolve, reject) => {
      const id = (Date.now() ^ (Math.random() * 0xffffff)) | 0
      // Hard timeout that terminates the worker
      const timer = setTimeout(() => {
        worker.removeEventListener("message", handler)
        worker.terminate()
        reject(new Error(`Python sandbox operation timed out after ${timeoutMs}ms; worker terminated`))
      }, timeoutMs)

      function handler(event: MessageEvent<WorkerResponseMessage>): void {
        if (event.data.id === id) {
          clearTimeout(timer)
          worker.removeEventListener("message", handler)
          if (event.data.success) {
            resolve(event.data as T)
          } else {
            reject(new Error(event.data.error ?? "Worker returned failure"))
          }
        }
      }

      worker.addEventListener("message", handler)
      worker.postMessage({ ...message, id })
    })
  })
}

export const state = InstanceState.make<Interface, never, never>((ctx) =>
  Effect.gen(function* () {
    const workerPath = resolveWorkerPath()
    let worker: Worker | null = null
    let initialized = false

    const createWorker = (): Worker => {
      const w = new Worker(workerPath, { type: "module" } as WorkerOptions)
      w.onerror = (e) => {
        const msg = `Pyodide worker error: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`
        console.error(msg)
        log.error("pyodide worker error", {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
        })
      }
      return w
    }

    const getOrCreateWorker = (): Worker => {
      if (!worker || !initialized) {
        worker = createWorker()
        initialized = false
      }
      return worker
    }

    // Quick health check: ping the worker and wait for a pong within 5s
    const pingWorker = (w: Worker): Effect.Effect<void, Error, never> =>
      Effect.promise(() => {
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            w.removeEventListener("message", handler)
            reject(new Error("Pyodide worker did not respond to health check"))
          }, 5_000)

          function handler(event: MessageEvent<WorkerResponseMessage>): void {
            if (event.data.id === -1 && event.data.type === "pong") {
              clearTimeout(timer)
              w.removeEventListener("message", handler)
              resolve()
            }
          }

          w.addEventListener("message", handler)
          w.postMessage({ type: "ping", id: -1 })
        })
      })

    const ensureReady = () =>
      Effect.gen(function* () {
        try {
          if (initialized) return

          const w = getOrCreateWorker()

          // Health check before sending init
          yield* pingWorker(w)

          const indexURL = resolvePyodideIndexUrl()
          log.info("Loading Pyodide...", { indexURL })

          yield* workerRequest<WorkerInitResponse>(w, { type: "init", indexURL }, 120_000)

          initialized = true
          log.info("Pyodide loaded successfully")
        } catch (e) {
          // If worker failed during init, recreate it
          if (worker) {
            worker.terminate()
            worker = null
          }
          initialized = false
          return yield* Effect.fail(new Error(`Failed to initialize Pyodide: ${e}`))
        }
      })

    const executePython = (code: string, timeoutSeconds = 60) =>
      Effect.gen(function* () {
        try {
          yield* ensureReady()

          const w = getOrCreateWorker()
          const timeoutMs = timeoutSeconds * 1000

          // Use terminate-on-timeout for Python execution (the dangerous path)
          try {
            const result = yield* workerRequestWithTerminate<WorkerExecutePythonResponse>(
              w,
              { type: "executePython", code },
              timeoutMs,
            )

            return {
              stdout: result.stdout,
              stderr: result.stderr,
              plots: result.plots,
              result: result.result,
              executionTimeMs: result.executionTimeMs,
            }
          } catch (err) {
            // Worker was terminated due to timeout; recreate on next call
            worker = null
            initialized = false

            return {
              stdout: "",
              stderr: "",
              plots: [],
              error: String(err),
              executionTimeMs: timeoutMs,
            }
          }
        } catch (e) {
          return yield* Effect.fail(new Error(String(e)))
        }
      })

    const executeShell = (command: string, timeoutSeconds = 60) =>
      Effect.gen(function* () {
        try {
          yield* ensureReady()

          const w = getOrCreateWorker()
          const result = yield* workerRequest<WorkerExecuteShellResponse>(
            w,
            { type: "executeShell", command },
            timeoutSeconds * 1000,
          )

          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            ...(result.exitCode !== 0 ? { error: result.stderr } : {}),
          }
        } catch (e) {
          return yield* Effect.fail(new Error(String(e)))
        }
      })

    const readFile = (filePath: string) =>
      Effect.gen(function* () {
        try {
          yield* ensureReady()

          const w = getOrCreateWorker()
          const result = yield* workerRequest<WorkerReadFileResponse>(w, { type: "readFile", filePath }, 30_000)

          return result.content
        } catch (e) {
          return yield* Effect.fail(new Error(String(e)))
        }
      })

    const writeFile = (filePath: string, content: string) =>
      Effect.gen(function* () {
        try {
          yield* ensureReady()

          const w = getOrCreateWorker()
          yield* workerRequest<WorkerWriteFileResponse>(w, { type: "writeFile", filePath, content }, 30_000)
        } catch (e) {
          return yield* Effect.fail(new Error(String(e)))
        }
      })

    const reset = () =>
      Effect.gen(function* () {
        try {
          // Terminate old worker and recreate fresh
          if (worker) {
            worker.terminate()
            worker = null
          }
          initialized = false
          yield* ensureReady()
        } catch (e) {
          return yield* Effect.fail(new Error(String(e)))
        }
      })

    const destroy = () =>
      Effect.gen(function* () {
        if (worker) {
          worker.terminate()
          worker = null
        }
        initialized = false
      })

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (worker) {
          worker.terminate()
          worker = null
        }
        initialized = false
      }),
    )

    return { ensureReady, executePython, executeShell, readFile, writeFile, reset, destroy }
  }).pipe(Effect.provideService(InstanceRef, ctx)),
)

const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pythonState = yield* state

    const ensureReady = () => InstanceState.useEffect(pythonState, (api) => api.ensureReady())
    const executePython = (code: string, timeoutSeconds?: number) =>
      InstanceState.useEffect(pythonState, (api) => api.executePython(code, timeoutSeconds))
    const executeShell = (command: string, timeoutSeconds?: number) =>
      InstanceState.useEffect(pythonState, (api) => api.executeShell(command, timeoutSeconds))
    const readFile = (filePath: string) => InstanceState.useEffect(pythonState, (api) => api.readFile(filePath))
    const writeFile = (filePath: string, content: string) =>
      InstanceState.useEffect(pythonState, (api) => api.writeFile(filePath, content))
    const reset = () => InstanceState.useEffect(pythonState, (api) => api.reset())
    const destroy = () => InstanceState.useEffect(pythonState, (api) => api.destroy())

    return Service.of({ ensureReady, executePython, executeShell, readFile, writeFile, reset, destroy })
  }),
)

export { layer }
