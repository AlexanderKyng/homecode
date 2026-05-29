const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

export function hashLine(line: string): string {
  const input = normalize(line)
  let h = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
    h >>>= 0
  }
  return h.toString(36).slice(0, 4)
}

export function normalize(line: string): string {
  return line.replace(/\r/g, "").replace(/\s+$/g, "")
}
