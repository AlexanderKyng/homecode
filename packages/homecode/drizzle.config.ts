import { defineConfig } from "drizzle-kit"
import os from "node:os"
import path from "node:path"

const data = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "homecode")
const database = process.env.OPENCODE_DB
const url = database === ":memory:"
  ? database
  : database
    ? path.isAbsolute(database)
      ? database
      : path.join(data, database)
    : path.join(data, "homecode.db")

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url,
  },
})
