import { createConnection, type Socket } from "node:net"
import { spawn } from "node:child_process"
import { Context, Effect, Layer, Semaphore } from "effect"
import * as Log from "@homecode-ai/core/util/log"
import { Config } from "@/config/config"
import { HomeMemConfig } from "./config"

const log = Log.create({ service: "homemem.client" })

/** Protocol version this host understands. The engine refuses a mismatch. */
export const PROTOCOL_VERSION = 1

/** How long to wait for a request before falling back to the CLI path. */
const REQUEST_TIMEOUT_MS = 2_000

/** How long to wait for a freshly spawned daemon to accept connections. */
const STARTUP_TIMEOUT_MS = 2_000

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

type Connection = {
  readonly socket: Socket
  readonly pending: Map<number, Pending>
  buffer: string
  nextID: number
  closed: boolean
}

export interface Interface {
  /** Engine health and protocol version, or `undefined` when no engine is reachable. */
  readonly probe: () => Effect.Effect<{ protocolVersion: number; engineVersion: string } | undefined>
  /** The resolved configuration this client is using. */
  readonly config: () => Effect.Effect<HomeMemConfig>
  /**
   * Send one request and decode the `result` payload. Fails when the daemon is unreachable, the
   * protocol rejects the request, or the response exceeds the timeout; callers decide whether to
   * degrade or surface the error.
   */
  readonly request: (method: string, params?: unknown, options?: { timeout?: number }) => Effect.Effect<unknown, Error>
}

