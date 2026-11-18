import { describe, expect, it } from "bun:test"
import { make as makeReranker } from "@/retrieval/reranker"
import { extractHighlights } from "@/retrieval/highlighter"
import { classifyQuery } from "@/retrieval/classifier"
import { Effect } from "effect"

interface BenchmarkQuery {
  readonly id: string
  readonly category: "C1" | "C2" | "C3" | "C4" | "C5"
  readonly query: string
  readonly targetKeywords: readonly string[]
  readonly candidates: ReadonlyArray<{
    readonly id: string
    readonly text: string
    readonly isTarget: boolean
  }>
}

const BENCHMARK_DATASET: readonly BenchmarkQuery[] = [
  {
    id: "q1_c1",
    category: "C1", // Obscure Technical Facts
    query: "Effect-TS Schema decodeUnknownEffect error signature",
    targetKeywords: ["Schema.decodeUnknownEffect", "ParseResult", "Effect"],
    candidates: [
      {
        id: "c1_distractor_1",
        text: "Setting up TypeScript with ESLint and Prettier in modern frontend projects.",
        isTarget: false,
      },
      {
        id: "c1_target",
        text: "Effect-TS Schema: Schema.decodeUnknownEffect(schema) returns an Effect that fails with ParseResult.ParseError on validation failure.",
        isTarget: true,
      },
      {
        id: "c1_distractor_2",
        text: "Handling errors in standard JavaScript promises using catch handler.",
        isTarget: false,
      },
    ],
  },
  {
    id: "q2_c2",
    category: "C2", // GitHub / Project Discovery
    query: "Fast rust html readability parser with python bindings",
    targetKeywords: ["readability", "rust", "python"],
    candidates: [
      {
        id: "c2_distractor_1",
        text: "Top 10 Python web scraping libraries in 2026: BeautifulSoup and Scrapy tutorial.",
        isTarget: false,
      },
      {
        id: "c2_target",
        text: "github.com/rust-readability: High performance Mozilla Readability port written in Rust with PyO3 Python bindings.",
        isTarget: true,
      },
      {
        id: "c2_distractor_2",
        text: "Rust compiler internals and AST lowering pipeline.",
        isTarget: false,
      },
    ],
  },
  {
    id: "q3_c3",
    category: "C3", // Error Debugging
    query: "TypeError: turndownService.remove is not a function",
    targetKeywords: ["turndownService", "remove", "TypeError"],
    candidates: [
      {
        id: "c3_distractor_1",
        text: "How to fix TypeError in Python when calling undefined methods on dictionaries.",
        isTarget: false,
      },
      {
        id: "c3_target",
        text: "Fix TypeError: turndownService.remove is not a function - TurndownService instances require addRule or remove filters passing string tag names.",
        isTarget: true,
      },
      {
        id: "c3_distractor_2",
        text: "General JavaScript debugging using Chrome DevTools breakpoints.",
        isTarget: false,
      },
    ],
  },
  {
    id: "q4_c4",
    category: "C4", // Architecture / Research
    query: "Comparison of state synchronization algorithms in local-first software",
    targetKeywords: ["local-first", "CRDT", "synchronization"],
    candidates: [
      {
        id: "c4_distractor_1",
        text: "Cloud database replication topologies and master-slave failover configuration.",
        isTarget: false,
      },
      {
        id: "c4_target",
        text: "State Synchronization in Local-First Architecture: In-depth comparison of CRDTs (Yjs, Automerge) vs Operational Transformation and Replicache.",
        isTarget: true,
      },
      {
        id: "c4_distractor_2",
        text: "Setting up local SQLite database with Prisma ORM.",
        isTarget: false,
      },
    ],
  },
  {
    id: "q5_c5",
    category: "C5", // Exact API Syntax
    query: "Drizzle sqliteTable snake_case column definition options",
    targetKeywords: ["sqliteTable", "snake_case", "Drizzle"],
    candidates: [
      {
        id: "c5_distractor_1",
        text: "PostgreSQL schema migrations with Flyway and Liquibase.",
        isTarget: false,
      },
      {
        id: "c5_target",
        text: "Drizzle ORM SQLite: Use sqliteTable('table_name', { user_id: text().primaryKey() }) with snake_case column definitions to avoid string overrides.",
        isTarget: true,
      },
      {
        id: "c5_distractor_2",
        text: "Python SQLAlchemy declarative base table modeling tutorial.",
        isTarget: false,
      },
    ],
  },
]

describe("Retrieval Engine Benchmark & Quantitative Evaluation", () => {
  const reranker = makeReranker()

  it("achieves 100% MRR and Top-1 Recall across all 5 benchmark categories", async () => {
    let reciprocalRankSum = 0
    let top1Hits = 0
    const totalQueries = BENCHMARK_DATASET.length

    for (const item of BENCHMARK_DATASET) {
      const start = performance.now()
      const ranked = await Effect.runPromise(
        reranker.rerank({
          query: item.query,
          documents: item.candidates,
        }),
      )
      const duration = performance.now() - start

      expect(duration).toBeLessThan(15) // Sub-15ms CPU latency per query

      const targetRank = ranked.findIndex((r) => {
        const candidate = item.candidates.find((c) => c.id === r.id)
        return candidate?.isTarget
      })

      expect(targetRank).toBe(0) // Must be top ranked result

      if (targetRank === 0) {
        top1Hits++
      }
      reciprocalRankSum += 1 / (targetRank + 1)
    }

    const mrr = reciprocalRankSum / totalQueries
    const recallAt1 = top1Hits / totalQueries

    expect(mrr).toBe(1.0)
    expect(recallAt1).toBe(1.0)
  })

  it("evaluates query classifier accuracy on diverse developer intents", () => {
    expect(classifyQuery("https://effect.website/docs").category).toBe("url")
    expect(classifyQuery("@/retrieval/reranker.ts").category).toBe("workspace_symbol")
    expect(classifyQuery("TypeError: Cannot read properties of undefined").category).toBe("error_debug")
    expect(classifyQuery("Drizzle ORM sqliteTable columns").category).toBe("technical_docs")
    expect(classifyQuery("History of computer science").category).toBe("general")
  })

  it("evaluates passage highlighting context density and token efficiency", () => {
    const document = `
# Drizzle ORM Guide

Drizzle is a lightweight and fast TypeScript ORM.

## SQLite Setup

\`\`\`typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users", {
  id: text().primaryKey(),
  created_at: integer().notNull(),
})
\`\`\`

## Postgres Setup

Postgres configuration requires pg pool connection string and SSL certificates.
`

    const highlights = extractHighlights("Drizzle sqliteTable snake_case column", document, {
      maxHighlights: 2,
      maxCharacters: 1000,
    })

    expect(highlights.length).toBeGreaterThan(0)
    const combined = highlights.join("\n")
    // High signal-to-noise: highlights must contain the code block, not the unrelated Postgres section
    expect(combined).toContain("sqliteTable")
    expect(combined).toContain("created_at")
    expect(combined).not.toContain("Postgres configuration requires pg pool")
  })
})
