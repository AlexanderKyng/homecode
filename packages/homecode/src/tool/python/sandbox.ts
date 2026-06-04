import { Effect, Context, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@homecode-ai/core/util/log"
import { loadPyodide, type PyodideInterface } from "pyodide"
import path from "path"
import { fileURLToPath } from "url"
import { InstanceRef } from "@/effect/instance-ref"

const log = Log.create({ service: "python.sandbox" })

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

export const state = InstanceState.make<Interface, never, never>(
  (ctx) =>
    Effect.gen(function* () {
      let pyodide: PyodideInterface | null = null
      let stdoutBuffer: string[] = []
      let stderrBuffer: string[] = []

      const ensureReady = () =>
        Effect.gen(function* () {
          try {
            if (pyodide) return

            log.info("Loading Pyodide...")
            pyodide = yield* Effect.promise(() => {
              // Ensure process is available globally for some Pyodide versions in workers
              if (typeof globalThis.process === "undefined") {
                // @ts-ignore
                globalThis.process = process
              }

              // Get the directory of the installed pyodide package
              const pyodideUrl = import.meta.resolve("pyodide/package.json")
              const pyodidePath = fileURLToPath(pyodideUrl)
              const indexURL = path.dirname(pyodidePath) + "/"

              return loadPyodide({
                indexURL,
                stdout: (text) => {
                  stdoutBuffer.push(text)
                },
                stderr: (text) => {
                  stderrBuffer.push(text)
                },
              })
            })

            log.info("Pyodide loaded successfully")

            // Load scientific stack
            log.info("Loading scientific stack (numpy, pandas, matplotlib, scipy)...")
            yield* Effect.promise(() => pyodide!.loadPackage(["micropip", "numpy", "pandas", "matplotlib", "scipy"]))
            
            // Set up matplotlib to use a non-interactive backend
            yield* Effect.promise(() => pyodide!.runPythonAsync(`
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import io
import base64

def _get_matplotlib_plots():
    plots = []
    for i in plt.get_fignums():
        fig = plt.figure(i)
        buf = io.BytesIO()
        fig.savefig(buf, format='png')
        buf.seek(0)
        img_str = base64.b64encode(buf.read()).decode('utf-8')
        plots.append(f"data:image/png;base64,{img_str}")
    plt.close('all')
    return plots
`))
            log.info("Scientific stack and matplotlib hooks ready")
          } catch (e) {
            return yield* Effect.fail(new Error(`Failed to initialize Pyodide: ${e}`))
          }
        })

      const executePython = (code: string, _timeoutSeconds = 60) =>
        Effect.gen(function* () {
          try {
            yield* ensureReady()

            stdoutBuffer = []
            stderrBuffer = []
            const start = Date.now()

            try {
              const result = yield* Effect.promise(() => pyodide!.runPythonAsync(code))
              const plots = (yield* Effect.promise(() =>
                pyodide!.runPythonAsync("_get_matplotlib_plots()"),
              )) as any
              const executionTimeMs = Date.now() - start

              return {
                stdout: stdoutBuffer.join("\n"),
                stderr: stderrBuffer.join("\n"),
                plots: Array.from(plots) as string[],
                result: result === undefined ? undefined : String(result),
                executionTimeMs,
              }
              } catch (err) {
              const plots = (yield* Effect.promise(() =>
                pyodide!.runPythonAsync("_get_matplotlib_plots()"),
              ).pipe(Effect.orElseSucceed(() => []))) as any

              return {
                stdout: stdoutBuffer.join("\n"),
                stderr: stderrBuffer.join("\n"),
                plots: Array.from(plots) as string[],
                error: String(err),
                executionTimeMs: Date.now() - start,
              }
              }

          } catch (e) {
            return yield* Effect.fail(new Error(String(e)))
          }
        })

      const executeShell = (command: string, _timeoutSeconds = 60) =>
        Effect.gen(function* () {
          try {
            yield* ensureReady()

            if (command.trim().startsWith("pip install ")) {
              const pkg = command.trim().replace("pip install ", "")
              log.info(`Installing package via micropip: ${pkg}`)
              try {
                yield* Effect.promise(() => pyodide!.runPythonAsync(`import micropip; await micropip.install('${pkg}')`))
                return { stdout: `Successfully installed ${pkg}`, stderr: "", exitCode: 0 }
              } catch (err) {
                return { stdout: "", stderr: String(err), exitCode: 1 }
              }
            }

            return {
              stdout: "",
              stderr: "Shell commands are not fully supported in the WASM sandbox. Use 'pip install' for packages.",
              exitCode: 1,
            }
          } catch (e) {
            return yield* Effect.fail(new Error(String(e)))
          }
        })

      const readFile = (filePath: string) =>
        Effect.gen(function* () {
          try {
            yield* ensureReady()
            try {
              const bytes = pyodide!.FS.readFile(filePath)
              return new TextDecoder().decode(bytes)
            } catch (err) {
              return yield* Effect.fail(new Error(`Failed to read file ${filePath}: ${err}`))
            }
          } catch (e) {
            return yield* Effect.fail(new Error(String(e)))
          }
        })

      const writeFile = (filePath: string, content: string) =>
        Effect.gen(function* () {
          try {
            yield* ensureReady()
            try {
              const dir = path.dirname(filePath)
              if (dir !== "." && dir !== "/") {
                try {
                  pyodide!.FS.mkdirTree(dir)
                } catch (e) {
                  // Ignore if already exists
                }
              }
              pyodide!.FS.writeFile(filePath, content)
            } catch (err) {
              return yield* Effect.fail(new Error(`Failed to write file ${filePath}: ${err}`))
            }
          } catch (e) {
            return yield* Effect.fail(new Error(String(e)))
          }
        })

      const reset = () =>
        Effect.gen(function* () {
          try {
            pyodide = null
            yield* ensureReady()
          } catch (e) {
            return yield* Effect.fail(new Error(String(e)))
          }
        })

      const destroy = () =>
        Effect.gen(function* () {
          pyodide = null
        })

      yield* Effect.addFinalizer(() => Effect.sync(() => destroy()))

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
