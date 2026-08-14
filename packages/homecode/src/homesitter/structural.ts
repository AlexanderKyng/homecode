import path from "path"
import type { ExtractedUnit, SourceLanguage, SourceRange, StructuralParseResult, UnitKind } from "./types"

const LANGUAGE_BY_EXTENSION: Record<string, SourceLanguage> = {
  ".bash": "bash",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cs": "csharp",
  ".go": "go",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".json": "json",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".md": "markdown",
  ".mjs": "javascript",
  ".ps1": "powershell",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".yaml": "yaml",
  ".yml": "yaml",
}

const SOURCE_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION))
const CONFIG_NAMES = new Set([".env", ".env.example", "Dockerfile", "Makefile"])

export function languageForPath(filepath: string): SourceLanguage {
  const basename = path.posix.basename(filepath)
  if (CONFIG_NAMES.has(basename)) return "unknown"
  return LANGUAGE_BY_EXTENSION[path.posix.extname(filepath).toLowerCase()] ?? "unknown"
}

export function isIndexablePath(filepath: string) {
  const basename = path.posix.basename(filepath)
  return CONFIG_NAMES.has(basename) || SOURCE_EXTENSIONS.has(path.posix.extname(filepath).toLowerCase())
}

export function fallbackStructuralParse(input: {
  path: string
  language: SourceLanguage
  source: string
}): StructuralParseResult {
  const lines = input.source.split("\n")
  const starts = lineStarts(lines)
  const imports = unique(importsFor(input.language, input.source))
  const exports = unique(exportsFor(input.language, input.source))
  const testPath = /(?:^|[./_-])(?:test|tests|spec|specs)(?:[./_-]|$)/i.test(input.path)
  const config = isConfig(input.path, input.language)

  if (config) {
    return {
      imports,
      exports,
      units: [
        unit({
          kind: "config",
          name: path.posix.basename(input.path),
          range: wholeRange(input.source, lines, starts),
          source: input.source,
          imports,
          exports,
          isTest: testPath,
          isConfig: true,
        }),
      ],
    }
  }

  const units: ExtractedUnit[] = []
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line] ?? ""
    const declaration = declarationAt(input.language, text)
    if (declaration) {
      const end = blockEnd(lines, line, input.language)
      const range = rangeForLines(lines, starts, line, end, declaration.column)
      units.push(
        unit({
          ...declaration,
          range,
          source: input.source.slice(range.start.offset, range.end.offset),
          imports,
          exports,
          isTest: testPath || declaration.kind === "test" || /\b(?:test|it|describe)\s*\(/.test(text),
          isConfig: false,
        }),
      )
      continue
    }

    const test = testAt(text)
    if (test) {
      const end = blockEnd(lines, line, input.language)
      const range = rangeForLines(lines, starts, line, end, test.column)
      units.push(
        unit({
          ...test,
          range,
          source: input.source.slice(range.start.offset, range.end.offset),
          imports,
          exports,
          isTest: true,
          isConfig: false,
        }),
      )
    }
  }

  if (units.length === 0) {
    units.push(
      unit({
        kind: "module",
        name: path.posix.basename(input.path),
        range: wholeRange(input.source, lines, starts),
        source: input.source,
        imports,
        exports,
        isTest: testPath,
        isConfig: false,
      }),
    )
  }

  return { units, imports, exports }
}

