import { Effect, Context, Layer } from "effect"
import { Database } from "bun:sqlite"
import path from "path"
import { Global } from "@homecode-ai/core/global"

export interface CachedDocument {
  readonly url: string
  readonly title: string
  readonly content: string
  readonly contentType: string
  readonly status: number
  readonly createdAt: number
  readonly expiresAt: number
}

export interface CachedDocumentInput {
  readonly url: string
  readonly title: string
  readonly content: string
  readonly contentType?: string
  readonly status?: number
}

export interface Interface {
  readonly getQuery: (key: string) => Effect.Effect<unknown | null>
  readonly setQuery: (key: string, data: unknown, ttlSeconds?: number) => Effect.Effect<void>
  readonly getDocument: (url: string) => Effect.Effect<CachedDocument | null>
  readonly setDocument: (doc: CachedDocumentInput, ttlSeconds?: number) => Effect.Effect<void>
  readonly clearExpired: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@homecode/retrieval/Cache") {}

export function make(dbPath?: string): Interface {
  const targetPath = dbPath ?? path.join(Global.Path.cache, "retrieval.db")
  const db = new Database(targetPath, { create: true })

  // Initialize SQLite schema with WAL mode for performance
  db.run("PRAGMA journal_mode = WAL;")
  db.run("PRAGMA synchronous = NORMAL;")

  db.run(`
    CREATE TABLE IF NOT EXISTS search_queries (
      cache_key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS fetched_documents (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_type TEXT NOT NULL,
      status INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `)

  const getQueryStmt = db.prepare("SELECT data_json, expires_at FROM search_queries WHERE cache_key = ?")
  const setQueryStmt = db.prepare(
    "INSERT OR REPLACE INTO search_queries (cache_key, data_json, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )

  const getDocStmt = db.prepare(
    "SELECT url, title, content, content_type, status, created_at, expires_at FROM fetched_documents WHERE url = ?",
  )
  const setDocStmt = db.prepare(
    "INSERT OR REPLACE INTO fetched_documents (url, title, content, content_type, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )

  const cleanQueryStmt = db.prepare("DELETE FROM search_queries WHERE expires_at < ?")
  const cleanDocStmt = db.prepare("DELETE FROM fetched_documents WHERE expires_at < ?")

  const DEFAULT_QUERY_TTL = 3600 // 1 hour
  const DEFAULT_DOC_TTL = 86400 // 24 hours

  return {
    getQuery: (key: string) =>
      Effect.sync(() => {
        const row = getQueryStmt.get(key) as { data_json: string; expires_at: number } | null
        if (!row) return null
        const now = Math.floor(Date.now() / 1000)
        if (row.expires_at < now) {
          db.run("DELETE FROM search_queries WHERE cache_key = ?", [key])
          return null
        }
        return JSON.parse(row.data_json)
      }),

    setQuery: (key: string, data: unknown, ttlSeconds = DEFAULT_QUERY_TTL) =>
      Effect.sync(() => {
        const now = Math.floor(Date.now() / 1000)
        const expiresAt = now + ttlSeconds
        setQueryStmt.run(key, JSON.stringify(data), now, expiresAt)
      }),

    getDocument: (url: string) =>
      Effect.sync(() => {
        const row = getDocStmt.get(url) as {
          url: string
          title: string
          content: string
          content_type: string
          status: number
          created_at: number
          expires_at: number
        } | null

        if (!row) return null
        const now = Math.floor(Date.now() / 1000)
        if (row.expires_at < now) {
          db.run("DELETE FROM fetched_documents WHERE url = ?", [url])
          return null
        }
        return {
          url: row.url,
          title: row.title,
          content: row.content,
          contentType: row.content_type,
          status: row.status,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        }
      }),

    setDocument: (doc: CachedDocumentInput, ttlSeconds = DEFAULT_DOC_TTL) =>
      Effect.sync(() => {
        const now = Math.floor(Date.now() / 1000)
        const expiresAt = now + ttlSeconds
        setDocStmt.run(
          doc.url,
          doc.title,
          doc.content,
          doc.contentType ?? "text/markdown",
          doc.status ?? 200,
          now,
          expiresAt,
        )
      }),

    clearExpired: () =>
      Effect.sync(() => {
        const now = Math.floor(Date.now() / 1000)
        cleanQueryStmt.run(now)
        cleanDocStmt.run(now)
      }),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export * as RetrievalCache from "./cache"
