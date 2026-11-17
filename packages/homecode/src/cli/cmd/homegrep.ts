import path from "node:path"
import { createSembleGrep, type IndexProgress } from "@homecode-ai/homegrep"
import { pythonProject } from "@/homegrep/service"
import { cmd } from "./cmd"

const IndexCommand = cmd({
  command: "index [root]",
  describe: "build or update the HomeGrep workspace index",
  builder: (yargs) =>
    yargs
      .positional("root", {
        type: "string",
        description: "Workspace root to index",
        default: process.cwd(),
      })
      .option("rebuild", {
        type: "boolean",
        description: "Rebuild the existing HomeGrep index",
        default: false,
      }),
  async handler(args) {
    const root = path.resolve(args.root ?? process.cwd())
    const service = await createSembleGrep({ root, pythonProject: pythonProject() })
    const controller = new AbortController()
    const interrupt = () => controller.abort(new Error("Indexing cancelled"))
    process.once("SIGINT", interrupt)
    try {
      const result = await service.index({
        root,
        rebuild: args.rebuild,
        signal: controller.signal,
        onProgress: (progress: IndexProgress) => showProgress(progress),
      })
      process.stdout.write(
        `HomeGrep indexed ${result.filesScanned} files (${result.filesAdded} added, ${result.filesModified} modified, ${result.filesDeleted} deleted).\n`,
      )
    } finally {
      process.removeListener("SIGINT", interrupt)
      await service.close()
    }
  },
})

export const HomeGrepCommand = cmd({
  command: "homegrep",
  describe: "manage native HomeGrep workspace search",
  builder: (yargs) => yargs.command(IndexCommand).demandCommand(),
  async handler() {},
})

function showProgress(progress: IndexProgress) {
  const details = progress.detail ?? progress.phase
  const files = progress.filesTotal === undefined ? "" : ` (${progress.filesIndexed ?? 0}/${progress.filesTotal} files)`
  process.stderr.write(`HomeGrep ${progress.phase}: ${details}${files}\n`)
}
