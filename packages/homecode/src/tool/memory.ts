import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { encode } from "@toon-format/toon"
import DESCRIPTION from "./memory.txt"
import path from "node:path"

export const Parameters = Schema.Struct({
  subtool: Schema.Literals(["search", "write", "read", "status"]).annotate({
    description: "The HomeMem operation to perform.",
  }),
  query: Schema.optional(Schema.String).annotate({ description: "Search query. Required for search." }),
  wing: Schema.optional(Schema.String).annotate({
    description: "Optional evidence scope. Defaults to the current project name.",
  }),
  room: Schema.optional(Schema.String).annotate({ description: "Optional evidence topic filter." }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum search results (default 5, maximum 10)." }),
  content: Schema.optional(Schema.String).annotate({ description: "Explicit evidence to record. Required for write." }),
  agent_name: Schema.optional(Schema.String).annotate({
    description: "Evidence author. Defaults to the current agent.",
  }),
  last_n: Schema.optional(Schema.Number).annotate({
    description: "Number of recent explicit-evidence records to read (default 10).",
  }),
})

const Json = Schema.UnknownFromJsonString

export const MemoryTool = Tool.define(
  "memory",
  Effect.gen(function* () {
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const cfg = (yield* config.get()).experimental?.homemem
          const wing = params.wing ?? path.basename(instance.worktree)
          const invalid =
            params.subtool === "search" && !params.query
              ? "'query' is required for search."
              : params.subtool === "write" && !params.content
                ? "'content' is required for write."
                : undefined
          if (invalid) {
            return { title: "Memory Error", output: invalid, metadata: { subtool: params.subtool, wing } }
          }

          const request =
            params.subtool === "search"
              ? {
                  subtool: "search",
                  query: params.query,
                  wing,
                  room: params.room,
                  limit: Math.min(Math.max(params.limit ?? 5, 1), 10),
                }
              : params.subtool === "write"
                ? {
                    subtool: "write",
                    content: params.content,
                    wing,
                    room: params.room ?? "general",
                    author: params.agent_name ?? ctx.agent,
                    session_id: ctx.sessionID,
                  }
                : params.subtool === "read"
                  ? {
                      subtool: "read",
                      wing: params.wing,
                      author: params.agent_name ?? ctx.agent,
                      limit: Math.min(Math.max(params.last_n ?? params.limit ?? 10, 1), 100),
                    }
                  : { subtool: "status" }
          const result = yield* Effect.tryPromise({
            try: async () => {
              const process = Bun.spawn(
                [
                  ...(cfg?.command?.length ? cfg.command : ["homemem"]),
                  "memory",
                  "--database",
                  path.join(instance.worktree, ".homecode", "homemem", "homemem.sqlite3"),
                ],
                { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
              )
              process.stdin.write(JSON.stringify(request))
              process.stdin.end()
              const [code, stdout, stderr] = await Promise.all([
                process.exited,
                new Response(process.stdout).text(),
                new Response(process.stderr).text(),
              ])
              if (code !== 0) throw new Error(stderr.trim() || `HomeMem exited with status ${code}`)
              return { stdout, value: Schema.decodeUnknownOption(Json)(stdout) }
            },
            catch: (cause) => cause,
          }).pipe(Effect.option)

          if (Option.isNone(result)) {
            return {
              title: "Memory Error",
              output:
                "HomeMem is unavailable. Build or install the HomeMem executable and configure experimental.homemem.command.",
              metadata: { subtool: params.subtool, wing },
            }
          }
          if (Option.isNone(result.value.value)) {
            return {
              title: "Memory Error",
              output: `HomeMem returned invalid JSON: ${result.value.stdout.trim()}`,
              metadata: { subtool: params.subtool, wing },
            }
          }

          return {
            title:
              params.subtool === "search"
                ? `Memory Search: ${params.query}`
                : params.subtool === "write"
                  ? `Memory Write: ${wing}/${params.room ?? "general"}`
                  : params.subtool === "read"
                    ? "Memory Evidence"
                    : "Memory Status",
            output: encode(result.value.value.value),
            metadata: { subtool: params.subtool, wing },
          }
        }),
    }
  }),
)
