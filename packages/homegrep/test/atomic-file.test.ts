import { expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFileAtomically } from "../src/engine/utils/atomic-file.js";

it("atomically replaces a file and leaves no temporary artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homegrep-atomic-"));
  const target = join(directory, "current.json");
  try {
    await replaceFileAtomically(target, "{\"generation\":1}\n", { mode: 0o600 });
    await replaceFileAtomically(target, "{\"generation\":2}\n", { mode: 0o600 });
    expect(await readFile(target, "utf8")).toBe("{\"generation\":2}\n");
    expect(await readdir(directory)).toEqual(["current.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
