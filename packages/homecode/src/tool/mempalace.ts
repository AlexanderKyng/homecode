import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { encode } from "@toon-format/toon"
import DESCRIPTION from "./mempalace.txt"
import path from "path"
import { fileURLToPath } from "url"

export const Parameters = Schema.Struct({
  subtool: Schema.Literals(["search", "write", "read", "status"]).annotate({
    description:
      'The operation to perform: "search" for semantic search, "write" to store content, "read" for diary entries, "status" for overview',
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for the 'search' subtool (required when subtool is search)",
  }),
  wing: Schema.optional(Schema.String).annotate({
    description:
      "MemPalace wing (project scope). Defaults to current project directory name. Specify only when searching outside the current project.",
  }),
  room: Schema.optional(Schema.String).annotate({
    description: "MemPalace room (aspect: decisions, technical, architecture...). Optional filter for search.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum results to return (default: 5, max: 10). Used by search and read subtools.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "Verbatim content to store. Required when subtool is write.",
  }),
  agent_name: Schema.optional(Schema.String).annotate({
    description: "Agent name for diary read. Defaults to the current agent. Required when subtool is read.",
  }),
  last_n: Schema.optional(Schema.Number).annotate({
    description: "Number of recent diary entries to read (default: 10). Used by read subtool.",
  }),
})

const _dirname = path.dirname(fileURLToPath(import.meta.url))
const HELPER_PATH = path.join(_dirname, "mempalace_helper.py")

function runHelper(input: Record<string, unknown>) {
  return Effect.promise(() => {
    const proc = Bun.spawn(["python3", HELPER_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()

    return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
      ([stdout, stderr, code]) => ({ stdout, stderr, code }),
    )
  })
}

export const MempalaceTool = Tool.define(
  "memory",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const ins = yield* InstanceState.context
        const wing = params.wing ?? path.basename(ins.worktree)
        const agentName = params.agent_name ?? ctx.agent

        const subtool = params.subtool

        let cmd: Record<string, unknown>
        if (subtool === "search") {
          if (!params.query) {
            return {
              title: "Memory Search",
              output: "Error: 'query' is required for the search subtool.",
              metadata: { subtool, wing },
            }
          }
          cmd = {
            subtool: "search",
            query: params.query,
            limit: params.limit ?? 5,
          }
          if (wing) cmd.wing = wing
          if (params.room) cmd.room = params.room
        } else if (subtool === "write") {
          if (!params.content) {
            return {
              title: "Memory Write",
              output: "Error: 'content' is required for the write subtool.",
              metadata: { subtool, wing },
            }
          }
          cmd = {
            subtool: "write",
            wing,
            room: params.room ?? "general",
            content: params.content,
          }
        } else if (subtool === "read") {
          cmd = {
            subtool: "read",
            agent_name: agentName,
            last_n: params.last_n ?? 10,
          }
          if (params.wing) cmd.wing = params.wing
        } else {
          cmd = { subtool: "status" }
        }

        const { stdout, stderr, code } = yield* runHelper(cmd)

        if (code !== 0) {
          return {
            title: "Memory Error",
            output: `MemPalace helper failed: ${stderr || stdout.trim()}`,
            metadata: { subtool, wing },
          }
        }

        let result: Record<string, unknown>
        try {
          result = JSON.parse(stdout.trim())
        } catch {
          result = { raw_output: stdout.trim() }
        }

        if (result.error === "install") {
          return {
            title: "Memory — Not Installed",
            output:
              "MemPalace is not installed. This tool provides persistent memory across sessions: search past decisions, store learnings, maintain an agent diary that survives context resets.\n\n" +
              "Install with: `pip install mempalace`\n\n" +
              "Would you like me to proceed with the installation?",
            metadata: { subtool, wing },
          }
        }

        if (result.error) {
          return {
            title: "Memory Error",
            output: `MemPalace error: ${String(result.error)}`,
            metadata: { subtool, wing },
          }
        }

        const toon = encode(result)
        const title =
          subtool === "search"
            ? `Memory Search: ${params.query ?? ""}`
            : subtool === "write"
              ? `Memory Write: ${wing}/${params.room ?? "general"}`
              : subtool === "read"
                ? `Memory Diary: ${agentName}`
                : "Memory Status"

        return {
          title,
          output: toon,
          metadata: { subtool, wing },
        }
      }),
  }),
)
