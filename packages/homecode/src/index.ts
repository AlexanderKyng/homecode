import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import path from "path"
import { EOL } from "os"
import { ensureProcessMetadata } from "@homecode-ai/core/util/homecode-process"

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

const commands = await Promise.all([
  import("./cli/cmd/acp").then((m) => m.AcpCommand),
  import("./cli/cmd/mcp").then((m) => m.McpCommand),
  import("./cli/cmd/tui/thread").then((m) => m.TuiThreadCommand),
  import("./cli/cmd/tui/attach").then((m) => m.AttachCommand),
  import("./cli/cmd/run").then((m) => m.RunCommand),
  import("./cli/cmd/generate").then((m) => m.GenerateCommand),
  import("./cli/cmd/debug").then((m) => m.DebugCommand),
  import("./cli/cmd/account").then((m) => m.ConsoleCommand),
  import("./cli/cmd/providers").then((m) => m.ProvidersCommand),
  import("./cli/cmd/agent").then((m) => m.AgentCommand),
  import("./cli/cmd/upgrade").then((m) => m.UpgradeCommand),
  import("./cli/cmd/uninstall").then((m) => m.UninstallCommand),
  import("./cli/cmd/serve").then((m) => m.ServeCommand),
  import("./cli/cmd/web").then((m) => m.WebCommand),
  import("./cli/cmd/models").then((m) => m.ModelsCommand),
  import("./cli/cmd/stats").then((m) => m.StatsCommand),
  import("./cli/cmd/export").then((m) => m.ExportCommand),
  import("./cli/cmd/import").then((m) => m.ImportCommand),
  import("./cli/cmd/github").then((m) => m.GithubCommand),
  import("./cli/cmd/pr").then((m) => m.PrCommand),
  import("./cli/cmd/session").then((m) => m.SessionCommand),
  import("./cli/cmd/plug").then((m) => m.PluginCommand),
  import("./cli/cmd/db").then((m) => m.DbCommand),
])

const [
  AcpCommand,
  McpCommand,
  TuiThreadCommand,
  AttachCommand,
  RunCommand,
  GenerateCommand,
  DebugCommand,
  ConsoleCommand,
  ProvidersCommand,
  AgentCommand,
  UpgradeCommand,
  UninstallCommand,
  ServeCommand,
  WebCommand,
  ModelsCommand,
  StatsCommand,
  ExportCommand,
  ImportCommand,
  GithubCommand,
  PrCommand,
  SessionCommand,
  PluginCommand,
  DbCommand,
] = commands

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
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
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
