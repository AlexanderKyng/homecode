const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`

export function hashLine(line: string): string {
  const input = normalize(line)
  let h = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
    h >>>= 0
  }
  return h.toString(36).slice(0, 6)
}

export function normalize(line: string): string {
  return line.replace(/\r/g, "").replace(/\s+$/g, "")
}

export function formatHashedLines(
  text: string,
  offset = 1,
): { output: string; totalLines: number; truncated: boolean; nextOffset?: number } {
  const lines = text.split(/\r?\n/)
  const hashed: string[] = []
  let bytes = 0
  let truncated = false

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + offset
    const line = lines[i]
    const displayLine = line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line
    const cleanLine = displayLine.endsWith(MAX_LINE_SUFFIX)
      ? displayLine.slice(0, -MAX_LINE_SUFFIX.length)
      : displayLine
    const hash = hashLine(cleanLine)
    const formatted = `${lineNumber}|${hash}| ${displayLine}`
    const size = Buffer.byteLength(formatted, "utf-8") + (hashed.length > 0 ? 1 : 0)

    if (bytes + size > MAX_BYTES && hashed.length > 0) {
      truncated = true
      break
    }

    hashed.push(formatted)
    bytes += size
  }

  const last = hashed.length > 0 ? offset + hashed.length - 1 : offset - 1
  const nextOffset = last + 1

  let output = `<content>\n${hashed.join("\n")}`
  if (truncated) {
    output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${last}. Use offset=${nextOffset} to continue.)`
  } else {
    output += `\n\n(End of file - total ${lines.length} lines)`
  }
  output += "\n</content>"

  return {
    output,
    totalLines: lines.length,
    truncated,
    nextOffset: truncated ? nextOffset : undefined,
  }
}
