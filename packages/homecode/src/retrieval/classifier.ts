export type QueryCategory = "url" | "workspace_symbol" | "error_debug" | "technical_docs" | "general"

export interface QueryClassification {
  readonly query: string
  readonly category: QueryCategory
  readonly categories: readonly string[]
  readonly engines: readonly string[]
  readonly formattedQuery: string
  readonly isUrl: boolean
  readonly isWorkspaceSymbol: boolean
}

const ERROR_PATTERNS = [
  /TypeError:/i,
  /ReferenceError:/i,
  /SyntaxError:/i,
  /RangeError:/i,
  /UnhandledPromiseRejection/i,
  /failed to compile/i,
  /cannot find module/i,
  /undefined is not a function/i,
  /cannot read propert/i,
  /NullPointerException/i,
  /panic:/i,
  /Traceback \(most recent call last\):/i,
  /error\[E\d+\]/i, // Rust compiler error
]

const WORKSPACE_PATTERNS = [
  /^[@.]\//,
  /^(src|packages|lib|test|tests|bin|app|cmd|pkg)\//,
  /^(fn|func|class|interface|type|struct|impl):/i,
  /\.(ts|tsx|js|jsx|rs|go|py|c|cpp|h|java|kt|rb|json|toml|yaml|yml)$/,
]

const TECHNICAL_KEYWORDS = new Set([
  "effect",
  "effect-ts",
  "drizzle",
  "drizzle-orm",
  "bun",
  "node",
  "nodejs",
  "react",
  "solid",
  "solidjs",
  "vue",
  "svelte",
  "nextjs",
  "nuxt",
  "typescript",
  "javascript",
  "rust",
  "golang",
  "python",
  "docker",
  "kubernetes",
  "sqlite",
  "postgres",
  "postgresql",
  "mysql",
  "redis",
  "git",
  "github",
  "api",
  "sdk",
  "cli",
  "ast",
  "tree-sitter",
  "onnx",
  "playwright",
  "crdt",
  "wasm",
  "webassembly",
  "graphql",
  "grpc",
  "rest",
  "json",
  "yaml",
])

export function classifyQuery(rawQuery: string): QueryClassification {
  const query = rawQuery.trim()

  // 1. URL Check
  if (/^https?:\/\/[^\s]+$/i.test(query)) {
    return {
      query,
      category: "url",
      categories: [],
      engines: [],
      formattedQuery: query,
      isUrl: true,
      isWorkspaceSymbol: false,
    }
  }

  // 2. Workspace Symbol / File Path Check
  for (const pattern of WORKSPACE_PATTERNS) {
    if (pattern.test(query)) {
      return {
        query,
        category: "workspace_symbol",
        categories: ["it"],
        engines: ["github", "stackoverflow"],
        formattedQuery: cleanQuery(query),
        isUrl: false,
        isWorkspaceSymbol: true,
      }
    }
  }

  // 3. Error / Stack Trace Check
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(query)) {
      return {
        query,
        category: "error_debug",
        categories: ["it", "q&a"],
        engines: ["stackoverflow", "github", "superuser", "askubuntu"],
        formattedQuery: cleanQuery(query),
        isUrl: false,
        isWorkspaceSymbol: false,
      }
    }
  }

  // 4. Technical / Code Docs Check
  const words = query.toLowerCase().split(/[\s,./\\:;!?()]+/)
  const hasTechnicalKeyword = words.some((w) => TECHNICAL_KEYWORDS.has(w))

  if (hasTechnicalKeyword || /github\.com\//i.test(query) || /\b(repo|npm|crate|pypi|docs|api|interface)\b/i.test(query)) {
    return {
      query,
      category: "technical_docs",
      categories: ["it", "general"],
      engines: ["github", "mdn", "stackoverflow", "pypi", "wikipedia"],
      formattedQuery: cleanQuery(query),
      isUrl: false,
      isWorkspaceSymbol: false,
    }
  }

  // 5. General Web Search
  return {
    query,
    category: "general",
    categories: ["general", "it"],
    engines: ["wikipedia", "wikidata", "duckduckgo", "google"],
    formattedQuery: cleanQuery(query),
    isUrl: false,
    isWorkspaceSymbol: false,
  }
}

function cleanQuery(query: string): string {
  // Remove existing SearXNG engine bang prefixes to avoid duplicate bangs
  return query.replace(/![a-zA-Z0-9_-]+\s*/g, "").replace(/\s+/g, " ").trim()
}

export * as Classifier from "./classifier"
