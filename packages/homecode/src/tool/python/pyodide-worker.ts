import { loadPyodide, type PyodideInterface } from "pyodide"
import path from "path"

let pyodide: PyodideInterface | null = null
let lastIndexUrl: string = ""
let stdoutBuffer: string[] = []
let stderrBuffer: string[] = []

interface InitRequest {
  type: "init"
  id: number
  indexURL: string
}

interface PingRequest {
  type: "ping"
  id: number
}

interface ExecutePythonRequest {
  type: "executePython"
  id: number
  code: string
}

interface ExecuteShellRequest {
  type: "executeShell"
  id: number
  command: string
}

interface ReadFileRequest {
  type: "readFile"
  id: number
  filePath: string
}

interface WriteFileRequest {
  type: "writeFile"
  id: number
  filePath: string
  content: string
}

interface ResetRequest {
  type: "reset"
  id: number
}

interface DestroyRequest {
  type: "destroy"
  id: number
}

type Request =
  | PingRequest
  | InitRequest
  | ExecutePythonRequest
  | ExecuteShellRequest
  | ReadFileRequest
  | WriteFileRequest
  | ResetRequest
  | DestroyRequest

interface Response {
  id: number
  success: boolean
  error?: string
}

interface ErrorResponse extends Response {
  type: "error"
}

interface PongResponse extends Response {
  type: "pong"
}

interface InitResponse extends Response {
  type: "init"
}

interface ExecutePythonResponse extends Response {
  type: "executePython"
  stdout: string
  stderr: string
  plots: string[]
  result?: string
  executionTimeMs: number
}

interface ExecuteShellResponse extends Response {
  type: "executeShell"
  stdout: string
  stderr: string
  exitCode: number | null
}

interface ReadFileResponse extends Response {
  type: "readFile"
  content: string
}

interface WriteFileResponse extends Response {
  type: "writeFile"
}

interface ResetResponse extends Response {
  type: "reset"
}

interface DestroyResponse extends Response {
  type: "destroy"
}

type ResponseMessage =
  | PongResponse
  | InitResponse
  | ExecutePythonResponse
  | ExecuteShellResponse
  | ReadFileResponse
  | WriteFileResponse
  | ResetResponse
  | DestroyResponse
  | ErrorResponse

function send(response: ResponseMessage): void {
  self.postMessage(response)
}

async function ensureReady(indexURL: string): Promise<void> {
  if (pyodide) return

  if (typeof globalThis.process === "undefined") {
    // @ts-ignore
    globalThis.process = process
  }

  lastIndexUrl = indexURL

  pyodide = await loadPyodide({
    indexURL,
    stdout: (text: string) => {
      stdoutBuffer.push(text)
    },
    stderr: (text: string) => {
      stderrBuffer.push(text)
    },
  })

  // Load scientific stack
  await pyodide.loadPackage(["micropip", "numpy", "pandas", "matplotlib", "scipy"])

  // Set up matplotlib with a non-interactive backend and a lightweight plot collector
  await pyodide.runPythonAsync(`
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import io
import base64

def _get_matplotlib_plots():
    fig_nums = plt.get_fignums()
    if not fig_nums:
        return []
    plots = []
    for i in fig_nums:
        fig = plt.figure(i)
        buf = io.BytesIO()
        fig.savefig(buf, format='png')
        buf.seek(0)
        img_str = base64.b64encode(buf.read()).decode('utf-8')
        plots.append(f"data:image/png;base64,{img_str}")
    plt.close('all')
    return plots
`)
}