function declarationAt(language: SourceLanguage, text: string) {
  const patterns: Array<{ kind: UnitKind; pattern: RegExp }> =
    language === "python"
      ? [
          { kind: "class", pattern: /^\s*class\s+([A-Za-z_$][\w$]*)/ },
          { kind: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/ },
        ]
      : language === "rust"
        ? [
            { kind: "class", pattern: /^\s*(?:pub\s+)?struct\s+([A-Za-z_$][\w$]*)/ },
            { kind: "interface", pattern: /^\s*(?:pub\s+)?trait\s+([A-Za-z_$][\w$]*)/ },
            { kind: "enum", pattern: /^\s*(?:pub\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
            { kind: "function", pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)/ },
            { kind: "module", pattern: /^\s*(?:pub\s+)?mod\s+([A-Za-z_$][\w$]*)/ },
          ]
        : language === "go"
          ? [
              { kind: "function", pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/ },
              { kind: "type", pattern: /^\s*type\s+([A-Za-z_$][\w$]*)/ },
            ]
          : [
              { kind: "class", pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
              { kind: "interface", pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
              { kind: "type", pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
              { kind: "enum", pattern: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
              {
                kind: "function",
                pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
              },
              { kind: "function", pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(/ },
              { kind: "declaration", pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
            ]

  for (const candidate of patterns) {
    const match = candidate.pattern.exec(text)
    if (!match?.[1]) continue
    return {
      kind: candidate.kind,
      name: match[1],
      signature: text.trim().slice(0, 240),
      column: match.index,
    }
  }
}

function testAt(text: string) {
  const match = /\b(?:test|it|describe)\s*\(\s*["'`]([^"'`]+)["'`]/.exec(text)
  if (!match) return
  return {
    kind: "test" as const,
    name: match[1],
    signature: text.trim().slice(0, 240),
    column: match.index,
  }
}

function blockEnd(lines: string[], start: number, language: SourceLanguage) {
  const opening = language === "python" ? ":" : "{"
  let braces = 0
  let sawBlock = false
  for (let line = start; line < lines.length; line++) {
    const text = lines[line] ?? ""
    if (opening === "{") {
      const opens = (text.match(/{/g) ?? []).length
      const closes = (text.match(/}/g) ?? []).length
      braces += opens - closes
      sawBlock ||= opens > 0
      if (sawBlock && braces <= 0) return line
      if (!sawBlock && line > start && /^\s*[^\s#]/.test(text)) return line - 1
      continue
    }

    if (line === start) continue
    if (/^\S/.test(text) && text.trim()) return line - 1
  }
  return lines.length - 1
}

function importsFor(language: SourceLanguage, source: string) {
  const patterns =
    language === "python"
      ? [/^\s*from\s+([^\s]+)\s+import/gm, /^\s*import\s+([^\s#]+)/gm]
      : language === "rust"
        ? [/^\s*use\s+([^;]+);/gm]
        : language === "go"
          ? [/"([^"\n]+)"/g]
          : [
              /\b(?:import|export)\s+(?:type\s+)?[^;\n]*?\sfrom\s*["']([^"']+)["']/g,
              /\bimport\s*["']([^"']+)["']/g,
              /\brequire\(\s*["']([^"']+)["']\s*\)/g,
            ]
  return patterns.flatMap((pattern) =>
    Array.from(source.matchAll(pattern), (match) => match[1]).filter(Boolean),
  ) as string[]
}

function exportsFor(language: SourceLanguage, source: string) {
  if (language === "python") {
    return Array.from(source.matchAll(/^\s*(?:class|def)\s+([A-Za-z_$][\w$]*)/gm), (match) => match[1]).filter(
      Boolean,
    ) as string[]
  }
  if (language === "rust") {
    return Array.from(
      source.matchAll(/^\s*pub\s+(?:fn|struct|enum|trait|mod)\s+([A-Za-z_$][\w$]*)/gm),
      (match) => match[1],
    ).filter(Boolean) as string[]
  }
  return Array.from(
    source.matchAll(
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|function|interface|type|enum|const|let|var)?\s*([A-Za-z_$][\w$]*)?/gm,
    ),
    (match) => match[1],
  ).filter(Boolean) as string[]
}

function isConfig(filepath: string, language: SourceLanguage) {
  return (
    language === "json" || language === "yaml" || language === "toml" || CONFIG_NAMES.has(path.posix.basename(filepath))
  )
}

function lineStarts(lines: string[]) {
  const result: number[] = []
  let offset = 0
  for (const line of lines) {
    result.push(offset)
    offset += line.length + 1
  }
  return result
}

function wholeRange(source: string, lines: string[], starts: number[]): SourceRange {
  return rangeForLines(lines, starts, 0, Math.max(0, lines.length - 1), 0, source.length)
}

function rangeForLines(
  lines: string[],
  starts: number[],
  startLine: number,
  endLine: number,
  startColumn: number,
  endOffset?: number,
): SourceRange {
  const last = Math.max(startLine, endLine)
  const lastText = lines[last] ?? ""
  const finalOffset = endOffset ?? (starts[last] ?? 0) + lastText.length
  return {
    start: { line: startLine + 1, column: startColumn, offset: (starts[startLine] ?? 0) + startColumn },
    end: { line: last + 1, column: finalOffset - (starts[last] ?? 0), offset: finalOffset },
  }
}

function unit(input: ExtractedUnit): ExtractedUnit {
  return input
}

function unique(values: string[]) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

export * as HomeSitterStructural from "./structural"
