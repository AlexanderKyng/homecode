import path from "node:path"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"

/**
 * Resolved HomeMem settings. The adapter and the memory tool must agree on the database path and
 * the engine command, so both read this instead of each carrying their own defaults.
 */
export type HomeMemConfig = {
  readonly enabled: boolean
  readonly record: boolean
  readonly automatic: boolean
  readonly command: string[]
  readonly database: string
  readonly tokenBudget: number
}

type RawHomeMem = {
  enabled?: boolean
  record?: boolean
  automatic?: boolean
  command?: string[]
  database?: string
  token_budget?: number
}

/** Default state database, shared across projects so rules accumulate for the user. */
export function defaultDatabase() {
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, "homemem", "homemem.sqlite3")
  if (process.env.HOME) return path.join(process.env.HOME, ".local", "state", "homemem", "homemem.sqlite3")
  return path.join(".homemem-state", "homemem.sqlite3")
}

/** Runtime socket, keyed by database so two profiles never share a daemon. */
export function defaultSocket(database: string) {
  const runtime = process.env.XDG_RUNTIME_DIR || tmpdir()
  return path.join(runtime, `homemem-${hashPath(database)}.sock`)
}

/**
 * Environment override for the engine executable. Useful when HomeMem is built from source or
 * installed outside `PATH`.
 */
export function engineOverride() {
  return process.env.HOMEMEM_BIN || process.env.HOME_MEM_PATH || undefined
}

function bundledEngine() {
  const executable = `homemem${process.platform === "win32" ? ".exe" : ""}`
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    resources ? path.join(resources, "homemem", executable) : undefined,
    path.join(path.dirname(process.execPath), executable),
  ].filter((candidate): candidate is string => Boolean(candidate))
  const bundled = candidates.find(existsSync)
  if (bundled) return [bundled]

  const manifest = path.resolve(import.meta.dirname, "../../native/homemem/Cargo.toml")
  return ["cargo", "run", "--quiet", "--locked", "--manifest-path", manifest, "--"]
}

export function resolve(raw: RawHomeMem | undefined): HomeMemConfig {
  const override = engineOverride()
  return {
    enabled: raw?.enabled === true,
    record: raw?.record === true,
    automatic: raw?.automatic === true,
    command: raw?.command?.length ? raw.command : override ? [override] : bundledEngine(),
    database: raw?.database ?? defaultDatabase(),
    tokenBudget: raw?.token_budget ?? 180,
  }
}

/** True when the host should talk to the engine at all. */
export function isActive(config: HomeMemConfig) {
  return config.enabled || config.record
}

/** True when the host should run the daemon rather than shelling out per call. */
export function usesDaemon(config: HomeMemConfig, platform = process.platform) {
  return platform !== "win32" && isActive(config)
}

function hashPath(value: string) {
  return createHash("sha256").update("\0").update(value).digest("hex").slice(0, 16)
}

export * as HomeMemConfig from "./config"
