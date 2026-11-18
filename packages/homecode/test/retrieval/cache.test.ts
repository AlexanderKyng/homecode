import { describe, expect, it } from "bun:test"
import { make as makeCache } from "@/retrieval/cache"
import { Effect } from "effect"
import os from "os"
import path from "path"
import fs from "fs/promises"

describe("Retrieval Cache", () => {
  it("stores and retrieves search queries with TTL", async () => {
    const tmpDb = path.join(os.tmpdir(), `test_retrieval_${Date.now()}_1.db`)
    const cache = makeCache(tmpDb)

    const queryKey = "search:effect-ts:auto:8"
    const queryData = { results: [{ title: "Effect TS Docs", url: "https://effect.website" }] }

    // Initially empty
    const initial = await Effect.runPromise(cache.getQuery(queryKey))
    expect(initial).toBeNull()

    // Store query
    await Effect.runPromise(cache.setQuery(queryKey, queryData, 10))

    // Retrieve query
    const retrieved = await Effect.runPromise(cache.getQuery(queryKey))
    expect(retrieved).toEqual(queryData)

    // Expired query
    await Effect.runPromise(cache.setQuery("search:expired", { test: 1 }, -1))
    const expired = await Effect.runPromise(cache.getQuery("search:expired"))
    expect(expired).toBeNull()

    await fs.unlink(tmpDb).catch(() => {})
  })

  it("stores and retrieves fetched documents", async () => {
    const tmpDb = path.join(os.tmpdir(), `test_retrieval_${Date.now()}_2.db`)
    const cache = makeCache(tmpDb)

    const doc = {
      url: "https://example.com/article",
      title: "Sample Article",
      content: "# Heading\n\nContent here.",
      contentType: "text/html",
      status: 200,
    }

    await Effect.runPromise(cache.setDocument(doc, 3600))

    const retrieved = await Effect.runPromise(cache.getDocument(doc.url))
    expect(retrieved).not.toBeNull()
    expect(retrieved?.url).toBe(doc.url)
    expect(retrieved?.title).toBe(doc.title)
    expect(retrieved?.content).toBe(doc.content)

    await fs.unlink(tmpDb).catch(() => {})
  })
})
