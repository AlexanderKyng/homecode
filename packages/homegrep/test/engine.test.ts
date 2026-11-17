import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSembleGrep } from "../src/index.js";

const pythonProject = resolve(import.meta.dir, "../python");
let root: string;
let home: string;
let service: Awaited<ReturnType<typeof createSembleGrep>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "homegrep-workspace-"));
  home = await mkdtemp(join(tmpdir(), "homegrep-state-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "auth.ts"),
    "export function validateBearerToken(token: string) { return token.length >= 32 }\n",
  );
  await writeFile(
    join(root, "src", "database.ts"),
    "export function openDatabase(path: string) { return path }\n",
  );
  service = await createSembleGrep({ root, home, pythonProject });
});

afterAll(async () => {
  await service?.close();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("HomeGrep Semble integration", () => {
  it("creates the initial generation and supports hybrid search", async () => {
    const indexed = await service.index({ root });
    expect(indexed.filesAdded).toBe(2);
    expect(indexed.filesFailed).toBe(0);

    const info = await service.info({ root });
    expect(info.indexed).toBe(true);
    expect(await generation(info.indexPath)).toBeTruthy();

    const result = await service.context({ root, query: "validate bearer token" });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((item) => item.file.relativePath === "src/auth.ts")).toBe(true);

    const exact = await service.context({ root, query: "validateBearerToken", rg: true });
    expect(exact.source).toBe("rg");
    expect(exact.items.some((item) => item.file.relativePath === "src/auth.ts")).toBe(true);
    expect((await service.context({ root, query: "literal-that-is-not-present", rg: true })).items).toHaveLength(0);
  });

  it("reuses unchanged file content and publishes coherent generations", async () => {
    const before = await service.info({ root });
    const firstGeneration = await generation(before.indexPath);
    const unchanged = await service.index({ root });
    const afterUnchanged = await service.info({ root });
    expect(unchanged.filesUnchanged).toBe(2);
    const unchangedGeneration = await generation(afterUnchanged.indexPath);
    expect(unchangedGeneration).not.toBe(firstGeneration);

    await writeFile(
      join(root, "src", "auth.ts"),
      "export function validateBearerToken(token: string) { return token.startsWith('Bearer ') }\n",
    );
    await writeFile(join(root, "src", "cache.ts"), "export const cacheTtlSeconds = 60\n");
    await rm(join(root, "src", "database.ts"));

    const updated = await service.index({ root });
    const afterUpdate = await service.info({ root });
    expect(updated.filesAdded).toBe(1);
    expect(updated.filesModified).toBe(1);
    expect(updated.filesDeleted).toBe(1);
    const updatedGeneration = await generation(afterUpdate.indexPath);
    expect(updatedGeneration).not.toBe(unchangedGeneration);
    const manifest = JSON.parse(
      await readFile(
        join(afterUpdate.indexPath, "generations", updatedGeneration, "homegrep-manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.generation).toBe(updatedGeneration);
    expect(afterUpdate.status.filesIndexed).toBe(2);
  });

  it("fails closed when the current-generation pointer is corrupt", async () => {
    const info = await service.info({ root });
    await writeFile(join(info.indexPath, "current.json"), "{broken", "utf8");
    await expect(service.info({ root })).rejects.toThrow();
  });
});

async function generation(indexPath: string) {
  return JSON.parse(await readFile(join(indexPath, "current.json"), "utf8")).generation as string;
}
