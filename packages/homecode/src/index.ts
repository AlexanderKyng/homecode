import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import path from "path"
import { EOL } from "os"
import { ensureProcessMetadata } from "@homecode-ai/core/util/homecode-process"
import { lazyCommand } from "./cli/lazy-cmd"
import { fileURLToPath } from "node:url"

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const processMetadata = ensureProcessMetadata("main")

const args = hideBin(process.argv)

// Handle --version immediately without any heavy imports.
if (args.includes("-v") || args.includes("--version")) {
  const { InstallationVersion } = await import("@homecode-ai/core/installation/version")
  process.stdout.write(InstallationVersion + EOL)
  process.exit(0)
}

// Lazily load all dependencies only after version check passes.
const Log = await import("@homecode-ai/core/util/log")
const UI = (await import("./cli/ui")).UI
const Installation = (await import("./installation")).Installation
const NamedError = (await import("@homecode-ai/core/util/error")).NamedError
const FormatError = (await import("./cli/error")).FormatError
const Filesystem = (await import("@/util/filesystem")).Filesystem
const Global = (await import("@homecode-ai/core/global")).Global
const JsonMigration = (await import("@/storage/json-migration")).JsonMigration
const Database = (await import("@/storage/db")).Database
const errorMessage = (await import("./util/error")).errorMessage
const Heap = (await import("./cli/heap")).Heap
const isRecord = (await import("@/util/record")).isRecord
const drizzle = (await import("drizzle-orm/bun-sqlite")).drizzle
const InstallationVersion = (await import("@homecode-ai/core/installation/version")).InstallationVersion

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("homecode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("homecode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as "DEBUG" | "INFO" | "WARN" | "ERROR"
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    Log.Default.info("homecode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    const marker = path.join(Global.Path.data, "homecode.db")
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(
    lazyCommand(
      "acp",
      "start ACP (Agent Client Protocol) server",
      path.resolve(__dirname, "./cli/cmd/acp"),
      "AcpCommand",
    ),
  )
  .command(
    lazyCommand(
      "mcp",
      "manage MCP (Model Context Protocol) servers",
      path.resolve(__dirname, "./cli/cmd/mcp"),
      "McpCommand",
    ),
  )
  .command(
    lazyCommand(
      "$0 [project]",
      "start homecode tui",
      path.resolve(__dirname, "./cli/cmd/tui/thread"),
      "TuiThreadCommand",
    ),
  )
  .command(
    lazyCommand(
      "attach <url>",
      "attach to a running homecode server",
      path.resolve(__dirname, "./cli/cmd/tui/attach"),
      "AttachCommand",
    ),
  )
  .command(
    lazyCommand(
      "run [message..]",
      "run homecode with a message",
      path.resolve(__dirname, "./cli/cmd/run"),
      "RunCommand",
    ),
  )
  .command(
    lazyCommand("generate", "generate code with AI", path.resolve(__dirname, "./cli/cmd/generate"), "GenerateCommand"),
  )
  .command(
    lazyCommand(
      "debug",
      "debugging and troubleshooting tools",
      path.resolve(__dirname, "./cli/cmd/debug/index"),
      "DebugCommand",
    ),
  )
  .command(
    lazyCommand(
      "console",
      "manage console account and organization",
      path.resolve(__dirname, "./cli/cmd/account"),
      "ConsoleCommand",
    ),
  )
  .command(
    lazyCommand(
      "providers",
      "manage AI providers and credentials",
      path.resolve(__dirname, "./cli/cmd/providers"),
      "ProvidersCommand",
    ),
  )
  .command(lazyCommand("agent", "manage agents", path.resolve(__dirname, "./cli/cmd/agent"), "AgentCommand"))
  .command(
    lazyCommand(
      "upgrade [target]",
      "upgrade homecode to the latest or a specific version",
      path.resolve(__dirname, "./cli/cmd/upgrade"),
      "UpgradeCommand",
    ),
  )
  .command(
    lazyCommand(
      "uninstall",
      "uninstall homecode and remove all related files",
      path.resolve(__dirname, "./cli/cmd/uninstall"),
      "UninstallCommand",
    ),
  )
  .command(
    lazyCommand(
      "serve",
      "starts a headless homecode server",
      path.resolve(__dirname, "./cli/cmd/serve"),
      "ServeCommand",
    ),
  )
  .command(
    lazyCommand(
      "web",
      "start homecode server and open web interface",
      path.resolve(__dirname, "./cli/cmd/web"),
      "WebCommand",
    ),
  )
  .command(
    lazyCommand(
      "models [provider]",
      "list all available models",
      path.resolve(__dirname, "./cli/cmd/models"),
      "ModelsCommand",
    ),
  )
  .command(
    lazyCommand("stats", "show performance statistics", path.resolve(__dirname, "./cli/cmd/stats"), "StatsCommand"),
  )
  .command(lazyCommand("export", "export data", path.resolve(__dirname, "./cli/cmd/export"), "ExportCommand"))
  .command(lazyCommand("import", "import data", path.resolve(__dirname, "./cli/cmd/import"), "ImportCommand"))
  .command(
    lazyCommand("github", "manage GitHub integration", path.resolve(__dirname, "./cli/cmd/github"), "GithubCommand"),
  )
  .command(lazyCommand("pr", "create and manage pull requests", path.resolve(__dirname, "./cli/cmd/pr"), "PrCommand"))
  .command(lazyCommand("session", "manage sessions", path.resolve(__dirname, "./cli/cmd/session"), "SessionCommand"))
  .command(lazyCommand("plug", "manage plugins", path.resolve(__dirname, "./cli/cmd/plug"), "PluginCommand"))
  .command(lazyCommand("db", "database operations", path.resolve(__dirname, "./cli/cmd/db"), "DbCommand"))
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }

  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
