import { execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HomeGrepContextItem } from "../src/engine/service/types.js";
import { createSembleGrep } from "../src/index.js";

type Judgment = {
  path: string;
  startLine: number;
  endLine: number;
  grade: number;
};

type Task = {
  id: string;
  repository: string;
  split: string;
  category: string;
  query: string;
  answerable?: boolean;
  relevant: Judgment[];
};

type Dataset = {
  schemaVersion: number;
  annotationMethod: string;
  repositories: Record<string, { commit: string; path: string }>;
  tasks: Task[];
};

const dataset = (await Bun.file(
  new URL("../benchmarks/agentic-retrieval-v1/tasks.json", import.meta.url),
).json()) as Dataset;
const arguments_ = process.argv.slice(2);
const splitArgument = arguments_.find((argument) => argument.startsWith("--split="));
const split = splitArgument?.slice("--split=".length) ?? "all";
const repetitions = Number(process.env.HOMEGREP_EVAL_REPETITIONS ?? 30);
const warmups = Number(process.env.HOMEGREP_EVAL_WARMUPS ?? 3);
const variants = ["hybrid", "fts", "vector", "token-rerank"] as const;

if (!Number.isInteger(repetitions) || repetitions < 1) {
  throw new Error("HOMEGREP_EVAL_REPETITIONS must be a positive integer");
}
if (!Number.isInteger(warmups) || warmups < 0) {
  throw new Error("HOMEGREP_EVAL_WARMUPS must be a non-negative integer");
}
if (!process.env.HOMEGREP_HOME) {
  throw new Error("Set HOMEGREP_HOME to a new, isolated temporary state directory");
}

const tasks = dataset.tasks.filter((task) => split === "all" || task.split === split);
const repositoryIds = [...new Set(tasks.map((task) => task.repository))];
const rootOverrides = process.env.HOMEGREP_EVAL_REPOS
  ? (JSON.parse(process.env.HOMEGREP_EVAL_REPOS) as Record<string, string>)
  : {};
const resourcesBefore = process.resourceUsage();
const workspaces = Object.fromEntries(
  repositoryIds.map((id) => {
    const repository = dataset.repositories[id];
    if (!repository) throw new Error(`Missing repository metadata: ${id}`);
    const root = resolve(rootOverrides[id] ?? repository.path);
    return [
      id,
      {
        root,
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }).trim().length > 0,
      },
    ];
  }),
);
const indexes: Record<string, unknown> = {};
const services = new Map<string, Awaited<ReturnType<typeof createSembleGrep>>>();
const measurements: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(
  variants.map((variant) => [variant, []]),
);
const latencies: Record<string, number[]> = Object.fromEntries(
  variants.map((variant) => [variant, []]),
);

