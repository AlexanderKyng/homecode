import type { Argv } from "yargs"

interface CommandModule {
  command?: string | readonly string[]
  describe?: string | false
  builder?: (yargs: Argv) => Argv
  handler?: (argv: any) => any | Promise<any>
}

const moduleCache = new Map<string, unknown>()
const modules = {
  acp: () => import("./cmd/acp"),
  mcp: () => import("./cmd/mcp"),
  "tui/thread": () => import("./cmd/tui/thread"),
  "tui/attach": () => import("./cmd/tui/attach"),
  run: () => import("./cmd/run"),
  generate: () => import("./cmd/generate"),
  "debug/index": () => import("./cmd/debug/index"),
  account: () => import("./cmd/account"),
  providers: () => import("./cmd/providers"),
  agent: () => import("./cmd/agent"),
  upgrade: () => import("./cmd/upgrade"),
  uninstall: () => import("./cmd/uninstall"),
  serve: () => import("./cmd/serve"),
  web: () => import("./cmd/web"),
  models: () => import("./cmd/models"),
  stats: () => import("./cmd/stats"),
  export: () => import("./cmd/export"),
  import: () => import("./cmd/import"),
  github: () => import("./cmd/github"),
  pr: () => import("./cmd/pr"),
  session: () => import("./cmd/session"),
  plug: () => import("./cmd/plug"),
  db: () => import("./cmd/db"),
}

function load(modulePath: string) {
  const key = modulePath.slice(modulePath.lastIndexOf("/cli/cmd/") + "/cli/cmd/".length)
  return modules[key as keyof typeof modules]?.() ?? import(`${modulePath}.ts`)
}

/**
 * Creates a lazy yargs command that dynamically imports the module only when needed.
 * The builder and handler are wrapped in async functions to allow dynamic import.
 * Module imports are cached to avoid repeated imports.
 * @param modulePath Absolute module path relative to src/cli/cmd.
 */
export function lazyCommand(
  command: string | readonly string[],
  describe: string,
  modulePath: string,
  exportName: string,
): {
  command: string | readonly string[]
  describe: string
  builder: (yargs: Argv) => Promise<Argv>
  handler: (argv: any) => Promise<void>
} {
  return {
    command,
    describe,
    builder: async (yargs: Argv) => {
      if (!moduleCache.has(modulePath)) {
        moduleCache.set(modulePath, await load(modulePath))
      }
      const mod = moduleCache.get(modulePath) as Record<string, unknown>
      const cmd = mod[exportName] as CommandModule | undefined
      if (!cmd || typeof cmd.builder !== "function") return yargs
      return cmd.builder(yargs)
    },
    handler: async (argv: any) => {
      if (!moduleCache.has(modulePath)) {
        moduleCache.set(modulePath, await load(modulePath))
      }
      const mod = moduleCache.get(modulePath) as Record<string, unknown>
      const cmd = mod[exportName] as CommandModule | undefined
      if (!cmd || typeof cmd.handler !== "function") return
      return cmd.handler(argv)
    },
  }
}
