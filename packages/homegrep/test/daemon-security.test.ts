import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredListenAddress, resolveServerToken } from "../src/daemon/config.js";

it("rejects non-loopback daemon binds", () => {
  expect(() => configuredListenAddress("0.0.0.0:7999")).toThrow();
  expect(configuredListenAddress("127.0.0.1:7999")).toEqual({ host: "127.0.0.1", port: 7999 });
});

it("loads a valid bearer token from a private token file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homegrep-token-"));
  const tokenFile = join(directory, "token");
  try {
    await writeFile(tokenFile, "a".repeat(48));
    expect(await resolveServerToken({ tokenFile })).toMatchObject({ token: "a".repeat(48) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
