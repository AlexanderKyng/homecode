import { Effect, Cause, Context, Layer } from "effect"
import * as Log from "@homecode-ai/core/util/log"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"

const log = Log.create({ service: "microsandbox.instance" })

const DEFAULT_IMAGE = "debian"
const DEFAULT_MEMORY = 512
const DEFAULT_CPUS = 1
const DEFAULT_IDLE_TIMEOUT = 300
const SANDBOX_NAME_PREFIX = "homecode-shell"

export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
}

export interface Interface {
  exec(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeoutMs?: number,
  ): Effect.Effect<ExecutionResult, Error, never>
  destroy(): Effect.Effect<void, Error, never>
}

export class Service extends Context.Service<Service, Interface>()("@homecode/MicrosandboxInstance") {}

function makeSandboxName(directory: string): string {
  const hash = directory.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return `${SANDBOX_NAME_PREFIX}-${Math.abs(hash).toString(16).slice(0, 8)}`
}

function checkVirtualizationSupport(): Effect.Effect<void, Error, never> {
  return Effect.sync(() => {
    const platform = process.platform
    if (platform === "linux") return
    if (platform === "darwin") {
      const arch = process.arch
      if (arch !== "arm64") {
        throw new Error("Microsandbox requires macOS with Apple Silicon (M-series). Your system uses " + arch + ".")
      }
      return
    }
    if (platform === "win32") return
    throw new Error("Microsandbox is not supported on platform: " + platform)
  })
}

export const state = InstanceState.make<Interface, Error, never>((ctx) =>
  Effect.gen(function* () {
    yield* checkVirtualizationSupport()

    const sandboxName = makeSandboxName(ctx.directory)
    let sandbox: any = null

    const createSandbox = (): Effect.Effect<any, Error, never> =>
      Effect.promise(async () => {
        log.info("Creating Microsandbox instance", { sandboxName, workspace: ctx.directory })
        const mod = await import("microsandbox")
        const Sandbox = mod.Sandbox
        if (!Sandbox) throw new Error("Failed to load microsandbox Sandbox class")
        const sb = await Sandbox.builder(sandboxName)
          .image(DEFAULT_IMAGE)
          .cpus(DEFAULT_CPUS)
          .memory(DEFAULT_MEMORY)
          .idleTimeout(DEFAULT_IDLE_TIMEOUT)
          .volume("/workspace", (b: any) => {
            b.bind(ctx.directory)
            return b
          })
          .create()
        log.info("Microsandbox instance created", { sandboxName })
        return sb
      })

    const getOrCreateSandbox = (): Effect.Effect<any, Error, never> =>
      Effect.gen(function* () {
        if (sandbox) {
          try {
            yield* Effect.promise(() => sandbox.ping())
            return sandbox
          } catch {
            log.info("Sandbox unresponsive, recreating", { sandboxName })
            sandbox = null
          }
        }
        return yield* createSandbox()
      })

    const exec = (
      command: string,
      _cwd = "/workspace",
      _env?: Record<string, string>,
      timeoutMs = 2 * 60 * 1000,
    ): Effect.Effect<ExecutionResult, Error, never> =>
      Effect.gen(function* () {
        const sb = yield* getOrCreateSandbox()
        sandbox = sb

        log.info("Executing command in sandbox", { command: command.slice(0, 100) })

        const result = yield* Effect.promise(async () => {
          const output = await sb.shell(command)
          return {
            stdout: output.stdout() ?? "",
            stderr: output.stderr() ?? "",
            exitCode: output.exitCode() ?? null,
          }
        }).pipe(
          Effect.timeout(timeoutMs),
          Effect.catch((err) => {
            if (Cause.isTimeoutError(err)) {
              return Effect.succeed({
                stdout: "",
                stderr: "",
                exitCode: null,
                error: `Command timed out after ${timeoutMs}ms`,
              })
            }
            return Effect.fail(err as Error)
          }),
        )

        return result
      })

    const destroy = (): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const sb = sandbox
        sandbox = null
        if (!sb) return
        log.info("Destroying Microsandbox instance", { sandboxName })
        yield* Effect.promise(() => sb.stop()).pipe(Effect.catch(() => Effect.void))
      })

    yield* Effect.addFinalizer(() => destroy())

    return { exec, destroy }
  }).pipe(Effect.provideService(InstanceRef, ctx)),
)

export const layer: Layer.Layer<Service, Error, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const microsandboxState = yield* state

    const exec = (command: string, cwd?: string, env?: Record<string, string>, timeoutMs?: number) =>
      InstanceState.useEffect(microsandboxState, (api) => api.exec(command, cwd, env, timeoutMs))
    const destroy = () => InstanceState.useEffect(microsandboxState, (api) => api.destroy())
    InstanceState.useEffect(microsandboxState, (api) => api.destroy().pipe(Effect.catch(() => Effect.void)))

    return Service.of({ exec, destroy })
  }),
)

export * as MicrosandboxInstance from "./instance"
