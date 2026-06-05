// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { AppFileSystem } from "@homecode-ai/core/filesystem"
import * as Bom from "@/util/bom"
import { hashLine, normalize } from "./hash"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = AppFileSystem.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

export type HashEditOp = "replace" | "insert_after" | "delete" | "replace_block"

export const HashEditSchema = Schema.Struct({
  op: Schema.Union([
    Schema.Literal("replace"),
    Schema.Literal("insert_after"),
    Schema.Literal("delete"),
    Schema.Literal("replace_block"),
  ]).pipe(Schema.annotate({ description: "Operation type: replace, insert_after, delete, replace_block" })),
  line: Schema.optional(Schema.Int).annotate({
    description: "Target line number (1-indexed) for replace, insert_after, delete",
  }),
  hash: Schema.optional(Schema.String).annotate({ description: "Hash anchor for validation" }),
  content: Schema.optional(Schema.String).annotate({ description: "New content for replace and insert_after" }),
  startLine: Schema.optional(Schema.Int).annotate({ description: "Start line for replace_block" }),
  startHash: Schema.optional(Schema.String).annotate({ description: "Start hash for replace_block" }),
  endLine: Schema.optional(Schema.Int).annotate({ description: "End line for replace_block" }),
  endHash: Schema.optional(Schema.String).annotate({ description: "End hash for replace_block" }),
})

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  oldString: Schema.optional(Schema.String).annotate({ description: "Legacy: The text to replace" }),
  newString: Schema.optional(Schema.String).annotate({
    description: "Legacy: The text to replace it with (must be different from oldString)",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Legacy: Replace all occurrences of oldString (default false)",
  }),
  edits: Schema.optional(Schema.Array(HashEditSchema)).annotate({
    description:
      "Hash-anchored edits (replace, insert_after, delete, replace_block). Multiple non-contiguous edits supported in one call. Invalid hashes are skipped with a report; valid ones are applied.",
  }),
})

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          const isHashline = params.edits !== undefined && params.edits.length > 0

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          let editReport = ""
          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              if (isHashline) {
                const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!info) throw new Error(`File ${filePath} not found`)
                if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
                const source = yield* Bom.readFile(afs, filePath)
                contentOld = source.text
                const result = yield* applyHashlineEdits(afs, filePath, params.edits!)
                const next = Bom.split(result.content)
                const desiredBom = source.bom || next.bom
                contentNew = next.text
                editReport = result.report ?? ""
                diff = trimDiff(
                  createTwoFilesPatch(
                    filePath,
                    filePath,
                    normalizeLineEndings(contentOld),
                    normalizeLineEndings(contentNew),
                  ),
                )
                yield* ctx.ask({
                  permission: "edit",
                  patterns: [path.relative(instance.worktree, filePath)],
                  always: ["*"],
                  metadata: {
                    filepath: filePath,
                    diff,
                  },
                })

                yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                if (yield* format.file(filePath)) {
                  contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                }
                yield* bus.publish(File.Event.Edited, { file: filePath })
                yield* bus.publish(FileWatcher.Event.Updated, {
                  file: filePath,
                  event: "change",
                })
                diff = trimDiff(
                  createTwoFilesPatch(
                    filePath,
                    filePath,
                    normalizeLineEndings(contentOld),
                    normalizeLineEndings(contentNew),
                  ),
                )
              } else {
                const old = params.oldString ?? ""
                const newVal = params.newString ?? ""
                if (old === newVal && old !== "") {
                  throw new Error("No changes to apply: oldString and newString are identical.")
                }

                if (old === "") {
                  const existed = yield* afs.existsSafe(filePath)
                  const source = existed ? yield* Bom.readFile(afs, filePath) : { bom: false, text: "" }
                  const next = Bom.split(newVal)
                  const desiredBom = source.bom || next.bom
                  contentOld = source.text
                  contentNew = next.text
                  diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
                  yield* ctx.ask({
                    permission: "edit",
                    patterns: [path.relative(instance.worktree, filePath)],
                    always: ["*"],
                    metadata: {
                      filepath: filePath,
                      diff,
                    },
                  })
                  yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                  if (yield* format.file(filePath)) {
                    contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                  }
                  yield* bus.publish(File.Event.Edited, { file: filePath })
                  yield* bus.publish(FileWatcher.Event.Updated, {
                    file: filePath,
                    event: existed ? "change" : "add",
                  })
                  return
                }

                const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!info) throw new Error(`File ${filePath} not found`)
                if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
                const source = yield* Bom.readFile(afs, filePath)
                contentOld = source.text

                const ending = detectLineEnding(contentOld)
                const oldNormalized = convertToLineEnding(normalizeLineEndings(old), ending)
                const replacement = convertToLineEnding(normalizeLineEndings(newVal), ending)

                const next = Bom.split(replace(contentOld, oldNormalized, replacement, params.replaceAll))
                const desiredBom = source.bom || next.bom
                contentNew = next.text

                diff = trimDiff(
                  createTwoFilesPatch(
                    filePath,
                    filePath,
                    normalizeLineEndings(contentOld),
                    normalizeLineEndings(contentNew),
                  ),
                )
                yield* ctx.ask({
                  permission: "edit",
                  patterns: [path.relative(instance.worktree, filePath)],
                  always: ["*"],
                  metadata: {
                    filepath: filePath,
                    diff,
                  },
                })

                yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                if (yield* format.file(filePath)) {
                  contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                }
                yield* bus.publish(File.Event.Edited, { file: filePath })
                yield* bus.publish(FileWatcher.Event.Updated, {
                  file: filePath,
                  event: "change",
                })
                diff = trimDiff(
                  createTwoFilesPatch(
                    filePath,
                    filePath,
                    normalizeLineEndings(contentOld),
                    normalizeLineEndings(contentNew),
                  ),
                )
              }
            }).pipe(Effect.orDie),
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = editReport || "Edit applied successfully."
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = AppFileSystem.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j })
        break // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)

  // Handle single line matches
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  // Try direct match with unescaped find string
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  // Also try finding escaped versions in content that match unescaped find
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  // This replacer yields all exact matches, allowing the replace function
  // to handle multiple occurrences based on replaceAll parameter
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) {
    // Need at least 3 lines to have meaningful context
    return
  }

  // Remove trailing empty line if present
  if (findLines[findLines.length - 1] === "") {
    findLines.pop()
  }

  const contentLines = content.split("\n")

  // Extract first and last lines as context anchors
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  // Find blocks that start and end with the context anchors
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    // Look for the matching last line
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found a potential context block
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")

        // Check if the middle content has reasonable similarity
        // (simple heuristic: at least 50% of non-empty lines should match when trimmed)
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break // Only match the first occurrence
          }
        }
        break
      }
    }
  }
}

