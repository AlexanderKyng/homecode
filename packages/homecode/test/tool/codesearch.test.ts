import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { decode } from "@toon-format/toon"
import { CodeSearchTool } from "@/tool/codesearch"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { AppFileSystem } from "@homecode-ai/core/filesystem"
import { SessionID, MessageID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const mockHttp = HttpClient.make((request) => {
  const url = request.url
  const queryParam = request.urlParams ? JSON.stringify(request.urlParams) : ""
  if (url.includes("nonexistent") || queryParam.includes("nonexistent")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    )
  }

  if (url.includes("/search")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Drizzle ORM sqliteTable Docs",
                url: "https://orm.drizzle.team/docs/sqlite",
                snippet: "Define SQLite tables in Drizzle with typed column definitions.",
                engine: "github",
              },
              {
                title: "Duplicate Link",
                url: "https://orm.drizzle.team/docs/sqlite?utm_source=searxng",
                snippet: "Duplicate of the sqlite documentation.",
                engine: "stackoverflow",
              },
              {
                title: "StackOverflow: Drizzle SQLite snake_case",
                url: "https://stackoverflow.com/questions/12345/drizzle-sqlite",
                snippet: "Use snake_case for column names to avoid redefining strings.",
                engine: "stackoverflow",
              },
            ],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      ),
    )
  }

  // Fallback for selective page fetch
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(
        `<html>
          <body>
            <h1>Drizzle SQLite Guide</h1>
            <p>SQLite table definitions in Drizzle ORM:</p>
            <pre><code class="language-typescript">export const users = sqliteTable("users", { id: text().primaryKey() });</code></pre>
          </body>
        </html>`,
        { headers: { "content-type": "text/html" }, status: 200 },
      ),
    ),
  )
})

const layer = Layer.mergeAll(
  Layer.succeed(HttpClient.HttpClient, mockHttp),
  Agent.defaultLayer,
  AppFileSystem.defaultLayer,
  Truncate.defaultLayer,
)

const it = testEffect(layer)

describe("CodeSearch Tool", () => {
  it.instance("deduplicates URLs and reranks technical results", () =>
    Effect.gen(function* () {
      const info = yield* CodeSearchTool
      const tool = yield* info.init()

      const res = yield* tool.execute(
        { query: "drizzle sqliteTable snake_case column", category: "all", maxResults: 5 },
        ctx,
      )

      expect(res.title).toContain("Code Search: drizzle sqliteTable")
      const decoded = decode(res.output) as any
      expect(decoded.query_executed).toBe("drizzle sqliteTable snake_case column")
      expect(decoded.results_count).toBe(2) // Deduplicated from 3 to 2
      expect(decoded.results[0].title).toBeDefined()
      expect(decoded.results[0].score).toBeGreaterThan(0)
    }),
  )

  it.instance("handles empty search results cleanly", () =>
    Effect.gen(function* () {
      const info = yield* CodeSearchTool
      const tool = yield* info.init()

      const res = yield* tool.execute(
        { query: "nonexistent query xyz 123", category: "repos", maxResults: 5 },
        ctx,
      )

      const decoded = decode(res.output) as any
      expect(decoded.status).toBe("no_results")
    }),
  )
})
