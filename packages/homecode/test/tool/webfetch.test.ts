import { afterEach, beforeEach, describe, expect } from "bun:test"
import dns from "dns/promises"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { decode } from "@toon-format/toon"
import { WebFetchTool } from "@/tool/webfetch"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { AppFileSystem } from "@homecode-ai/core/filesystem"
import { SessionID, MessageID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { disposeAllInstances } from "../fixture/fixture"

afterEach(async () => {
  dns.lookup = originalLookup
  await disposeAllInstances()
})

const originalLookup = dns.lookup

beforeEach(() => {
  dns.lookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof dns.lookup
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
const redirectHttp = HttpClient.make((request) => {
  if (request.url.includes("redirect-to-public")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/final" },
        }),
      ),
    )
  }
  if (request.url.includes("redirect-to-private")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:8080/secret" },
        }),
      ),
    )
  }

  if (request.url.includes("not-found")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response("missing", { status: 404, headers: { "content-type": "text/plain" } }),
      ),
    )
  }

  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response("<html><body><h1>Redirected Page</h1><p>Safe content.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ),
  )
})

const mockHttp = HttpClient.make((request) => {
  const url = request.url
  if (url.includes("schema")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          `<html>
            <head><title>Effect Schema Documentation</title></head>
            <body>
              <h1>Effect Schema Guide</h1>
              <p>Schema.decodeUnknownEffect transforms unknown input into validated structures.</p>
              <pre><code class="language-typescript">const User = Schema.Struct({ id: Schema.Number });</code></pre>
            </body>
          </html>`,
          { headers: { "content-type": "text/html" }, status: 200 },
        ),
      ),
    )
  }

  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(
        `<html>
          <body>
            <h1>Large Documentation Page</h1>
            <h2>Configuration Details</h2>
            <p>To configure SQLite cache, set CACHE_MAX_SIZE=5000 in environment.</p>
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

const edgeLayer = Layer.mergeAll(
  Layer.succeed(HttpClient.HttpClient, redirectHttp),
  Agent.defaultLayer,
  AppFileSystem.defaultLayer,
  Truncate.defaultLayer,
)
const edgeIt = testEffect(edgeLayer)

const it = testEffect(layer)

describe("WebFetch Tool", () => {
  it.instance("blocks SSRF attempts to private networks", () =>
    Effect.gen(function* () {
      const info = yield* WebFetchTool
      const tool = yield* info.init()

      const exit = yield* tool.execute({ url: "http://127.0.0.1:8080/secret" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("fetches and parses web content into TOON format", () =>
    Effect.gen(function* () {
      const info = yield* WebFetchTool
      const tool = yield* info.init()

      const res = yield* tool.execute(
        { url: "https://effect.website/docs/schema/webfetch-test", format: "markdown" },
        ctx,
      )

      expect(res.title).toContain("Effect Schema")
      const decoded = decode(res.output) as any
      expect(decoded.url).toBe("https://effect.website/docs/schema/webfetch-test")
      expect(decoded.content).toContain("Schema.decodeUnknownEffect transforms unknown input")
      expect(decoded.content).toContain("```typescript")
    }),
  )

  it.instance("extracts query-focused highlights when query parameter is provided", () =>
    Effect.gen(function* () {
      const info = yield* WebFetchTool
      const tool = yield* info.init()

      const res = yield* tool.execute(
        { url: "https://example.com/config-docs", query: "SQLite cache configuration" },
        ctx,
      )

      const decoded = decode(res.output) as any
      expect(decoded.highlights).toBeDefined()
      const highlightsStr = Array.isArray(decoded.highlights)
        ? decoded.highlights.join(" ")
        : String(decoded.highlights)
      expect(highlightsStr).toContain("5000")
      expect(highlightsStr).toContain("Configuration Details")
    }),
  )
  edgeIt.instance("follows public redirects and reports the resolved URL", () =>
    Effect.gen(function* () {
      const info = yield* WebFetchTool
      const tool = yield* info.init()

      const result = yield* tool.execute({ url: "https://example.com/redirect-to-public" }, ctx)
      const decoded = decode(result.output) as any
      expect(decoded.url).toBe("https://example.com/final")
    }),
  )

  edgeIt.instance("rejects redirects to private networks", () =>
    Effect.gen(function* () {
      const info = yield* WebFetchTool
      const tool = yield* info.init()

      const exit = yield* tool.execute({ url: "https://example.com/redirect-to-private" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("does not reuse cached markdown for a text request", () =>
    Effect.gen(function* () {
      const info = yield* WebFetchTool
      const tool = yield* info.init()

      yield* tool.execute({ url: "https://example.com/format-cache", format: "markdown" }, ctx)
      const result = yield* tool.execute({ url: "https://example.com/format-cache", format: "text" }, ctx)
      const decoded = decode(result.output) as any
      expect(decoded.content).not.toContain("```")
    }),
  )
})