/**
 * Hashline edit engine with partial failure support.
 * Validates each operation independently. Applies valid ops, reports invalid ones.
 */
export interface HashlineEditResult {
  content: string
  report?: string
}

export function applyHashlineEdits(
  afs: AppFileSystem.Interface,
  filePath: string,
  edits: readonly Schema.Schema.Type<typeof HashEditSchema>[],
): Effect.Effect<HashlineEditResult, Error, never> {
  return Effect.gen(function* () {
    const source = yield* Bom.readFile(afs, filePath)
    const lines = source.text.split(/\r?\n/)
    const ending = detectLineEnding(source.text)

    type Operation = {
      index: number
      type: "replace" | "insert" | "delete" | "block"
      endindex?: number
      content?: string
    }

    const operations: Operation[] = []
    const errors: string[] = []

    for (const edit of edits) {
      if (edit.op === "replace") {
        if (edit.line === undefined || edit.hash === undefined) {
          throw new Error("replace operation requires line and hash")
        }
        const idx = edit.line - 1
        if (idx < 0 || idx >= lines.length) {
          throw new Error(`Line ${edit.line} out of range (file has ${lines.length} lines)`)
        }
        const expected = normalize(lines[idx])
        const actualHash = hashLine(expected)
        if (actualHash !== edit.hash) {
          const displayLine = lines[idx].length > 120 ? lines[idx].slice(0, 120) + "..." : lines[idx]
          errors.push(
            `Line ${edit.line}: hash mismatch (expected ${edit.hash}, got ${actualHash}). Current: ${JSON.stringify(displayLine)}`,
          )
          continue
        }
        operations.push({ index: idx, type: "replace", content: edit.content })
      } else if (edit.op === "insert_after") {
        if (edit.line === undefined || edit.hash === undefined) {
          throw new Error("insert_after operation requires line and hash")
        }
        const idx = edit.line - 1
        if (idx < 0 || idx >= lines.length) {
          throw new Error(`Line ${edit.line} out of range (file has ${lines.length} lines)`)
        }
        const expected = normalize(lines[idx])
        const actualHash = hashLine(expected)
        if (actualHash !== edit.hash) {
          const displayLine = lines[idx].length > 120 ? lines[idx].slice(0, 120) + "..." : lines[idx]
          errors.push(
            `Line ${edit.line}: hash mismatch (expected ${edit.hash}, got ${actualHash}). Current: ${JSON.stringify(displayLine)}`,
          )
          continue
        }
        operations.push({ index: idx, type: "insert", content: edit.content })
      } else if (edit.op === "delete") {
        if (edit.line === undefined || edit.hash === undefined) {
          throw new Error("delete operation requires line and hash")
        }
        const idx = edit.line - 1
        if (idx < 0 || idx >= lines.length) {
          throw new Error(`Line ${edit.line} out of range (file has ${lines.length} lines)`)
        }
        const expected = normalize(lines[idx])
        const actualHash = hashLine(expected)
        if (actualHash !== edit.hash) {
          const displayLine = lines[idx].length > 120 ? lines[idx].slice(0, 120) + "..." : lines[idx]
          errors.push(
            `Line ${edit.line}: hash mismatch (expected ${edit.hash}, got ${actualHash}). Current: ${JSON.stringify(displayLine)}`,
          )
          continue
        }
        operations.push({ index: idx, type: "delete" })
      } else if (edit.op === "replace_block") {
        if (
          edit.startLine === undefined ||
          edit.startHash === undefined ||
          edit.endLine === undefined ||
          edit.endHash === undefined
        ) {
          throw new Error("replace_block operation requires startLine, startHash, endLine, and endHash")
        }
        const startIdx = edit.startLine - 1
        const endIdx = edit.endLine - 1
        if (startIdx < 0 || startIdx >= lines.length) {
          throw new Error(`Start line ${edit.startLine} out of range (file has ${lines.length} lines)`)
        }
        if (endIdx < 0 || endIdx >= lines.length) {
          throw new Error(`End line ${edit.endLine} out of range (file has ${lines.length} lines)`)
        }
        if (startIdx > endIdx) {
          throw new Error(`Start line ${edit.startLine} must not be greater than end line ${edit.endLine}`)
        }
        const startExpected = normalize(lines[startIdx])
        const startActualHash = hashLine(startExpected)
        const endExpected = normalize(lines[endIdx])
        const endActualHash = hashLine(endExpected)
        if (startActualHash !== edit.startHash || endActualHash !== edit.endHash) {
          const parts: string[] = []
          if (startActualHash !== edit.startHash) {
            const displayLine = lines[startIdx].length > 80 ? lines[startIdx].slice(0, 80) + "..." : lines[startIdx]
            parts.push(
              `start L${edit.startLine}: expected ${edit.startHash}, got ${startActualHash}. Current: ${JSON.stringify(displayLine)}`,
            )
          }
          if (endActualHash !== edit.endHash) {
            const displayLine = lines[endIdx].length > 80 ? lines[endIdx].slice(0, 80) + "..." : lines[endIdx]
            parts.push(
              `end L${edit.endLine}: expected ${edit.endHash}, got ${endActualHash}. Current: ${JSON.stringify(displayLine)}`,
            )
          }
          errors.push(`Lines ${edit.startLine}-${edit.endLine}: ${parts.join("; ")}`)
          continue
        }
        operations.push({ index: startIdx, type: "block", endindex: endIdx, content: edit.content ?? "" })
      }
    }

    const working = [...lines]

    const sortPriority = { insert: 4, replace: 3, block: 2, delete: 1 } as const
    operations.sort((a, b) => {
      if (b.index !== a.index) return b.index - a.index
      return sortPriority[b.type] - sortPriority[a.type]
    })

    for (const op of operations) {
      if (op.type === "delete") {
        working.splice(op.index, 1)
        continue
      }

      if (op.content === undefined) continue

      const newLines = op.content.split(/\r?\n/)

      if (op.type === "replace") {
        working.splice(op.index, 1, ...newLines)
      } else if (op.type === "insert") {
        working.splice(op.index + 1, 0, ...newLines)
      } else if (op.type === "block" && op.endindex !== undefined) {
        working.splice(op.index, op.endindex - op.index + 1, ...newLines)
      }
    }

    // Build report
    let report: string | undefined
    if (errors.length > 0) {
      const applied = operations.length
      report = [
        `Edit partially applied: ${applied} of ${edits.length} operations succeeded.`,
        `Failed operations:`,
        ...errors.map((e) => `  - ${e}`),
      ].join("\n")
    }

    return { content: working.join(ending), report }
  })
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        return content.replaceAll(search, newString)
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    )
  }
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
}
