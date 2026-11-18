import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import {
  deserializeIndex,
  indexSemantic,
  indexRepository,
  indexStatus,
  loadEmbeddingRecords,
  relatedFiles,
  search,
  serializeIndex,
  symbol,
  saveEmbeddingRecords,
  testsFor,
} from "../../src/homesitter"
import { tmpdir } from "../fixture/fixture"

const resources: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource[Symbol.asyncDispose]()))
})

describe("HomeSitter", () => {
  test("builds deterministic structural and lexical evidence", async () => {
    const repo = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "src", "context.ts"),
          `import { HomeMem } from "./memory"\n\nexport function assembleContext(input: string) {\n  return input\n}\n`,
        )
        await Bun.write(path.join(dir, "src", "memory.ts"), "export const HomeMem = {}\n")
        await Bun.write(
          path.join(dir, "src", "context.test.ts"),
          `import { assembleContext } from "./context"\ntest("assembles context", () => assembleContext("ok"))\n`,
        )
        await Bun.write(path.join(dir, "node_modules", "ignored.ts"), "export function ignored() {}\n")
      },
    })
    resources.push(repo)

    const index = await indexRepository({ root: repo.path, repositoryId: "fixture" })
    const repeat = await indexRepository({ root: repo.path, repositoryId: "fixture" })
    const result = search(index, "assemble context")

    expect(indexStatus(index)).toMatchObject({ structural: "ready", lexical: "ready", semantic: 0, lsp: "unavailable" })
    expect(index.files.map((file) => file.path)).not.toContain("node_modules/ignored.ts")
    expect(result[0]?.path).toBe("src/context.ts")
    expect(result[0]?.evidence.symbolMatches).toEqual(["assembleContext"])
    expect(result[0]?.evidence.importedBy).toEqual(["src/context.test.ts"])
    expect(result[0]?.semanticCoverage).toBe(0)
    expect(serializeIndex(index)).toBe(serializeIndex(repeat))
    expect(deserializeIndex(serializeIndex(index))).toEqual(index)
  })

  test("reuses unchanged files and invalidates only changed units", async () => {
    const repo = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "src", "one.ts"),
          "export function one() { return 1 }\nexport function two() { return 2 }\n",
        )
      },
    })
    resources.push(repo)

    const first = await indexRepository({ root: repo.path, repositoryId: "fixture" })
    await Bun.write(
      path.join(repo.path, "src", "one.ts"),
      "export function one() { return 9 }\nexport function two() { return 2 }\n",
    )
    const second = await indexRepository({ root: repo.path, repositoryId: "fixture", previous: first })

    expect(second.status.reusedFiles).toBe(0)
    expect(second.status.reusedUnits).toBe(1)
    expect(symbol(first, "two")[0]?.id).toBe(symbol(second, "two")[0]?.id)
    expect(symbol(first, "one")[0]?.id).not.toBe(symbol(second, "one")[0]?.id)
  })

  test("indexes deterministic semantic units incrementally and persists progress", async () => {
    const repo = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "src", "context.ts"),
          "export function assembleContext(input: string) { return input }\nexport function untouched() { return 1 }\n",
        )
      },
    })
    resources.push(repo)

    const initial = await indexRepository({ root: repo.path, repositoryId: "fixture" })
    const full = await indexSemantic(initial, { batchSize: 1 })
    const first = full.units[0]!
    const untouched = full.units.find((unit) => unit.name === "untouched")!

    expect(full.status.semantic).toBe(100)
    expect(Object.values(full.embeddings ?? {})).toHaveLength(full.units.length)
    expect(full.embeddings?.[first.id]?.modelId).toBe("homesitter-feature")
    expect(full.embeddings?.[first.id]?.vector).toHaveLength(128)
    expect(search(full, "assemble context").some((candidate) => candidate.scores.semantic > 0)).toBe(true)

    await Bun.write(
      path.join(repo.path, "src", "context.ts"),
      "export function assembleContext(input: string) { return input.trim() }\nexport function untouched() { return 1 }\n",
    )
    const partial = await indexRepository({ root: repo.path, repositoryId: "fixture", previous: full })

    expect(partial.status.semantic).toBe(50)
    expect(partial.embeddings?.[untouched.id]).toEqual(full.embeddings?.[untouched.id])

    const resumed = await indexSemantic(partial, { batchSize: 1 })
    expect(resumed.status.semantic).toBe(100)
    await saveEmbeddingRecords(repo.path, "fixture", resumed)
    expect(await loadEmbeddingRecords(repo.path, "fixture")).toHaveLength(resumed.units.length)

    const repeated = await indexRepository({ root: repo.path, repositoryId: "fixture", previous: resumed })
    expect(repeated.files.map((file) => file.path)).not.toContain(".homecode/homesitter/semantic.json")
    expect(deserializeIndex(serializeIndex(resumed))).toEqual(resumed)
  })

  test("exposes shared relationship operations", async () => {
    const repo = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "src", "value.ts"), "export const value = 1\n")
        await Bun.write(
          path.join(dir, "src", "consumer.ts"),
          'import { value } from "./value"\nexport const result = value\n',
        )
        await Bun.write(
          path.join(dir, "src", "value.test.ts"),
          'import { value } from "./value"\ntest("value", () => value)\n',
        )
      },
    })
    resources.push(repo)

    const index = await indexRepository({ root: repo.path, repositoryId: "fixture" })

    expect(relatedFiles(index, "src/value.ts")).toEqual(["src/consumer.ts", "src/value.test.ts"])
    expect(testsFor(index, "src/value.ts").map((unit) => unit.path)).toEqual(["src/value.test.ts"])
  })
})