try {
  for (const repository of repositoryIds) {
    const root = workspaces[repository]!.root;
    const service = await createSembleGrep({ root });
    services.set(repository, service);
    const indexed = await service.index({ root, rebuild: true });
    const info = await service.info({ root });
    indexes[repository] = {
      root,
      commit: workspaces[repository]!.commit,
      dirty: workspaces[repository]!.dirty,
      filesScanned: indexed.filesScanned,
      filesAdded: indexed.filesAdded,
      filesModified: indexed.filesModified,
      filesDeleted: indexed.filesDeleted,
      filesUnchanged: indexed.filesUnchanged,
      entities: indexed.entitiesCreated,
      durationMs: Number(indexed.durationMs.toFixed(3)),
      indexPath: info.indexPath,
      indexBytes: await directoryBytes(info.indexPath),
    };
  }

  for (const task of tasks) {
    const service = services.get(task.repository);
    if (!service) throw new Error(`Missing service for ${task.repository}`);
    for (const variant of variants) {
      const request = {
        root: workspaces[task.repository]!.root,
        query: task.query,
        limit: variant === "token-rerank" ? 100 : 10,
        autoUpdate: false,
        ...(variant === "hybrid"
          ? {}
          : { routes: [{ mode: variant, query: task.query } as const] }),
      };
      for (let warmup = 0; warmup < warmups; warmup += 1) {
        await service.context(request);
      }

      const samples: number[] = [];
      let result: Awaited<ReturnType<typeof service.context>> | undefined;
      let candidatePool: HomeGrepContextItem[] = [];
      for (let iteration = 0; iteration < repetitions; iteration += 1) {
        const started = performance.now();
        result = await service.context(request);
        if (variant === "token-rerank") {
          candidatePool = result.items;
          result = { ...result, items: rerankByLocalSignals(task.query, result.items) };
        }
        samples.push(performance.now() - started);
      }
      if (!result) throw new Error(`No result captured for ${task.id}/${variant}`);

      const taskScore = scoreTask(result.items, task.relevant);
      const candidateScore =
        variant === "token-rerank"
          ? scoreTask(candidatePool, task.relevant, 100)
          : undefined;
      const record = {
        taskId: task.id,
        repository: task.repository,
        split: task.split,
        category: task.category,
        ...taskScore,
        candidateRecallAt100: candidateScore?.["lineRecall@100"],
        latencyMs: { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) },
        topResults: result.items.slice(0, 10).map((item) => ({
          path: item.file.relativePath,
          startLine: item.range.kind === "text" ? item.range.startLine : null,
          endLine: item.range.kind === "text" ? item.range.endLine : null,
          score: item.score,
        })),
      };
      measurements[variant]!.push(record);
      latencies[variant]!.push(...samples);
    }
  }

  const answerable = tasks.filter((task) => task.answerable !== false);
  const report = {
    schemaVersion: 1,
    dataset: "agentic-retrieval-v1",
    annotationMethod: dataset.annotationMethod,
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, architecture: process.arch },
    javascriptRuntime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version,
    nodeCompatibilityVersion: process.version,
    engine: "Semble hybrid, unchanged pinned engine",
    engineRevision: "8ee6463efbb1ff755c339e965c7298b7afd7db5b",
    embeddingModel: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
    stateDirectory: resolve(process.env.HOMEGREP_HOME),
    repositories: workspaces,
    indexes,
    split,
    taskCount: tasks.length,
    answerableTaskCount: answerable.length,
    warmupsPerTaskAndVariant: warmups,
    repetitionsPerTaskAndVariant: repetitions,
    metrics: Object.fromEntries(
      variants.map((variant) => [
        variant,
        {
          aggregate: aggregate(measurements[variant]!, answerable),
          byRepository: Object.fromEntries(
            repositoryIds.map((repository) => [
              repository,
              aggregate(
                measurements[variant]!.filter((row) => row.repository === repository),
                answerable.filter((task) => task.repository === repository),
              ),
            ]),
          ),
          latencyMs: {
            p50: percentile(latencies[variant]!, 0.5),
            p95: percentile(latencies[variant]!, 0.95),
          },
          unanswerableFalseHitAt10: falseHitRate(
            measurements[variant]!,
            tasks.filter((task) => task.answerable === false),
          ),
        },
      ]),
    ),
    pairedNdcgDelta95CI: {
      "fts-minus-hybrid": pairedBootstrap(measurements.fts!, measurements.hybrid!, answerable),
      "vector-minus-hybrid": pairedBootstrap(measurements.vector!, measurements.hybrid!, answerable),
      "token-rerank-minus-hybrid": pairedBootstrap(
        measurements["token-rerank"]!,
        measurements.hybrid!,
        answerable,
      ),
    },
    processResourceDelta: {
      userCpuMs: process.resourceUsage().userCPUTime - resourcesBefore.userCPUTime,
      systemCpuMs: process.resourceUsage().systemCPUTime - resourcesBefore.systemCPUTime,
      maxRssKiB: process.resourceUsage().maxRSS,
      note: "Node process only; wrap the command with /usr/bin/time -v to include the Python child process.",
    },
    agentTaskResolution: "not measured: no coding-agent execution harness is part of this retrieval-only pilot",
    taskResults: measurements,
  };
  const output = JSON.stringify(report, null, 2);
  if (process.env.HOMEGREP_EVAL_OUTPUT) {
    await Bun.write(process.env.HOMEGREP_EVAL_OUTPUT, `${output}\n`);
  }
  console.log(output);
} finally {
  await Promise.all([...services.values()].map((service) => service.close()));
}

