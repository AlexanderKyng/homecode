import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { exaAuthHeaders, parseResponse } from "../../src/tool/mcp-websearch"
import {
  selectWebSearchProvider,
  webSearchModelName,
  webSearchProviderLabel,
  WebSearchTool,
} from "../../src/tool/websearch"
import { ProviderID } from "../../src/provider/schema"
import { webSearchEnabled } from "../../src/tool/registry"
import { testEffect } from "../lib/effect"
import { decode } from "@toon-format/toon"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { AppFileSystem } from "@homecode-ai/core/filesystem"
import { SessionID, MessageID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"

const SESSION_ID = "ses_0196aabbccddeeff001122334455"

describe("websearch provider", () => {
  test("selects a stable provider per session", () => {
    expect(selectWebSearchProvider(SESSION_ID)).toBe(selectWebSearchProvider(SESSION_ID))
  })

  test("supports an operational override", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER

    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "parallel"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("parallel")

      process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("exa")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("routes to Exa when the Exa flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: true, parallel: false })).toBe("exa")
  })

  test("routes to Parallel when the Parallel flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: true })).toBe("parallel")
  })

  test("is always enabled via local SearXNG", () => {
    expect(webSearchEnabled(ProviderID.homecode, { exa: false, parallel: false })).toBe(true)
    expect(webSearchEnabled(ProviderID.openai, { exa: false, parallel: false })).toBe(true)
    expect(webSearchEnabled(ProviderID.openai, { exa: true, parallel: false })).toBe(true)
    expect(webSearchEnabled(ProviderID.openai, { exa: false, parallel: true })).toBe(true)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })

  test("uses the provider API model id for Parallel analytics", () => {
    expect(
      webSearchModelName({
        model: {
          id: "claude-opus-4-7",
          api: { id: "claude-opus-4.7" },
        },
      }),
    ).toBe("claude-opus-4.7")
  })
})
test("uses an API-key header for Exa instead of putting the key in the URL", () => {
  const original = process.env.EXA_API_KEY

  try {
    process.env.EXA_API_KEY = "test-exa-key"
    expect(exaAuthHeaders()).toEqual({ "x-api-key": "test-exa-key" })
  } finally {
    if (original === undefined) delete process.env.EXA_API_KEY
    else process.env.EXA_API_KEY = original
  }
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  const it = testEffect(Layer.empty)

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )
  it.effect("skips malformed JSON frames and finds a later valid result", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: {"jsonrpc":"2.0","method":"notification"}\ndata: ${payload}`)
      expect(result).toBe("search results")
    }),
  )
})

describe("websearch local engine execution", () => {
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
    if (url.includes("/search")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              results: [
                {
                  title: "Effect Schema Documentation",
                  url: "https://effect.website/docs/schema",
                  snippet: "Official guide for Effect-TS Schema decoding and encoding.",
                  engine: "bing",
                },
                {
                  title: "Effect Schema Duplicate",
                  url: "https://effect.website/docs/schema?ref=duckduckgo",
                  snippet: "Duplicate schema link.",
                  engine: "duckduckgo",
                },
                {
                  title: "Unrelated Weather Page",
                  url: "https://weather.com/paris",
                  snippet: "Weather forecast for Paris France.",
                  engine: "mojeek",
                },
              ],
            }),
            { headers: { "content-type": "application/json" }, status: 200 },
          ),
        ),
      )
    }

    // Response for selective fetch
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          `<html>
            <body>
              <h1>Effect Schema Guide</h1>
              <p>Schema.decodeUnknownEffect transforms unknown input into validated structures with typed error channels.</p>
            </body>
          </html>`,
          { headers: { "content-type": "text/html" }, status: 200 },
        ),
      ),
    )
  })

  const testLayer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, mockHttp),
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    Truncate.defaultLayer,
    RuntimeFlags.defaultLayer,
  )

  const it = testEffect(testLayer)

  it.instance("executes local SearXNG search with deduplication, reranking and highlights in TOON", () =>
    Effect.gen(function* () {
      const info = yield* WebSearchTool
      const tool = yield* info.init()

      const res = yield* tool.execute({ query: "Effect Schema decodeUnknownEffect", numResults: 5, type: "auto" }, ctx)

      expect(res.title).toContain("SearXNG Web Search: Effect Schema decodeUnknownEffect")
      const decoded = decode(res.output) as any
      expect(decoded.query).toBe("Effect Schema decodeUnknownEffect")
      expect(decoded.results).toBeDefined()
      expect(decoded.results.length).toBe(2) // Deduplicated from 3 to 2
      expect(decoded.results[0].title).toBe("Effect Schema Documentation")
      expect(decoded.results[0].score).toBeGreaterThan(0)
    }),
  )
})
