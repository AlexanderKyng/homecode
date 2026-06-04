import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { Service, type Interface } from "./sandbox"
import DESCRIPTION from "./python.txt"

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "Python code to execute in the sandbox",
  }),
  command: Schema.optional(Schema.String).annotate({
    description: "Shell command to run inside the sandbox (e.g., 'pip install requests')",
  }),
  read_file: Schema.optional(Schema.String).annotate({
    description: "Path of a file to read inside the sandbox",
  }),
  write_file: Schema.optional(
    Schema.Struct({
      path: Schema.String.annotate({ description: "File path inside the sandbox" }),
      content: Schema.String.annotate({ description: "File content to write" }),
    }),
  ).annotate({
    description: "Write content to a file inside the sandbox",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Execution timeout in seconds (default: 60)",
  }),
  reset: Schema.optional(Schema.Boolean).annotate({
    description: "Reset the Python execution context, clearing all variables and imports (default: false)",
  }),
})

type Metadata = {
  executionTimeMs?: number
  exitCode?: number | null
  filePath?: string
  hasError?: boolean
  hasResult?: boolean
}

export const makePythonTool = (sandbox: Interface) => Tool.define(
  "python",
  Effect.gen(function* () {
    return () =>
      Effect.gen(function* () {
        return {
          description: DESCRIPTION,
          parameters: Parameters,
          execute: (
            params: Schema.Schema.Type<typeof Parameters>,
            _ctx: Tool.Context,
          ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
            Effect.gen(function* () {
              if (params.reset) {
                yield* sandbox.reset()
              }

              if (params.command) {
                const timeout = params.timeout ?? 60
                const result = yield* sandbox.executeShell(params.command, timeout)
                const parts = []
                if (result.stdout) parts.push(`**stdout**:\n\`\`\`\n${result.stdout}\n\`\`\``)
                if (result.stderr) parts.push(`**stderr**:\n\`\`\`\n${result.stderr}\n\`\`\``)
                parts.push(`Exit code: ${result.exitCode}`)
                if (result.error) parts.push(`Error: ${result.error}`)
                return {
                  title: `Shell: ${params.command}`,
                  output: parts.join("\n\n"),
                  metadata: { exitCode: result.exitCode, hasError: !!result.error } as Metadata,
                }
              }

              if (params.read_file) {
                const content = yield* sandbox.readFile(params.read_file)
                return {
                  title: `Read: ${params.read_file}`,
                  output: `\`\`\`\n${content}\n\`\`\``,
                  metadata: { filePath: params.read_file } as Metadata,
                }
              }

              if (params.write_file) {
                yield* sandbox.writeFile(params.write_file.path, params.write_file.content)
                return {
                  title: `Write: ${params.write_file.path}`,
                  output: `File written successfully to ${params.write_file.path}`,
                  metadata: { filePath: params.write_file.path } as Metadata,
                }
              }

              if (params.code) {
                const result = yield* sandbox.executePython(params.code, params.timeout ?? 60)
                const parts = []
                if (result.error) parts.push(`**Error**:\n\`\`\`python\n${result.error}\n\`\`\``)
                if (result.stdout) parts.push(`**stdout**:\n\`\`\`\n${result.stdout}\n\`\`\``)
                if (result.stderr) parts.push(`**stderr**:\n\`\`\`\n${result.stderr}\n\`\`\``)
                if (result.result && !result.error) parts.push(`**result**:\n\`\`\`\n${result.result}\n\`\`\``)
                if (result.executionTimeMs) parts.push(`\nExecution time: ${result.executionTimeMs}ms`)

                const attachments: Tool.ExecuteResult["attachments"] = result.plots.map((plot, i) => ({
                  type: "file",
                  mime: "image/png",
                  filename: `plot_${i + 1}.png`,
                  url: plot,
                }))

                if (attachments.length > 0) {
                  parts.push(`\nGenerated ${attachments.length} plot(s).`)
                }

                const titlePrefix = params.code.slice(0, 80)
                return {
                  title: `Python: ${titlePrefix}${params.code.length > 80 ? "..." : ""}`,
                  output: parts.join("\n\n"),
                  attachments,
                  metadata: {
                    executionTimeMs: result.executionTimeMs,
                    hasError: !!result.error,
                    hasResult: !!result.result,
                    plotsCount: result.plots.length,
                  } as Metadata,
                }
              }

              return {
                title: "Python",
                output: "Provide 'code', 'command', 'read_file', or 'write_file' to perform an action.",
                metadata: {} as Metadata,
              }
            }).pipe(Effect.orDie) as Effect.Effect<Tool.ExecuteResult<Metadata>>,
        }
      })
  }),
)