function rerankByLocalSignals(query: string, items: HomeGrepContextItem[]) {
  const stopWords = new Set([
    "a", "an", "and", "are", "as", "before", "by", "does", "for", "from",
    "how", "in", "into", "is", "it", "of", "on", "or", "then", "the", "to",
    "what", "when", "where", "which", "who", "with",
  ]);
  const queryTerms = [...new Set(tokens(query).filter((token) => !stopWords.has(token)))];
  const queryIdentifiers = (query.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g) ?? [])
    .filter((identifier) => /[A-Z]|[_$.]/.test(identifier))
    .map((identifier) => identifier.toLowerCase());
  const documentTerms = items.map((item) =>
    new Set(tokens(`${item.file.relativePath} ${item.content}`)),
  );
  const symbolTerms = items.map((item) =>
    new Set(
      [...item.content.matchAll(/\b(?:class|function|interface|type|def|fn|struct|enum|trait|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
        .flatMap((match) => tokens(match[1] ?? "")),
    ),
  );
  const frequencies = new Map(
    queryTerms.map((term) => [term, documentTerms.filter((terms) => terms.has(term)).length]),
  );
  const weight = (term: string) => Math.log((items.length + 1) / ((frequencies.get(term) ?? 0) + 1)) + 1;
  const coverage = (terms: Set<string>) => {
    const total = queryTerms.reduce((sum, term) => sum + weight(term), 0);
    return total ? queryTerms.reduce((sum, term) => sum + (terms.has(term) ? weight(term) : 0), 0) / total : 0;
  };

  return items
    .map((item, index) => {
      const contentTerms = new Set(tokens(item.content));
      const pathTerms = new Set(tokens(item.file.relativePath));
      const symbolCoverage = coverage(symbolTerms[index]!);
      const exactIdentifierCoverage = queryIdentifiers.length
        ? queryIdentifiers.filter((identifier) =>
            `${item.file.relativePath}\n${item.content}`.toLowerCase().includes(identifier),
          ).length / queryIdentifiers.length
        : 0;
      return {
        item,
        score:
          0.18 * (1 - (item.rank - 1) / Math.max(1, items.length)) +
          0.27 * coverage(contentTerms) +
          0.2 * coverage(pathTerms) +
          0.25 * symbolCoverage +
          0.1 * exactIdentifierCoverage,
      };
    })
    .toSorted((left, right) => right.score - left.score || left.item.rank - right.item.rank)
    .slice(0, 10)
    .map(({ item }, index) => ({ ...item, rank: index + 1 }));
}

function tokens(text: string) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function scoreTask(items: HomeGrepContextItem[], relevant: Judgment[], limit = 10) {
  const locations = relevant.map((judgment) => `${judgment.path}:${judgment.startLine}-${judgment.endLine}`);
  const ideal = [...relevant].sort((left, right) => right.grade - left.grade);
  const gained = new Set<string>();
  const graded = items.slice(0, limit).map((item) => {
    const matches = relevant.filter(
      (judgment) =>
        item.file.relativePath === judgment.path &&
        item.range.kind === "text" &&
        item.range.startLine <= judgment.endLine &&
        item.range.endLine >= judgment.startLine,
    );
    const novel = matches.filter((judgment) => {
      const key = `${judgment.path}:${judgment.startLine}-${judgment.endLine}`;
      if (gained.has(key)) return false;
      gained.add(key);
      return true;
    });
    return {
      item,
      pathRelevant: matches.length > 0,
      lineRelevant: matches.length > 0,
      grade: Math.max(0, ...novel.map((judgment) => judgment.grade)),
    };
  });
  const uniquePaths = new Set(relevant.map((judgment) => judgment.path));
  const firstLineRank = graded.findIndex((entry) => entry.lineRelevant);
  const dcg = graded.slice(0, 10).reduce(
    (sum, entry, index) => sum + (2 ** entry.grade - 1) / Math.log2(index + 2),
    0,
  );
  const idcg = ideal
    .slice(0, 10)
    .reduce((sum, judgment, index) => sum + (2 ** judgment.grade - 1) / Math.log2(index + 2), 0);
  return {
    ...Object.fromEntries(
      (limit > 10 ? [limit] : [1, 5, 10]).flatMap((cutoff) => {
        const top = graded.slice(0, cutoff);
        const denominator = Math.max(1, top.length);
        const hitPaths = new Set(
          top.filter((entry) => entry.pathRelevant).map((entry) => entry.item.file.relativePath),
        );
        const retrievedPaths = new Set(top.map((entry) => entry.item.file.relativePath));
        const hitLocations = new Set(
          relevant
            .filter((judgment) =>
              top.some(
                (entry) =>
                  entry.item.file.relativePath === judgment.path &&
                  entry.item.range.kind === "text" &&
                  entry.item.range.startLine <= judgment.endLine &&
                  entry.item.range.endLine >= judgment.startLine,
              ),
            )
            .map((judgment) => `${judgment.path}:${judgment.startLine}-${judgment.endLine}`),
        );
        return [
          [`pathRecall@${cutoff}`, uniquePaths.size ? hitPaths.size / uniquePaths.size : 0],
          [`pathPrecision@${cutoff}`, retrievedPaths.size ? hitPaths.size / retrievedPaths.size : 0],
          [`lineRecall@${cutoff}`, locations.length ? hitLocations.size / locations.length : 0],
          [`linePrecision@${cutoff}`, top.filter((entry) => entry.lineRelevant).length / denominator],
        ];
      }),
    ),
    mrr: firstLineRank < 0 ? 0 : 1 / (firstLineRank + 1),
    "ndcg@10": idcg ? dcg / idcg : 0,
    retrievalCoverageAt5: graded.slice(0, 5).some((entry) => entry.lineRelevant) ? 1 : 0,
  };
}

function aggregate(rows: Array<Record<string, unknown>>, expectedTasks: Task[]) {
  const answerableIds = new Set(expectedTasks.map((task) => task.id));
  const selected = rows.filter((row) => answerableIds.has(String(row.taskId)));
  const metricNames = [
    "pathRecall@1", "pathRecall@5", "pathRecall@10",
    "pathPrecision@1", "pathPrecision@5", "pathPrecision@10",
    "lineRecall@1", "lineRecall@5", "lineRecall@10",
    "linePrecision@1", "linePrecision@5", "linePrecision@10",
    "mrr", "ndcg@10", "retrievalCoverageAt5",
  ];
  return {
    tasks: selected.length,
    ...Object.fromEntries(
      metricNames.map((name) => [
        name,
        mean(selected.map((row) => Number(row[name] ?? 0))),
      ]),
    ),
    candidateRecallAt100: mean(selected.map((row) => Number(row.candidateRecallAt100 ?? 0))),
    ndcg95CI: bootstrapMeanCI(selected.map((row) => Number(row["ndcg@10"] ?? 0))),
  };
}

function falseHitRate(rows: Array<Record<string, unknown>>, unanswerable: Task[]) {
  if (!unanswerable.length) return null;
  const ids = new Set(unanswerable.map((task) => task.id));
  const selected = rows.filter((row) => ids.has(String(row.taskId)));
  return selected.length
    ? selected.filter((row) => Array.isArray(row.topResults) && row.topResults.length > 0).length / selected.length
    : null;
}

function pairedBootstrap(left: Array<Record<string, unknown>>, right: Array<Record<string, unknown>>, tasks: Task[]) {
  const answerableIds = new Set(tasks.map((task) => task.id));
  const rightByTask = new Map(right.map((row) => [String(row.taskId), Number(row["ndcg@10"] ?? 0)]));
  const deltas = left.filter((row) => answerableIds.has(String(row.taskId))).flatMap((row) => {
    const baseline = rightByTask.get(String(row.taskId));
    return baseline === undefined ? [] : [Number(row["ndcg@10"] ?? 0) - baseline];
  });
  return bootstrapMeanCI(deltas);
}

function bootstrapMeanCI(values: number[]) {
  if (!values.length) return { mean: 0, low95: 0, high95: 0, samples: 0 };
  let seed = 1_428_771;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4_294_967_296;
  };
  const samples = Array.from({ length: 2000 }, () =>
    mean(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!)),
  ).sort((left, right) => left - right);
  return {
    mean: rounded(mean(values)),
    low95: rounded(samples[Math.floor(samples.length * 0.025)]!),
    high95: rounded(samples[Math.floor(samples.length * 0.975)]!),
    samples: values.length,
    bootstrapReplicates: samples.length,
  };
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return rounded(sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0);
}

function rounded(value: number) {
  return Number(value.toFixed(4));
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const child = join(path, entry.name);
        if (entry.isDirectory()) return directoryBytes(child);
        if (entry.isFile()) return (await stat(child)).size;
        return 0;
      }),
    )
  ).reduce((total, size) => total + size, 0);
}