export class Service extends Context.Service<Service, Interface>()("@homecode/HomeMemClient") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const configService = yield* Config.Service

    type State = {
      config?: HomeMemConfig
      connection?: Connection
      starting?: Effect.Effect<Connection | undefined>
      lock: Semaphore.Semaphore
    }
    const state: State = { lock: Semaphore.makeUnsafe(1) }

    const loadConfig = Effect.fn("HomeMemClient.loadConfig")(function* () {
      if (state.config) return state.config
      const raw = (yield* configService.get()).experimental?.homemem
      const resolved: HomeMemConfig = HomeMemConfig.resolve(raw)
      state.config = resolved
      return resolved
    })

    // The socket path must match the engine's `default_socket` so a daemon started by the CLI and
    // one started here are the same instance.
    const socketPath = Effect.fn("HomeMemClient.socketPath")(function* () {
      const config = yield* loadConfig()
      return HomeMemConfig.defaultSocket(config.database)
    })

    const connect = (path: string) =>
      Effect.callback<Socket, Error>((resume) => {
        const socket = createConnection({ path })
        const onConnect = () => {
          socket.off("error", onError)
          resume(Effect.succeed(socket))
        }
        const onError = (error: Error) => {
          socket.off("connect", onConnect)
          socket.destroy()
          resume(Effect.fail(error))
        }
        socket.once("connect", onConnect)
        socket.once("error", onError)
        return Effect.sync(() => {
          socket.off("connect", onConnect)
          socket.off("error", onError)
          socket.destroy()
        })
      })

    const startDaemon = Effect.fn("HomeMemClient.startDaemon")(function* (path: string) {
      const config = yield* loadConfig()
      const [command, ...args] = config.command
      if (!command) return undefined
      const child = spawn(command, [...args, "serve", "--database", config.database, "--socket", path], {
        stdio: "ignore",
        detached: true,
      })
      child.unref()
      child.on("error", (error) => log.warn("HomeMem daemon failed to start", { cause: error }))

      // The daemon binds asynchronously; poll the socket until it answers or the budget expires.
      const deadline = Date.now() + STARTUP_TIMEOUT_MS
      while (Date.now() < deadline) {
        const socket = yield* connect(path).pipe(Effect.option)
        if (socket._tag === "Some") return socket.value
        yield* Effect.sleep(25)
      }
      log.warn("HomeMem daemon did not accept connections in time", { socket: path })
      return undefined
    })

    const attachHandlers = (connection: Connection) => {
      const failAll = (error: Error) => {
        connection.closed = true
        for (const pending of connection.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(error)
        }
        connection.pending.clear()
      }

      connection.socket.setEncoding("utf8")
      connection.socket.on("data", (chunk: string) => {
        connection.buffer += chunk
        let index = connection.buffer.indexOf("\n")
        while (index !== -1) {
          const line = connection.buffer.slice(0, index)
          connection.buffer = connection.buffer.slice(index + 1)
          index = connection.buffer.indexOf("\n")
          if (!line.trim()) continue
          let message: { id?: unknown; ok?: boolean; result?: unknown; error?: string }
          try {
            message = JSON.parse(line)
          } catch (error) {
            log.warn("HomeMem daemon sent invalid JSON", { cause: error })
            continue
          }
          const id = typeof message.id === "number" ? message.id : undefined
          if (id === undefined) continue
          const pending = connection.pending.get(id)
          if (!pending) continue
          connection.pending.delete(id)
          clearTimeout(pending.timer)
          if (message.ok) pending.resolve(message.result)
          else pending.reject(new Error(message.error ?? "HomeMem request failed"))
        }
      })
      connection.socket.on("error", (error) => failAll(error))
      connection.socket.on("close", () => failAll(new Error("HomeMem daemon connection closed")))
    }

    const ensureConnection = Effect.fn("HomeMemClient.ensureConnection")(function* () {
      if (state.connection && !state.connection.closed) return state.connection
      // Coalesce concurrent callers so a burst of tool hooks starts at most one daemon.
      const starting =
        state.starting ??
        Effect.gen(function* () {
          const path = yield* socketPath()
          const existing = yield* connect(path).pipe(Effect.option)
          let socket = existing._tag === "Some" ? existing.value : undefined
          if (!socket) {
            const started = yield* startDaemon(path).pipe(Effect.option)
            socket = started._tag === "Some" ? started.value : undefined
          }
          if (!socket) return undefined
          const connection: Connection = { socket, pending: new Map(), buffer: "", nextID: 1, closed: false }
          attachHandlers(connection)
          state.connection = connection
          return connection
        }).pipe(Effect.onExit(() => Effect.sync(() => (state.starting = undefined))))
      state.starting = starting
      return yield* starting
    })

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const connection = state.connection
        state.connection = undefined
        if (!connection) return
        // The daemon is shared per database and self-terminates when idle, so the host only closes
        // its socket instead of signalling the process.
        connection.closed = true
        connection.socket.destroy()
        for (const pending of connection.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error("HomeMem client closed"))
        }
        connection.pending.clear()
      }),
    )

    const send = (connection: Connection, method: string, params: unknown, timeout: number) =>
      Effect.callback<unknown, Error>((resume) => {
        const id = connection.nextID++
        const timer = setTimeout(() => {
          connection.pending.delete(id)
          resume(Effect.fail(new Error(`HomeMem request timed out after ${timeout}ms: ${method}`)))
        }, timeout)
        connection.pending.set(id, {
          resolve: (value) => resume(Effect.succeed(value)),
          reject: (error) => resume(Effect.fail(error)),
          timer,
        })
        connection.socket.write(`${JSON.stringify({ id, method, params: params ?? null })}\n`, (error) => {
          if (!error) return
          connection.pending.delete(id)
          clearTimeout(timer)
          resume(Effect.fail(error))
        })
        return Effect.sync(() => {
          connection.pending.delete(id)
          clearTimeout(timer)
        })
      })

    const request = Effect.fn("HomeMemClient.request")(function* (
      method: string,
      params?: unknown,
      options?: { timeout?: number },
    ) {
      const timeout = options?.timeout ?? REQUEST_TIMEOUT_MS
      if (process.platform === "win32") {
        const config = yield* loadConfig()
        return yield* Effect.tryPromise({
          try: () => requestViaCli(config, method, params, timeout),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      }
      return yield* state.lock.withPermits(1)(
        Effect.gen(function* () {
          const connection = yield* ensureConnection()
          if (!connection) return yield* Effect.fail(new Error("HomeMem daemon is unavailable"))
          return yield* send(connection, method, params, timeout)
        }),
      )
    })

    const probe = Effect.fn("HomeMemClient.probe")(function* () {
      const result = yield* request("version").pipe(Effect.option)
      if (result._tag === "None") return undefined
      const value = result.value
      if (!isRecord(value) || typeof value.protocol_version !== "number") return undefined
      if (value.protocol_version !== PROTOCOL_VERSION) {
        log.warn("HomeMem protocol version mismatch", {
          expected: PROTOCOL_VERSION,
          received: value.protocol_version,
        })
        return undefined
      }
      return {
        protocolVersion: value.protocol_version,
        engineVersion: typeof value.engine_version === "string" ? value.engine_version : "unknown",
      }
    })

    const config = Effect.fn("HomeMemClient.config")(function* () {
      return yield* loadConfig()
    })


    return Service.of({ probe, config, request })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function requestViaCli(config: HomeMemConfig, method: string, params: unknown, timeout: number) {
  const [command, ...args] = config.command
  if (!command) return Promise.reject(new Error("HomeMem engine command is empty"))
  if (method === "version") {
    return new Promise<{ protocol_version: number; engine_version: string }>((resolve, reject) => {
      const child = spawn(command, [...args, "--version"], { stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`HomeMem CLI timed out after ${timeout}ms: ${method}`))
      }, timeout)
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("close", (code) => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(stderr.trim() || `HomeMem exited with status ${code}`))
        const version = /homemem (\S+) \(protocol (\d+)\)/i.exec(stdout)
        if (!version) return reject(new Error(`Unexpected HomeMem version output: ${stdout.trim()}`))
        resolve({ protocol_version: Number(version[2]), engine_version: version[1] })
      })
    })
  }
  const allowed = [
    "search",
    "write",
    "read",
    "status",
    "policy_list",
    "policy_evaluate",
    "policy_check",
    "skill_list",
  ]
  if (!allowed.includes(method)) {
    return Promise.reject(new Error(`HomeMem CLI does not support ${method}`))
  }
  const subtool = method === "policy_evaluate" ? "policy_check" : method
  const input = isRecord(params) ? { subtool, ...params, wing: params.scope ?? params.wing } : { subtool }
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(command, [...args, "memory", "--database", config.database], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`HomeMem CLI timed out after ${timeout}ms: ${method}`))
    }, timeout)
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(stderr.trim() || `HomeMem exited with status ${code}`))
      try {
        resolve(JSON.parse(stdout))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.stdin?.end(JSON.stringify(input))
  })
}

export * as HomeMemClient from "./client"
