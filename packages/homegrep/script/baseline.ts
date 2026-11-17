import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { createSembleGrep } from "../src/index.js";

const root = resolve(process.argv[2] ?? process.cwd());
const repetitions = Number(process.env.HOMEGREP_BASELINE_REPETITIONS ?? 30);
if (!Number.isInteger(repetitions) || repetitions < 1) {
  throw new Error("HOMEGREP_BASELINE_REPETITIONS must be a positive integer");
}

const service = await createSembleGrep({ root });
try {
  const info = await service.info({ root });
  if (!info.indexed) throw new Error("Index the workspace before running this baseline");
  const pointer = JSON.parse(await readFile(join(info.indexPath, "current.json"), "utf8")) as {
    generation: string;
  };

  const queries = [
    "permission validation and authorization checks",
    "MCP server token authentication loopback security",
    "Python Semble indexing and atomic generation publication",
  ];
  const timings: Record<string, number[]> = Object.fromEntries(queries.map((query) => [query, []]));
  for (const query of queries) {
    for (let warmup = 0; warmup < 3; warmup += 1) {
      await service.context({ root, query, limit: 10 });
    }
    for (let iteration = 0; iteration < repetitions; iteration += 1) {
      const started = performance.now();
      await service.context({ root, query, limit: 10 });
      timings[query]!.push(performance.now() - started);
    }
  }

  const resourceBefore = process.resourceUsage();
  const indexDirectoryBytes = await directoryBytes(info.indexPath);
  const activeGenerationBytes = await directoryBytes(
    join(info.indexPath, "generations", pointer.generation),
  );
  const resourceAfter = process.resourceUsage();
  console.log(
    JSON.stringify(
      {
        workspace: root,
        workspaceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        workspaceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0,
        measuredAt: new Date().toISOString(),
        hostname: hostname(),
        platform: process.platform,
        architecture: process.arch,
        javascriptRuntime: process.versions.bun
          ? `Bun ${process.versions.bun}`
          : `Node ${process.version}`,
        nodeCompatibilityVersion: process.version,
        packageVersion: "0.2.1-homecode.1",
        sembleRevision: "8ee6463efbb1ff755c339e965c7298b7afd7db5b",
        model: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        index: {
          files: info.status?.filesIndexed,
          entities: info.status?.entitiesIndexed,
          activeGenerationBytes,
          indexDirectoryBytes,
        },
        warmupsPerQuery: 3,
        repetitionsPerQuery: repetitions,
        latencyMs: Object.fromEntries(
          Object.entries(timings).map(([query, samples]) => [
            query,
            { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) },
          ]),
        ),
        processResourceDelta: {
          userCpuMs: resourceAfter.userCPUTime - resourceBefore.userCPUTime,
          systemCpuMs: resourceAfter.systemCPUTime - resourceBefore.systemCPUTime,
          maxRssKiB: resourceAfter.maxRSS,
          note: "Node process resource usage only; use /usr/bin/time -v around indexing to include child process resource usage.",
        },
        relevance: "not measured: no versioned qrels are present",
      },
      null,
      2,
    ),
  );
} finally {
  await service.close();
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const child = resolve(path, entry.name);
        if (entry.isDirectory()) return directoryBytes(child);
        if (entry.isFile()) return (await stat(child)).size;
        return 0;
      }),
    )
  ).reduce((total, size) => total + size, 0);
}

function percentile(samples: number[], quantile: number) {
  const sorted = [...samples].sort((left, right) => left - right);
  return Number(sorted[Math.ceil(quantile * sorted.length) - 1]!.toFixed(3));
}
