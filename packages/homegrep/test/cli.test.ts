import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const entry = resolve(import.meta.dir, "../dist/cli/index.js");

it("runs the packaged CLI help and version entrypoints", () => {
  const help = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Usage:");

  const version = spawnSync(process.execPath, [entry, "--version"], { encoding: "utf8" });
  expect(version.status).toBe(0);
  expect(version.stdout.trim()).toBe("0.2.1-homecode.1");
});
