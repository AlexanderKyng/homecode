import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const entry = resolve(import.meta.dir, "../dist/cli/index.js");

it("starts the daemon, enforces its token, serves MCP, and shuts down", async () => {
  const home = await mkdtemp(join(tmpdir(), "homegrep-daemon-"));
  const port = await freePort();
  const tokenFile = join(home, "token");
  await writeFile(tokenFile, "b".repeat(48));
  const daemon = spawn(
    "node",
    [entry, "--server", "run", "--listen", `127.0.0.1:${port}`, "--home", home, "--token-file", tokenFile],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  daemon.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  daemon.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));

  try {
    const healthUrl = `http://127.0.0.1:${port}/healthz`;
    await waitFor(async () => (await fetch(healthUrl)).ok, daemon, () => output);

    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const unauthenticated = await fetch(endpoint);
    expect(unauthenticated.status).toBe(401);

    const token = (await readFile(tokenFile, "utf8")).trim();
    const initialized = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "homegrep-test", version: "1" },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain("protocolVersion");
  } finally {
    daemon.kill("SIGTERM");
    await waitForExit(daemon);
    await rm(home, { recursive: true, force: true });
  }
});

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitFor(condition: () => Promise<boolean>, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch {
      // The service may not have bound its loopback socket yet.
    }
    if (child.exitCode !== null) throw new Error(`daemon exited early: ${output()}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`daemon did not become ready: ${output()}`);
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(resolveExit, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}
