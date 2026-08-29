import { type CorpusSource } from "./types"
import path from "path"
import fs from "fs/promises"

export const INITIAL_AUTHORITATIVE_SOURCES: readonly CorpusSource[] = [
  {
    id: "effect_core",
    name: "Effect-TS Core & Smol Documentation",
    type: "git_repository",
    canonicalUrl: "https://effect.website",
    project: "effect",
    version: "3.12 / 4.0-beta",
    authority: "official",
    updateStrategy: "git_commit",
    includePatterns: ["docs/**/*.md", "migration/*.md", "README.md"],
    enabled: true,
    discoveredBy: "benchmark",
    priority: 10,
    documentCount: 85,
    totalSizeBytes: 420_000,
  },
  {
    id: "bun_runtime",
    name: "Bun Runtime & APIs Documentation",
    type: "documentation_site",
    canonicalUrl: "https://bun.sh/docs",
    project: "bun",
    version: "1.3",
    authority: "official",
    updateStrategy: "etag",
    includePatterns: ["docs/**/*.md", "api/*.md"],
    enabled: true,
    discoveredBy: "benchmark",
    priority: 10,
    documentCount: 120,
    totalSizeBytes: 580_000,
  },
  {
    id: "drizzle_orm",
    name: "Drizzle ORM & Kit Reference",
    type: "documentation_site",
    canonicalUrl: "https://orm.drizzle.team",
    project: "drizzle",
    version: "0.39",
    authority: "official",
    updateStrategy: "etag",
    includePatterns: ["docs/**/*.md"],
    enabled: true,
    discoveredBy: "benchmark",
    priority: 9,
    documentCount: 65,
    totalSizeBytes: 310_000,
  },
  {
    id: "typescript_handbook",
    name: "TypeScript 5.8 Reference & Compiler API",
    type: "documentation_site",
    canonicalUrl: "https://www.typescriptlang.org",
    project: "typescript",
    version: "5.8",
    authority: "official",
    updateStrategy: "etag",
    includePatterns: ["docs/**/*.md", "handbook/*.md"],
    enabled: true,
    discoveredBy: "benchmark",
    priority: 9,
    documentCount: 90,
    totalSizeBytes: 490_000,
  },
  {
    id: "sqlite_core",
    name: "SQLite Architecture, PRAGMA & WAL Specs",
    type: "documentation_site",
    canonicalUrl: "https://sqlite.org",
    project: "sqlite",
    version: "3.46",
    authority: "official",
    updateStrategy: "content_hash",
    includePatterns: ["wal.html", "pragma.html", "fts5.html"],
    enabled: true,
    discoveredBy: "benchmark",
    priority: 8,
    documentCount: 40,
    totalSizeBytes: 220_000,
  },
  {
    id: "react_core",
    name: "React 19 Server Actions & Hooks Reference",
    type: "documentation_site",
    canonicalUrl: "https://react.dev",
    project: "react",
    version: "19.0",
    authority: "official",
    updateStrategy: "etag",
    includePatterns: ["reference/**/*.md"],
    enabled: true,
    discoveredBy: "benchmark",
    priority: 8,
    documentCount: 75,
    totalSizeBytes: 380_000,
  },
  {
    id: "nodejs_lts",
    name: "Node.js 22 LTS API Reference",
    type: "documentation_site",
    canonicalUrl: "https://nodejs.org",
    project: "nodejs",
    version: "22.x",
    authority: "official",
    updateStrategy: "etag",
    includePatterns: ["api/*.md"],
    enabled: true,
    discoveredBy: "benchmark",
    priority: 7,
    documentCount: 80,
    totalSizeBytes: 440_000,
  },
  {
    id: "vite_core",
    name: "Vite 6 Guide & Plugin Architecture",
    type: "documentation_site",
    canonicalUrl: "https://vite.dev",
    project: "vite",
    version: "6.x",
    authority: "official",
    updateStrategy: "etag",
    includePatterns: ["guide/*.md"],
    enabled: true,
    discoveredBy: "benchmark",
    priority: 7,
    documentCount: 45,
    totalSizeBytes: 210_000,
  },
  {
    id: "linux_kernel_iouring",
    name: "Linux io_uring & Syscall Reference",
    type: "documentation_site",
    canonicalUrl: "https://kernel.org",
    project: "linux",
    version: "6.x",
    authority: "official",
    updateStrategy: "content_hash",
    enabled: true,
    discoveredBy: "benchmark",
    priority: 6,
    documentCount: 25,
    totalSizeBytes: 140_000,
  },
  {
    id: "localfirst_theory",
    name: "Local-First Software & CRDT Architecture",
    type: "markdown_tree",
    canonicalUrl: "https://github.com",
    project: "localfirst",
    authority: "trusted",
    updateStrategy: "git_commit",
    enabled: true,
    discoveredBy: "benchmark",
    priority: 6,
    documentCount: 30,
    totalSizeBytes: 160_000,
  },
]

export class SourceRegistry {
  private readonly sources = new Map<string, CorpusSource>()
  private readonly manifestPath: string

  constructor(manifestPath?: string) {
    const defaultDir = path.join(process.env.HOME || "/tmp", ".homecode", "data", "corpus")
    this.manifestPath = manifestPath || path.join(defaultDir, "manifest.json")

    // Seed initial sources
    for (const src of INITIAL_AUTHORITATIVE_SOURCES) {
      this.sources.set(src.id, src)
    }
  }

  public registerSource(source: CorpusSource) {
    this.sources.set(source.id, source)
  }

  public getSource(id: string): CorpusSource | undefined {
    return this.sources.get(id)
  }

  public listSources(): CorpusSource[] {
    return Array.from(this.sources.values())
  }

  public listEnabledSources(): CorpusSource[] {
    return this.listSources().filter((s) => s.enabled)
  }

  public enableSource(id: string) {
    const src = this.sources.get(id)
    if (src) {
      this.sources.set(id, { ...src, enabled: true })
    }
  }

  public disableSource(id: string) {
    const src = this.sources.get(id)
    if (src) {
      this.sources.set(id, { ...src, enabled: false })
    }
  }

  public async loadManifest(): Promise<void> {
    try {
      if (typeof Bun !== "undefined") {
        const file = Bun.file(this.manifestPath)
        if (await file.exists()) {
          const data = (await file.json()) as CorpusSource[]
          for (const s of data) {
            this.sources.set(s.id, s)
          }
        }
      }
    } catch {}
  }

  public async saveManifest(): Promise<void> {
    try {
      const dir = path.dirname(this.manifestPath)
      await fs.mkdir(dir, { recursive: true })
      const list = this.listSources()
      await fs.writeFile(this.manifestPath, JSON.stringify(list, null, 2), "utf8")
    } catch {}
  }
}

export * as SourceRegistryModule from "./registry"
