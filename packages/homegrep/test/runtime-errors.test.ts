import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SembleRuntime } from "../src/engine/semble/runtime.js";

it("surfaces a structured error returned by the Python bridge", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "homegrep-runtime-error-"));
  const runtime = new SembleRuntime({
    pythonProject: resolve(import.meta.dir, "../python"),
    stateRoot,
  });
  try {
    await expect(runtime.status(join(stateRoot, "missing-workspace"))).rejects.toThrow();
  } finally {
    await runtime.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
