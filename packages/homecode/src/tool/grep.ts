import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import * as HomeGrepService from "@/homegrep/service"
import { Ripgrep } from "@/file/ripgrep"
import { PositiveInt } from "@homecode-ai/core/schema"
import * as Tool from "./tool"
import DESCRIPTION from "./grep.txt"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "What to find in the current workspace; describe concepts for hybrid search or provide a literal/regex for exact search",
  }),
  mode: Schema.optional(Schema.Literals(["hybrid", "exact"])).annotate({
    description: 'Search mode. Use "hybrid" (default) for conceptual or open-ended searches; use "exact" for literal, regex, or exhaustive matches.',
  }),
  include: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional file glob filters, for example **/*.ts or **/*.{ts,tsx}",
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of results to return",
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const ripgrep = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const mode = params.mode ?? "hybrid"
          const settings = yield* config.get()
          const root = (yield* InstanceState.context).directory
          yield* ctx.metadata({
            title: `Search workspace (${mode}): ${params.query}`,
            metadata: { mode, limit: params.limit, include: params.include, root },
          })
          yield* ctx.ask({
            permission: "grep",
            patterns: [params.query],
            always: ["*"],
            metadata: { mode, include: params.include, limit: params.limit },
          })

          if (mode === "exact") {
            const result = yield* ripgrep
              .search({
                cwd: root,
                pattern: params.query,
                glob: params.include ? [...params.include] : undefined,
                limit: params.limit,
                signal: ctx.abort,
              })
              .pipe(
                Effect.map((result) => ({
                  output: result.items.length
                    ? result.items.map((item) => `${item.path.text}:${item.line_number}:${item.lines.text}`).join("\n")
                    : "No exact matches found.",
                  partial: result.partial,
                  count: result.items.length,
                })),
                Effect.catch((error) =>
                  Effect.succeed({
                    output: `Exact search failed: ${String(error)}`,
                    partial: false,
                    count: 0,
                    error: "exact_search_failed",
                  }),
                ),
              )

            return toolResult(`Exact search: ${params.query}`, result.output, {
              mode,
              root,
              partial: result.partial,
              count: result.count,
              error: "error" in result ? result.error : undefined,
            })
          }

          if (settings.homegrep?.enabled === false) {
            return toolResult(
              "HomeGrep is disabled",
              'HomeGrep is disabled for this workspace. Set "homegrep.enabled": true to use hybrid search, or call grep with mode: "exact".',
              { mode: "hybrid", root, error: "disabled" },
            )
          }

          const service = yield* HomeGrepService.get(root).pipe(Effect.orDie)
          const result = yield* Effect.tryPromise({
            try: async (signal) => {
              const activeSignal = ctx.abort ? AbortSignal.any([ctx.abort, signal]) : signal
              const info = await service.info({ root, includeStatus: false })
              if (info.indexPolicy === "disabled") {
                return toolResult(
                  "HomeGrep is disabled",
                  'HomeGrep indexing is disabled for this workspace. Enable the HomeGrep index or call grep with mode: "exact".',
                  { mode: "hybrid", root, error: "disabled", indexPath: info.indexPath },
                )
              }
              if (!info.indexed) {
                await HomeGrepService.ensureIndexed(root, service)
              }

              const result = await service.context({
                root,
                query: params.query,
                globs: params.include,
                limit: params.limit,
                autoUpdate: true,
                signal: activeSignal,
              })
              return toolResult(
                `HomeGrep: ${params.query}`,
                result.items.length
                  ? result.items
                      .map((item) => {
                        const lineRange = item.range.kind === "text" ? `:${item.range.startLine}-${item.range.endLine}` : ""
                        const score = item.score === undefined ? "" : ` score=${item.score.toFixed(3)}`
                        return `${item.rank}. ${item.file.relativePath}${lineRange} [${item.matchedBy}; ${item.status}${score}]\n${item.content}`
                      })
                      .join("\n\n")
                  : "No HomeGrep matches found.",
                {
                  mode: "hybrid",
                  root,
                  source: result.source,
                  coverage: result.coverage,
                  count: result.items.length,
                  workspaceIndex: result.workspaceIndex,
                  diagnostics: result.diagnostics,
                  error: undefined,
                },
              )
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }).pipe(
            Effect.match({
              onSuccess: (result) => result,
              onFailure: (error) => toolResult(
                ctx.abort?.aborted ? "HomeGrep search cancelled" : "HomeGrep search failed",
                ctx.abort?.aborted
                  ? "The HomeGrep search was cancelled."
                  : `HomeGrep could not search this workspace: ${error.message}. No exact-search fallback was run. Retry with grep mode: "exact" if appropriate.`,
                { mode: "hybrid", root, error: ctx.abort?.aborted ? "cancelled" : "search_failed" },
              ),
            }),
          )
          return result
        }),
    }
  }),
)

function toolResult(title: string, output: string, metadata: Record<string, unknown>) {
  return { title, output, metadata }
}
