import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HomeSitterAdapter } from "../../src/homesitter/adapter"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(HomeSitterAdapter.defaultLayer)

describe("HomeSitterAdapter", () => {
  it.instance(
    "indexes in the background and returns mechanical evidence after readiness",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(`${test.directory}/src/context.ts`, "export function assembleContext() {}\n"),
        )
        yield* Effect.promise(() => Bun.write(`${test.directory}/src/context.test.ts`, 'test("context", () => {})\n'))

        const adapter = yield* HomeSitterAdapter.Service
        const first = yield* adapter.dynamicContext({ query: "assemble context", tokenBudget: 100 })
        expect(first).toEqual([])

        const status = yield* pollWithTimeout(
          adapter.status().pipe(Effect.map((value) => (value?.structural === "ready" ? value : undefined))),
          "HomeSitter did not become ready",
        )
        expect(status.lexical).toBe("ready")
        const semanticStatus = yield* pollWithTimeout(
          adapter.status().pipe(Effect.map((value) => (value?.semantic && value.semantic > 0 ? value : undefined))),
          "HomeSitter semantic indexing did not make progress",
        )
        expect(semanticStatus.semantic).toBeGreaterThan(0)

        const blocks = yield* adapter.dynamicContext({ query: "assemble context", tokenBudget: 100 })
        expect(blocks[0]?.source).toBe("homesitter")
        expect(blocks[0]?.text).toContain("path: src/context.ts")
        expect(blocks[0]?.text).toContain("scores: structural=")
      }),
    { config: { experimental: { homesitter: { automatic: true } } } },
  )

  it.instance(
    "keeps semantic indexing disabled when configured off",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(`${test.directory}/src/context.ts`, "export function assembleContext() {}\n"),
        )

        const adapter = yield* HomeSitterAdapter.Service
        const first = yield* adapter.dynamicContext({ query: "assemble context", tokenBudget: 100 })
        expect(first).toEqual([])

        const status = yield* pollWithTimeout(
          adapter.status().pipe(Effect.map((value) => (value?.structural === "ready" ? value : undefined))),
          "HomeSitter did not become ready",
        )
        expect(status.semantic).toBe(0)

        const blocks = yield* adapter.dynamicContext({ query: "assemble context", tokenBudget: 100 })
        expect(blocks[0]?.source).toBe("homesitter")
      }),
    { config: { experimental: { homesitter: { automatic: true, semantic_backend: "off" } } } },
  )
})
