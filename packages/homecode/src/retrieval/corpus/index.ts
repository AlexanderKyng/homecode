import { Database } from "bun:sqlite"
import {
  type AuthorityLevel,
  type CorpusDocument,
  type CorpusSearchResult,
  type CorpusSection,
  type IngestionResult,
  type SearchCorpusOptions,
} from "./types"
import path from "path"
import fs from "fs/promises"

export interface IngestDocumentPayload {
  readonly url: string
  readonly sourceId: string
  readonly project: string
  readonly version?: string
  readonly title: string
  readonly documentPath?: string
  readonly content: string
  readonly headings?: string
  readonly codeBlocks?: string
  readonly authority?: AuthorityLevel
  readonly etag?: string
  readonly lastModified?: string
}

export class LocalCorpusIndex {
  private readonly db: Database
  private readonly dbPath: string

  constructor(customPath?: string) {
    const defaultDir = path.join(process.env.HOME || "/tmp", ".homecode", "data", "corpus")
    this.dbPath = customPath || path.join(defaultDir, "knowledge.db")

    if (customPath !== ":memory:") {
      try {
        const dir = path.dirname(this.dbPath)
        if (typeof Bun !== "undefined") {
          fs.mkdir(dir, { recursive: true }).catch(() => {})
        }
      } catch {}
    }

    this.db = new Database(this.dbPath, { create: true })
    this.initSchema()
  }

