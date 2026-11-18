import { appendFile, chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { Global } from "@homecode-ai/core/global"
import { Effect } from "effect"

const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i
const SECRET_TEXT = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+|((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi
const MAX_FIELD_CHARS = 16_384

export const redact = (value: unknown, key = "", depth = 0): unknown => {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]"
  if (depth > 12) return "[DEPTH_LIMIT]"
  if (typeof value === "string") {
    const text = value.replace(SECRET_TEXT, (_match, bearer: string | undefined, assignment: string | undefined) =>
      `${bearer ?? assignment ?? ""}[REDACTED]`,
    )
    return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)} [FIELD_TRUNCATED]` : text
  }
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => redact(item, "", depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 256).map(([name, item]) => [name, redact(item, name, depth + 1)]),
    )
  }
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function" || typeof value === "symbol") return String(value)
  return value
}

export function create(input: {
  sessionID: string
  messageID: string
  turnID: string
  decisionID: string
  model: { providerID: string; id: string; api: { npm: string } }
  rootDir?: string
}) {
  const executionID = crypto.randomUUID()
  const safeSessionID = input.sessionID.replace(/[^A-Za-z0-9._-]/g, "_")
  const directory = path.join(input.rootDir ?? Global.Path.data, "codemode-traces", safeSessionID)
  const file = path.join(directory, `${executionID}.jsonl`)
  let sequence = 0
  let queue = Promise.resolve()

  return {
    executionID,
    write(event: string, fields: Record<string, unknown> = {}) {
      const record = redact({
        version: 1,
        executionID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        turnID: input.turnID,
        decisionID: input.decisionID,
        parentID: input.decisionID,
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
        event,
        model: input.model,
        ...fields,
      })
      const next = queue.then(() => append(file, directory, `${JSON.stringify(record)}\n`))
      queue = next
      return Effect.promise(() => next)
    },
  }
}

async function append(file: string, directory: string, line: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await appendFile(file, line, { encoding: "utf8", mode: 0o600 })
  await chmod(file, 0o600)
}

export * as CodeModeTrace from "./code-mode-trace"
