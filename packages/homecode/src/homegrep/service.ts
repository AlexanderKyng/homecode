import { createSembleGrep, type HomeGrep } from "@homecode-ai/homegrep"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { registerDisposer } from "@/effect/instance-registry"

const services = new Map<string, Promise<HomeGrep>>()
const indexing = new Map<string, Promise<void>>()

registerDisposer(async (directory) => {
  const service = services.get(directory)
  services.delete(directory)
  indexing.delete(directory)
  if (service) await (await service).close()
})

export function get(root: string) {
  return Effect.tryPromise({
    try: () => {
      const existing = services.get(root)
      if (existing) return existing
      const service = createSembleGrep({ root, pythonProject: pythonProject() }).catch((error) => {
        services.delete(root)
        throw error
      })
      services.set(root, service)
      return service
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

export function ensureIndexed(root: string, service: HomeGrep) {
  const existing = indexing.get(root)
  if (existing) return existing
  const pending = service.index({ root }).then(() => undefined).finally(() => {
    if (indexing.get(root) === pending) indexing.delete(root)
  })
  indexing.set(root, pending)
  return pending
}

export function pythonProject() {
  const configured = process.env.HOMECODE_HOMEGREP_PYTHON_PROJECT
  if (configured && existsSync(path.join(configured, "pyproject.toml"))) return configured
  const bundled = path.join(path.dirname(process.execPath), "homegrep", "python")
  if (existsSync(path.join(bundled, "pyproject.toml"))) return bundled
  const adjacent = path.join(path.dirname(fileURLToPath(import.meta.url)), "homegrep", "python")
  if (existsSync(path.join(adjacent, "pyproject.toml"))) return adjacent
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../homegrep/python")
}