  private initSchema() {
    this.db.run(`PRAGMA journal_mode = WAL;`)
    this.db.run(`PRAGMA synchronous = NORMAL;`)
    this.db.run(`PRAGMA foreign_keys = ON;`)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS corpus_documents (
        url TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        project TEXT NOT NULL,
        version TEXT,
        title TEXT NOT NULL,
        document_path TEXT,
        headings TEXT,
        content TEXT NOT NULL,
        code_blocks TEXT,
        content_hash TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        authority TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER,
        successful_retrieval_count INTEGER NOT NULL DEFAULT 0
      );
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS corpus_sections (
        id TEXT PRIMARY KEY,
        document_url TEXT NOT NULL,
        source_id TEXT NOT NULL,
        project TEXT NOT NULL,
        version TEXT,
        heading_hierarchy TEXT,
        section_title TEXT,
        section_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        code_blocks TEXT,
        token_estimate INTEGER NOT NULL
      );
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_corpus_sections_doc ON corpus_sections(document_url);
    `)

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(
        url UNINDEXED,
        title,
        project,
        version,
        headings,
        content,
        code_blocks,
        document_path,
        tokenize = 'porter unicode61'
      );
    `)
  }

  public async ingestDocument(doc: IngestDocumentPayload): Promise<boolean> {
    const contentHash = await this.hashContent(doc.content)
    const existing = this.db
      .query<{ content_hash: string }, [string]>(
        `SELECT content_hash FROM corpus_documents WHERE url = ?`,
      )
      .get(doc.url)

    if (existing && existing.content_hash === contentHash) {
      return false // Unchanged, skip redundant re-indexing
    }

    const now = Date.now()
    const headings = doc.headings || this.extractHeadings(doc.content)
    const codeBlocks = doc.codeBlocks || this.extractCodeBlocks(doc.content)
    const authority = doc.authority || "official"
    const sections = this.segmentIntoSections(doc.url, doc.sourceId, doc.project, doc.version, doc.content)

    this.db.transaction(() => {
      // 1. Insert or replace document record
      this.db
        .query(
          `INSERT OR REPLACE INTO corpus_documents
          (url, source_id, project, version, title, document_path, headings, content, code_blocks, content_hash, etag, last_modified, authority, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          doc.url,
          doc.sourceId,
          doc.project,
          doc.version || null,
          doc.title,
          doc.documentPath || null,
          headings,
          doc.content,
          codeBlocks,
          contentHash,
          doc.etag || null,
          doc.lastModified || null,
          authority,
          now,
        )

      // 2. Remove old sections and insert new structural sections
      this.db.query(`DELETE FROM corpus_sections WHERE document_url = ?`).run(doc.url)
      for (const s of sections) {
        this.db
          .query(
            `INSERT INTO corpus_sections
            (id, document_url, source_id, project, version, heading_hierarchy, section_title, section_index, content, code_blocks, token_estimate)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            s.id,
            s.documentUrl,
            s.sourceId,
            s.project,
            s.version || null,
            s.headingHierarchy,
            s.sectionTitle,
            s.sectionIndex,
            s.content,
            s.codeBlocks,
            s.tokenEstimate,
          )
      }

      // 3. Update FTS5 index
      this.db.query(`DELETE FROM corpus_fts WHERE url = ?`).run(doc.url)
      this.db
        .query(
          `INSERT INTO corpus_fts (url, title, project, version, headings, content, code_blocks, document_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          doc.url,
          doc.title,
          doc.project,
          doc.version || "",
          headings,
          doc.content,
          codeBlocks,
          doc.documentPath || "",
        )
    })()

    return true
  }

  public search(query: string, options: SearchCorpusOptions = {}): CorpusSearchResult[] {
    const limit = options.limit ?? 10
    const cleanQuery = query.replace(/[^\w\s.-]/g, " ").replace(/\s+/g, " ").trim()
    if (!cleanQuery) return []

    const terms = cleanQuery.split(" ").filter((t) => t.length > 1)
    if (terms.length === 0) return []

    // Build query with prefix matching on tokens
    const matchExpression = terms.map((t) => `"${t}"*`).join(" OR ")

    try {
      // Field weights in SQLite FTS5 bm25(): title=5.0, project=3.0, version=2.0, headings=4.0, content=1.0, code=3.5, path=2.5
      const rows = this.db
        .query<
          {
            url: string
            title: string
            project: string
            version: string | null
            headings: string
            code_blocks: string
            authority: string
            rank: number
          },
          [string, number]
        >(
          `SELECT d.url, d.title, d.project, d.version, d.headings, d.code_blocks, d.authority,
                  bm25(corpus_fts, 5.0, 3.0, 2.0, 4.0, 1.0, 3.5, 2.5) AS rank
           FROM corpus_fts f
           JOIN corpus_documents d ON d.url = f.url
           WHERE corpus_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(matchExpression, limit)

      return rows.map((row) => {
        const score = Math.abs(row.rank)
        let snippet = row.headings || ""
        if (row.code_blocks) {
          snippet = snippet ? `${snippet} | ${row.code_blocks.slice(0, 120)}` : row.code_blocks.slice(0, 120)
        }

        return {
          url: row.url,
          title: row.title,
          project: row.project,
          version: row.version || undefined,
          snippet,
          headings: row.headings,
          codeBlocks: row.code_blocks,
          bm25Rank: row.rank,
          score,
          authority: (row.authority as AuthorityLevel) || "official",
        }
      })
    } catch {
      return []
    }
  }

  public recordAccess(url: string, successful: boolean) {
    try {
      const now = Date.now()
      const successInc = successful ? 1 : 0
      this.db
        .query(
          `UPDATE corpus_documents
           SET access_count = access_count + 1,
               last_accessed_at = ?,
               successful_retrieval_count = successful_retrieval_count + ?
           WHERE url = ?`,
        )
        .run(now, successInc, url)
    } catch {}
  }

  public async accumulateDocument(
    url: string,
    title: string,
    content: string,
    options: {
      project?: string
      version?: string
      authority?: AuthorityLevel
      sourceId?: string
    } = {},
  ): Promise<boolean> {
    return this.ingestDocument({
      url,
      sourceId: options.sourceId || "learned_authoritative",
      project: options.project || this.inferProjectFromUrl(url),
      version: options.version,
      title,
      content,
      authority: options.authority || "trusted",
    })
  }

  public getMetrics(): {
    totalDocuments: number
    totalSections: number
    totalSizeBytes: number
  } {
    try {
      const docCount = this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM corpus_documents`).get()?.count || 0
      const sectionCount = this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM corpus_sections`).get()?.count || 0
      const sizeRow = this.db.query<{ size: number }, []>(`SELECT SUM(LENGTH(content) + LENGTH(code_blocks)) as size FROM corpus_documents`).get()

      return {
        totalDocuments: docCount,
        totalSections: sectionCount,
        totalSizeBytes: sizeRow?.size || 0,
      }
    } catch {
      return { totalDocuments: 0, totalSections: 0, totalSizeBytes: 0 }
    }
  }

  public getDocument(url: string): CorpusDocument | undefined {
    try {
      const row = this.db
        .query<any, [string]>(`SELECT * FROM corpus_documents WHERE url = ?`)
        .get(url)
      if (!row) return undefined
      return {
        url: row.url,
        sourceId: row.source_id,
        project: row.project,
        version: row.version,
        title: row.title,
        documentPath: row.document_path,
        headings: row.headings,
        content: row.content,
        codeBlocks: row.code_blocks,
        contentHash: row.content_hash,
        etag: row.etag,
        lastModified: row.last_modified,
        authority: row.authority,
        updatedAt: row.updated_at,
        accessCount: row.access_count,
        lastAccessedAt: row.last_accessed_at,
        successfulRetrievalCount: row.successful_retrieval_count,
      }
    } catch {
      return undefined
    }
  }

  private segmentIntoSections(
    documentUrl: string,
    sourceId: string,
    project: string,
    version: string | undefined,
    markdown: string,
  ): CorpusSection[] {
    const lines = markdown.split("\n")
    const sections: CorpusSection[] = []

    let currentHeading = "Overview"
    let currentLines: string[] = []
    let currentCode: string[] = []
    let sectionIdx = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const headingMatch = line.match(/^#{1,4}\s+(.+)$/)

      if (headingMatch && currentLines.length > 0) {
        const text = currentLines.join("\n").trim()
        const code = currentCode.join("\n").trim()
        if (text.length > 0) {
          sections.push({
            id: `${documentUrl}#section_${sectionIdx}`,
            documentUrl,
            sourceId,
            project,
            version,
            headingHierarchy: currentHeading,
            sectionTitle: currentHeading.split(" > ").pop() || currentHeading,
            sectionIndex: sectionIdx++,
            content: text,
            codeBlocks: code,
            tokenEstimate: Math.ceil(text.length / 4),
          })
        }
        currentHeading = headingMatch[1].trim()
        currentLines = [line]
        currentCode = []
      } else {
        currentLines.push(line)
        if (line.startsWith("```") || (currentCode.length > 0 && !line.startsWith("```"))) {
          currentCode.push(line)
        }
      }
    }

    if (currentLines.length > 0) {
      const text = currentLines.join("\n").trim()
      const code = currentCode.join("\n").trim()
      if (text.length > 0) {
        sections.push({
          id: `${documentUrl}#section_${sectionIdx}`,
          documentUrl,
          sourceId,
          project,
          version,
          headingHierarchy: currentHeading,
          sectionTitle: currentHeading.split(" > ").pop() || currentHeading,
          sectionIndex: sectionIdx++,
          content: text,
          codeBlocks: code,
          tokenEstimate: Math.ceil(text.length / 4),
        })
      }
    }

    return sections
  }

  private inferProjectFromUrl(url: string): string {
    const lower = url.toLowerCase()
    if (lower.includes("bun.sh")) return "bun"
    if (lower.includes("effect.website")) return "effect"
    if (lower.includes("drizzle.team")) return "drizzle"
    if (lower.includes("typescriptlang.org")) return "typescript"
    if (lower.includes("react.dev")) return "react"
    if (lower.includes("sqlite.org")) return "sqlite"
    if (lower.includes("nodejs.org")) return "nodejs"
    if (lower.includes("vite.dev")) return "vite"
    return "general"
  }

  private async hashContent(text: string): Promise<string> {
    const enc = new TextEncoder()
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(text))
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }

  private extractHeadings(markdown: string): string {
    const matches = markdown.match(/^#{1,6}\s+(.+)$/gm)
    return matches ? matches.map((m) => m.replace(/^#{1,6}\s+/, "")).join(" | ") : ""
  }

  private extractCodeBlocks(markdown: string): string {
    const matches = markdown.match(/```[a-zA-Z]*\n([\s\S]*?)```/g)
    return matches ? matches.join("\n").replace(/```[a-zA-Z]*/g, "").slice(0, 800) : ""
  }

  public close() {
    this.db.close()
  }
}

export * as LocalCorpusIndexModule from "./index"
export * from "./types"
export * from "./planner"
export * from "./registry"
export * from "./ingester"
export * from "./sync"