async function handleExecutePython(code: string): Promise<ExecutePythonResponse> {
  const start = Date.now()
  stdoutBuffer = []
  stderrBuffer = []

  try {
    const result = await pyodide!.runPythonAsync(code)
    // Only collect plots if matplotlib figures exist (avoids unnecessary Python call)
    const plots = (await pyodide!.runPythonAsync("_get_matplotlib_plots()")) as unknown as string[]
    const executionTimeMs = Date.now() - start

    return {
      id: -1, // set by caller
      success: true,
      type: "executePython",
      stdout: stdoutBuffer.join("\n"),
      stderr: stderrBuffer.join("\n"),
      plots: Array.isArray(plots) ? plots : [],
      result: result === undefined ? undefined : String(result),
      executionTimeMs,
    }
  } catch (err) {
    // On error, still try to collect any plots that were created before the error
    let plots: string[] = []
    try {
      const collected = (await pyodide!.runPythonAsync("_get_matplotlib_plots()")) as unknown
      plots = Array.isArray(collected) ? collected : []
    } catch {
      // ignore plot collection errors
    }

    return {
      id: -1,
      success: false,
      type: "executePython",
      stdout: stdoutBuffer.join("\n"),
      stderr: stderrBuffer.join("\n"),
      plots,
      error: String(err),
      executionTimeMs: Date.now() - start,
    }
  }
}

async function handleExecuteShell(command: string): Promise<ExecuteShellResponse> {
  if (command.trim().startsWith("pip install ")) {
    const pkg = command.trim().replace("pip install ", "")
    try {
      await pyodide!.runPythonAsync(`import micropip; await micropip.install('${pkg}')`)
      return {
        id: -1,
        success: true,
        type: "executeShell",
        stdout: `Successfully installed ${pkg}`,
        stderr: "",
        exitCode: 0,
      }
    } catch (err) {
      return {
        id: -1,
        success: false,
        type: "executeShell",
        stdout: "",
        stderr: String(err),
        exitCode: 1,
      }
    }
  }

  return {
    id: -1,
    success: false,
    type: "executeShell",
    stdout: "",
    stderr: "Shell commands are not fully supported in the WASM sandbox. Use 'pip install' for packages.",
    exitCode: 1,
  }
}

async function handleReset(): Promise<void> {
  pyodide = null
  stdoutBuffer = []
  stderrBuffer = []
  await ensureReady(lastIndexUrl)
}

async function handleDestroy(): Promise<void> {
  pyodide = null
  stdoutBuffer = []
  stderrBuffer = []
}

self.onmessage = async (event: MessageEvent<Request>): Promise<void> => {
  const data = event.data
  const id = data.id

  try {
    switch (data.type) {
      case "ping": {
        send({ id, success: true, type: "pong" })
        break
      }

      case "init": {
        await ensureReady(data.indexURL)
        send({ id, success: true, type: "init" })
        break
      }

      case "executePython": {
        await ensureReady(lastIndexUrl)
        const result = await handleExecutePython(data.code)
        send({ ...result, id })
        break
      }

      case "executeShell": {
        await ensureReady(lastIndexUrl)
        const result = await handleExecuteShell(data.command)
        send({ ...result, id })
        break
      }

      case "readFile": {
        await ensureReady(lastIndexUrl)
        try {
          const bytes = pyodide!.FS.readFile(data.filePath)
          const content = new TextDecoder().decode(bytes)
          send({ id, success: true, type: "readFile", content })
        } catch (err) {
          send({
            id,
            success: false,
            type: "readFile",
            content: "",
            error: `Failed to read file ${data.filePath}: ${err}`,
          })
        }
        break
      }

      case "writeFile": {
        await ensureReady(lastIndexUrl)
        try {
          const dir = path.dirname(data.filePath)
          if (dir !== "." && dir !== "/") {
            try {
              pyodide!.FS.mkdirTree(dir)
            } catch {
              // Ignore if already exists
            }
          }
          pyodide!.FS.writeFile(data.filePath, data.content)
          send({ id, success: true, type: "writeFile" })
        } catch (err) {
          send({ id, success: false, type: "writeFile", error: `Failed to write file ${data.filePath}: ${err}` })
        }
        break
      }

      case "reset": {
        await handleReset()
        send({ id, success: true, type: "reset" })
        break
      }

      case "destroy": {
        await handleDestroy()
        send({ id, success: true, type: "destroy" })
        break
      }

      default: {
        send({ id, success: false, type: "error", error: `Unknown message type: ${(data as Request).type}` })
      }
    }
  } catch (err) {
    send({ id, success: false, type: "error", error: String(err) })
  }
}
