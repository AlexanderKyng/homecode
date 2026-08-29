import { Effect, Layer } from "effect"
import * as Tool from "../tool"
import { ShellID } from "../shell/id"
import { ShellPrompt, type Parameters } from "../shell/prompt"
import { MicrosandboxInstance } from "./instance"
import * as Log from "@homecode-ai/core/util/log"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"

export { Parameters } from "../shell/prompt"

const log = Log.create({ service: "microsandbox-shell-tool" })

const layer = MicrosandboxInstance.layer.pipe(Layer.orDie)

export const MicrosandboxShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    return () =>
      Effect.gen(function* () {
        yield* config.get()
        const limits = { maxLines: 2000, maxBytes: 50 * 1024 }
        const prompt = ShellPrompt.render("bash", "linux", limits, defaultTimeoutMs)
        log.info("microsandbox shell tool initialized")

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const timeout = params.timeout ?? defaultTimeoutMs
              const instance = yield* MicrosandboxInstance.Service

              log.info("executing command", { command: params.command.slice(0, 100), timeout })

              const result = yield* instance.exec(params.command, undefined, undefined, timeout)

              let output = result.stdout
              if (result.stderr) {
                output += result.stderr
              }
              if (!output.trim()) output = "(no output)"

              const meta: string[] = []
              if (result.error) meta.push(result.error)

              if (meta.length > 0) {
                output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
              }

              return {
                title: params.description,
                metadata: {
                  output: output.slice(0, 30_000),
                  exit: result.exitCode,
                  description: params.description,
                },
                output,
              }
            }).pipe(Effect.orDie),
        }
      })
  }).pipe(Effect.provide(layer)),
)

export * as MicrosandboxShellToolModule from "./shell"
