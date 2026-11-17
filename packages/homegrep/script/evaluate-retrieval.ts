import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extract } from "../src/engine/extraction/index.js";
import { detectFileType } from "../src/engine/file-type.js";
import type { FileInfo } from "../src/engine/types.js";
import type { HomeGrepContextItem } from "../src/engine/service/types.js";
import { enrichLexicalItemsWithStructure } from "../src/engine/service/structure-enrichment.js";
import { createSembleGrep } from "../src/index.js";

type Judgment = {
  path: string;
  startLine: number;
  endLine: number;
  grade: number;
  symbol?: string;
  symbolType?: string;
};
type FileJudgment = { path: string; grade: number };

type Task = {
  id: string;
  repository: string;
  split: string;
  category: string;
  query: string;
  answerable?: boolean;
  relevantFiles: FileJudgment[];
  relevant: Judgment[];
  symbolJudgmentsUnavailable?: string;
};

type Repository = {
  id: string;
  path: string;
  commit: string;
  split: string;
};

type RepositoryDataset = {
  repository: Repository;
  tasks: Task[];
};

const qrelsDirectory = new URL("../benchmarks/agentic-retrieval-v2/", import.meta.url);
const qrelsFiles = (await readdir(qrelsDirectory)).filter((name) => name.endsWith(".json"));
const repositoryDatasets = await Promise.all(
  qrelsFiles.map(async (name) =>
    (await Bun.file(new URL(name, qrelsDirectory)).json()) as RepositoryDataset,
  ),
);
const repositories = Object.fromEntries(repositoryDatasets.map((dataset) => [dataset.repository.id, dataset.repository]));
const dataset = {
  schemaVersion: 2,
  title: "HomeGrep multi-repository retrieval evaluation",
  annotationMethod: "Manual graded file and Tree-sitter symbol-span judgments against pinned clean repository snapshots.",
  repositories,
  tasks: repositoryDatasets.flatMap((part) =>
    part.tasks.map((task) => ({ ...task, repository: part.repository.id, split: part.repository.split })),
  ),
};
validateDataset(dataset);
const arguments_ = process.argv.slice(2);
const validateOnly = arguments_.includes("--validate-only");
const splitArgument = arguments_.find((argument) => argument.startsWith("--split="));
const split = splitArgument?.slice("--split=".length) ?? "all";
const repetitions = Number(process.env.HOMEGREP_EVAL_REPETITIONS ?? 30);
const warmups = Number(process.env.HOMEGREP_EVAL_WARMUPS ?? 3);
const allVariants = [
  "hybrid",
  "hybrid-alpha-025",
  "hybrid-alpha-075",
  "fts",
  "vector",
  "token-rerank",
  "tree-rerank",
] as const;
const requestedVariants = process.env.HOMEGREP_EVAL_VARIANTS?.split(",");
const variants = requestedVariants?.length
  ? requestedVariants.map((variant) => {
      if (!allVariants.includes(variant as (typeof allVariants)[number])) {
        throw new Error(`Unknown retrieval variant: ${variant}`);
      }
      return variant as (typeof allVariants)[number];
    })
  : allVariants;
if (!variants.includes("hybrid")) {
  throw new Error("Retrieval evaluations must include the hybrid baseline");
}

if (!Number.isInteger(repetitions) || repetitions < 1) {
  throw new Error("HOMEGREP_EVAL_REPETITIONS must be a positive integer");
}
if (!Number.isInteger(warmups) || warmups < 0) {
  throw new Error("HOMEGREP_EVAL_WARMUPS must be a non-negative integer");
}
if (!validateOnly && !process.env.HOMEGREP_HOME) {
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
validateRepositoryState(repositories, workspaces);
await validateJudgmentSources(tasks, workspaces);
if (validateOnly) {
  console.log(JSON.stringify({
    repositories: Object.keys(repositories).length,
    tasks: tasks.length,
    fileJudgments: tasks.reduce((count, task) => count + task.relevantFiles.length, 0),
    symbolJudgments: tasks.reduce((count, task) => count + task.relevant.length, 0),
    fileOnlyTasks: tasks.filter((task) => task.answerable !== false && task.relevant.length === 0).length,
  }));
  process.exit(0);
}
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
        limit: variant === "token-rerank" || variant === "tree-rerank" ? 100 : 10,
        autoUpdate: false,
        ...(variant === "hybrid-alpha-025" ? { hybridAlpha: 0.25 } : {}),
        ...(variant === "hybrid-alpha-075" ? { hybridAlpha: 0.75 } : {}),
        ...(variant === "fts" || variant === "vector"
          ? { routes: [{ mode: variant, query: task.query }] }
          : {}),
      };
      for (let warmup = 0; warmup < warmups; warmup += 1) {
        await service.context(request);
      }

      const structuralPreparation = variant === "tree-rerank"
        ? await prepareStructuralMetadata(
            request.root,
            (await service.context(request)).items,
          )
        : undefined;

      const samples: number[] = [];
      let result: Awaited<ReturnType<typeof service.context>> | undefined;
      let candidatePool: HomeGrepContextItem[] = [];
      for (let iteration = 0; iteration < repetitions; iteration += 1) {
        const started = performance.now();
        result = await service.context(request);
        if (variant === "token-rerank" || variant === "tree-rerank") {
          candidatePool = result.items;
          result = {
            ...result,
            items: variant === "tree-rerank"
              ? rerankByTreeStructure(task.query, result.items, structuralPreparation!.metadata)
              : rerankByLocalSignals(task.query, result.items),
          };
        }
        samples.push(performance.now() - started);
      }
      if (!result) throw new Error(`No result captured for ${task.id}/${variant}`);

      const taskScore = scoreTask(result.items, task.relevant, task.relevantFiles);
      const candidateScore =
        variant === "token-rerank" || variant === "tree-rerank"
          ? scoreTask(candidatePool, task.relevant, task.relevantFiles, 100)
          : undefined;
      const record = {
        taskId: task.id,
        repository: task.repository,
        split: task.split,
        category: task.category,
        ...taskScore,
        candidateRecallAt100: candidateScore?.["lineRecall@100"],
        candidateSymbolRecallAt100: candidateScore?.["symbolRecall@100"],
        structuralPreparationMs: structuralPreparation?.durationMs,
        structuralDiagnostics: structuralPreparation?.diagnostics,
        latencyMs: { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) },
        topResults: result.items.slice(0, 10).map((item) => ({
          path: item.file.relativePath,
          startLine: item.range.kind === "text" ? item.range.startLine : null,
          endLine: item.range.kind === "text" ? item.range.endLine : null,
          symbol: item.metadata?.kind === "code" ? item.metadata.symbolName : undefined,
          score: item.score,
        })),
      };
      measurements[variant]!.push(record);
      latencies[variant]!.push(...samples);
    }
  }

  const answerable = tasks.filter((task) => task.answerable !== false);
  const report = {
    schemaVersion: 2,
    dataset: "agentic-retrieval-v2",
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
    variantSettings: Object.fromEntries(
      variants.map((variant) => [
        variant,
        variant === "hybrid-alpha-025"
          ? { retrieval: "Semble hybrid", alpha: 0.25 }
          : variant === "hybrid-alpha-075"
            ? { retrieval: "Semble hybrid", alpha: 0.75 }
              : variant === "token-rerank"
                ? { retrieval: "Semble hybrid candidate pool", candidateLimit: 100, localRerank: "token/path signals" }
                : variant === "tree-rerank"
                  ? { retrieval: "Semble hybrid candidate pool", candidateLimit: 100, localRerank: "Tree-sitter symbol metadata" }
              : { retrieval: variant },
      ]),
    ),
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
          structuralPreparation: summarizeStructuralPreparation(measurements[variant]!),
          unanswerableFalseHitAt10: falseHitRate(
            measurements[variant]!,
            tasks.filter((task) => task.answerable === false),
          ),
        },
      ]),
    ),
    pairedNdcgDelta95CI: Object.fromEntries(
      variants
        .filter((variant) => variant !== "hybrid")
        .map((variant) => [
          `${variant}-minus-hybrid`,
          pairedBootstrap(measurements[variant]!, measurements.hybrid!, answerable),
        ]),
    ),
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

function scoreTask(
  items: HomeGrepContextItem[],
  relevant: Judgment[],
  relevantFiles: FileJudgment[],
  limit = 10,
) {
  const locations = relevant.map((judgment) => locationKey(judgment));
  const symbols = [...new Map(relevant.flatMap((judgment) => judgment.symbol
    ? [[symbolKey(judgment), judgment] as const]
    : [])).values()];
  const files = [...new Map(relevantFiles.map((judgment) => [
    judgment.path,
    {
      path: judgment.path,
      grade: Math.max(judgment.grade, ...relevantFiles.filter((item) => item.path === judgment.path).map((item) => item.grade)),
    },
  ] as const)).values()];
  const gainedLocations = new Set<string>();
  const gainedSymbols = new Set<string>();
  const gainedFiles = new Set<string>();
  const graded = items.slice(0, limit).map((item) => {
    const matches = relevant.filter((judgment) => rangeMatches(item, judgment));
    const novelLocations = matches.filter((judgment) => {
      const key = locationKey(judgment);
      if (gainedLocations.has(key)) return false;
      gainedLocations.add(key);
      return true;
    });
    const novelSymbols = matches.filter((judgment) => {
      if (!judgment.symbol) return false;
      const key = symbolKey(judgment);
      if (gainedSymbols.has(key)) return false;
      gainedSymbols.add(key);
      return true;
    });
    const file = files.find((judgment) => judgment.path === item.file.relativePath);
    const novelFile = file && !gainedFiles.has(file.path) ? file : undefined;
    if (novelFile) gainedFiles.add(novelFile.path);
    return {
      item,
      fileRelevant: Boolean(file),
      lineRelevant: matches.length > 0,
      symbolRelevant: novelSymbols.length > 0,
      lineGrade: Math.max(0, ...novelLocations.map((judgment) => judgment.grade)),
      symbolGrade: Math.max(0, ...novelSymbols.map((judgment) => judgment.grade)),
      fileGrade: novelFile?.grade ?? 0,
    };
  });
  const fileRank = graded.findIndex((entry) => entry.fileRelevant);
  const lineRank = graded.findIndex((entry) => entry.lineRelevant);
  const symbolRank = graded.findIndex((entry) => entry.symbolRelevant);
  const fileNdcg = ndcg(graded.map((entry) => entry.fileGrade), files.map((judgment) => judgment.grade));
  const lineNdcg = ndcg(graded.map((entry) => entry.lineGrade), relevant.map((judgment) => judgment.grade));
  const symbolNdcg = ndcg(graded.map((entry) => entry.symbolGrade), symbols.map((judgment) => judgment.grade));
  return {
    ...Object.fromEntries(
      (limit > 10 ? [limit] : [1, 5, 10]).flatMap((cutoff) => {
        const top = graded.slice(0, cutoff);
        const denominator = Math.max(1, top.length);
        const hitFiles = new Set(top.flatMap((entry) => entry.fileRelevant ? [entry.item.file.relativePath] : []));
        const retrievedFiles = new Set(top.map((entry) => entry.item.file.relativePath));
        const hitLocationCount = new Set(
          relevant.filter((judgment) => top.some((entry) => rangeMatches(entry.item, judgment))).map(locationKey),
        ).size;
        const hitSymbolCount = new Set(
          relevant.filter((judgment) => judgment.symbol && top.some((entry) => rangeMatches(entry.item, judgment))).map(symbolKey),
        ).size;
        return [
          [`pathRecall@${cutoff}`, files.length ? hitFiles.size / files.length : 0],
          [`pathPrecision@${cutoff}`, retrievedFiles.size ? hitFiles.size / retrievedFiles.size : 0],
          [`lineRecall@${cutoff}`, locations.length ? hitLocationCount / locations.length : 0],
          [`symbolRecall@${cutoff}`, symbols.length ? hitSymbolCount / symbols.length : 0],
          [`linePrecision@${cutoff}`, top.filter((entry) => entry.lineRelevant).length / denominator],
        ];
      }),
    ),
    fileMrr: fileRank < 0 ? 0 : 1 / (fileRank + 1),
    lineMrr: lineRank < 0 ? 0 : 1 / (lineRank + 1),
    symbolMrr: symbolRank < 0 ? 0 : 1 / (symbolRank + 1),
    mrr: symbolRank >= 0 ? 1 / (symbolRank + 1) : (lineRank < 0 ? 0 : 1 / (lineRank + 1)),
    "fileNdcg@10": fileNdcg,
    "lineNdcg@10": lineNdcg,
    "symbolNdcg@10": symbolNdcg,
    "ndcg@10": symbols.length ? symbolNdcg : locations.length ? lineNdcg : fileNdcg,
    symbolJudgmentCount: symbols.length,
    lineJudgmentCount: locations.length,
    retrievalCoverageAt5: lineRank >= 0 && lineRank < 5 ? 1 : 0,
  };
}

function rangeMatches(item: HomeGrepContextItem, judgment: Judgment) {
  return item.file.relativePath === judgment.path && item.range.kind === "text" &&
    item.range.startLine <= judgment.endLine && item.range.endLine >= judgment.startLine;
}

function locationKey(judgment: Judgment) {
  return `${judgment.path}:${judgment.startLine}-${judgment.endLine}`;
}

function symbolKey(judgment: Judgment) {
  return `${judgment.path}::${judgment.symbol}`;
}

function ndcg(gains: number[], idealGains: number[]) {
  const dcg = gains.slice(0, 10).reduce(
    (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
    0,
  );
  const idcg = [...idealGains].sort((left, right) => right - left).slice(0, 10).reduce(
    (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
    0,
  );
  return idcg ? dcg / idcg : 0;
}

function aggregate(rows: Array<Record<string, unknown>>, expectedTasks: Task[]) {
  const answerableIds = new Set(expectedTasks.map((task) => task.id));
  const selected = rows.filter((row) => answerableIds.has(String(row.taskId)));
  const symbolRows = selected.filter((row) => Number(row.symbolJudgmentCount) > 0);
  const lineRows = selected.filter((row) => Number(row.lineJudgmentCount) > 0);
  const metricNames = [
    "pathRecall@1", "pathRecall@5", "pathRecall@10",
    "pathPrecision@1", "pathPrecision@5", "pathPrecision@10",
    "lineRecall@1", "lineRecall@5", "lineRecall@10",
    "symbolRecall@1", "symbolRecall@5", "symbolRecall@10",
    "linePrecision@1", "linePrecision@5", "linePrecision@10",
    "fileMrr", "lineMrr", "symbolMrr", "fileNdcg@10", "lineNdcg@10", "symbolNdcg@10",
    "mrr", "ndcg@10", "retrievalCoverageAt5",
  ];
  const candidateRecalls = selected.flatMap((row) =>
    typeof row.candidateRecallAt100 === "number" ? [row.candidateRecallAt100] : [],
  );
  const repositoryGroups = [...new Set(expectedTasks.map((task) => task.repository))].map((repository) =>
    symbolRows.filter((row) => row.repository === repository).map((row) => Number(row["symbolNdcg@10"] ?? 0)),
  ).filter((group) => group.length > 0);
  return {
    tasks: selected.length,
    repositories: repositoryGroups.length,
    symbolQrelTasks: symbolRows.length,
    lineQrelTasks: lineRows.length,
    ...Object.fromEntries(metricNames.map((name) => {
      const rowsForMetric = name.startsWith("symbol") || name === "ndcg@10" || name === "mrr"
        ? (symbolRows.length ? symbolRows : lineRows.length ? lineRows : selected)
        : name.startsWith("line") ? lineRows : selected;
      return [name, mean(rowsForMetric.map((row) => Number(row[name] ?? 0)))];
    })),
    candidateRecallAt100: candidateRecalls.length ? mean(candidateRecalls) : undefined,
    symbolNdcg95CI: repositoryGroups.length > 1
      ? bootstrapHierarchicalCI(repositoryGroups)
      : bootstrapMeanCI(repositoryGroups[0] ?? []),
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

function summarizeStructuralPreparation(rows: Array<Record<string, unknown>>) {
  const selected = rows.flatMap((row) =>
    typeof row.structuralPreparationMs === "number"
      ? [{ durationMs: row.structuralPreparationMs, diagnostics: row.structuralDiagnostics as Record<string, number> }]
      : [],
  );
  if (!selected.length) return null;
  return {
    p50Ms: percentile(selected.map((entry) => entry.durationMs), 0.5),
    p95Ms: percentile(selected.map((entry) => entry.durationMs), 0.95),
    totalMs: rounded(selected.reduce((sum, entry) => sum + entry.durationMs, 0)),
    parsedFiles: selected.reduce((sum, entry) => sum + (entry.diagnostics.parsedFiles ?? 0), 0),
    enrichedFiles: selected.reduce((sum, entry) => sum + (entry.diagnostics.enrichedFiles ?? 0), 0),
  };
}

function pairedBootstrap(left: Array<Record<string, unknown>>, right: Array<Record<string, unknown>>, tasks: Task[]) {
  const rightByTask = new Map(right.map((row) => [String(row.taskId), Number(row["symbolNdcg@10"] ?? 0)]));
  const symbolTasks = tasks.filter((task) => task.answerable !== false && task.relevant.length > 0);
  const taskById = new Map(symbolTasks.map((task) => [task.id, task]));
  const deltas = left.flatMap((row) => {
    const baseline = rightByTask.get(String(row.taskId));
    const task = taskById.get(String(row.taskId));
    return baseline === undefined || !task
      ? []
      : [{ repository: task.repository, delta: Number(row["symbolNdcg@10"] ?? 0) - baseline }];
  });
  const groups = [...new Set(tasks.map((task) => task.repository))].map((repository) =>
    deltas.filter((entry) => entry.repository === repository).map((entry) => entry.delta),
  ).filter((group) => group.length > 0);
  return groups.length > 1 ? bootstrapHierarchicalCI(groups) : bootstrapMeanCI(groups[0] ?? []);
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

function bootstrapHierarchicalCI(groups: number[][]) {
  const nonEmpty = groups.filter((group) => group.length > 0);
  if (!nonEmpty.length) return bootstrapMeanCI([]);
  let seed = 1_428_771;
  const randomIndex = (length: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % length;
  };
  const samples = Array.from({ length: 2000 }, () => {
    const repositoryMeans = Array.from({ length: nonEmpty.length }, () => {
      const group = nonEmpty[randomIndex(nonEmpty.length)]!;
      return mean(Array.from({ length: group.length }, () => group[randomIndex(group.length)]!));
    });
    return mean(repositoryMeans);
  }).sort((left, right) => left - right);
  return {
    mean: rounded(mean(nonEmpty.map(mean))),
    low95: rounded(samples[Math.floor(samples.length * 0.025)]!),
    high95: rounded(samples[Math.floor(samples.length * 0.975)]!),
    samples: nonEmpty.reduce((total, group) => total + group.length, 0),
    repositories: nonEmpty.length,
    bootstrapReplicates: samples.length,
    method: "repository-then-task",
  };
}

function validateDataset(data: { repositories: Record<string, Repository>; tasks: Task[] }) {
  const repositories = Object.values(data.repositories);
  if (repositories.length < 5) throw new Error(`Expected at least five repositories; found ${repositories.length}`);
  const ids = new Set<string>();
  for (const repository of repositories) {
    const tasks = data.tasks.filter((task) => task.repository === repository.id);
    if (tasks.length < 30) throw new Error(`${repository.id} has ${tasks.length} tasks; at least 30 are required`);
    if (tasks.some((task) => task.split !== repository.split)) throw new Error(`${repository.id} has a task with a mismatched split`);
  }
  if (repositories.filter((repository) => repository.split === "development").length < 3 ||
      repositories.filter((repository) => repository.split === "held_out_repository").length < 2) {
    throw new Error("Use at least three development repositories and two held-out repositories");
  }
  for (const task of data.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (task.answerable === false) continue;
    if (!task.relevantFiles?.length) throw new Error(`${task.id} needs file-level qrels`);
    if (!task.relevant?.length && !task.symbolJudgmentsUnavailable?.trim()) {
      throw new Error(`${task.id} needs symbol qrels or a documented extraction limitation`);
    }
    if (task.relevant.length && task.symbolJudgmentsUnavailable) {
      throw new Error(`${task.id} cannot mark symbol qrels unavailable while providing symbol judgments`);
    }
    for (const judgment of task.relevantFiles) {
      if (!judgment.path || judgment.grade < 1 || judgment.grade > 3) throw new Error(`${task.id} has an invalid file judgment`);
    }
    const filePaths = new Set(task.relevantFiles.map((judgment) => judgment.path));
    for (const judgment of task.relevant) {
      if (!judgment.symbol || !judgment.symbolType) throw new Error(`${task.id} has a symbol judgment without a name or type`);
      if (!filePaths.has(judgment.path)) throw new Error(`${task.id} omits file-level relevance for ${judgment.path}`);
      if (!Number.isInteger(judgment.startLine) || !Number.isInteger(judgment.endLine) || judgment.startLine < 1 || judgment.endLine < judgment.startLine) {
        throw new Error(`${task.id} has an invalid line span for ${judgment.symbol}`);
      }
      if (judgment.grade < 1 || judgment.grade > 3) throw new Error(`${task.id} has an invalid symbol grade`);
    }
  }
}

function validateRepositoryState(
  repositories: Record<string, Repository>,
  workspaces: Record<string, { root: string; commit: string; dirty: boolean }>,
) {
  for (const [id, repository] of Object.entries(repositories)) {
    const workspace = workspaces[id];
    if (!workspace) throw new Error(`Missing checkout for ${id}`);
    if (workspace.dirty) {
      const dirtyPaths = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: workspace.root,
        encoding: "utf8",
      }).split("\n").filter(Boolean).map((line) => line.slice(3));
      const unexpected = dirtyPaths.filter((path) => !isEvaluationOnlyChange(path));
      if (id !== "homecode" || unexpected.length) throw new Error(`${id} must be clean before evaluation`);
    }
    if (workspace.commit === repository.commit) continue;
    if (id !== "homecode") throw new Error(`${id} checkout ${workspace.commit} differs from pinned ${repository.commit}`);
    const changes = execFileSync("git", ["diff", "--name-only", `${repository.commit}..${workspace.commit}`], {
      cwd: workspace.root,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    const sourceChanges = changes.filter((path) => !isEvaluationOnlyChange(path));
    if (sourceChanges.length) throw new Error(`HomeCode source differs from pinned qrels snapshot: ${sourceChanges.join(", ")}`);
  }
}

function isEvaluationOnlyChange(path: string) {
  return path.startsWith("docs/") ||
    path.startsWith("packages/homegrep/benchmarks/agentic-retrieval-v2/") ||
    path === "packages/homegrep/.gitignore" ||
    path === "packages/homegrep/script/evaluate-retrieval.ts";
}

async function validateJudgmentSources(
  tasks: Task[],
  workspaces: Record<string, { root: string }>,
) {
  const fileCache = new Map<string, string[]>();
  const symbolsByFile = new Map<string, Map<string, Array<{ startLine: number; endLine: number }>>>();
  for (const task of tasks) {
    const root = workspaces[task.repository]?.root;
    if (!root) throw new Error(`Missing workspace root for ${task.repository}`);
    const targets = [
      ...task.relevantFiles.map((judgment) => judgment.path),
      ...task.relevant.map((judgment) => judgment.path),
    ];
    for (const target of new Set(targets)) {
      validateRelativePath(target, task.id);
      const key = `${task.repository}:${target}`;
      if (!fileCache.has(key)) {
        const text = await readFile(join(root, target), "utf8").catch(() => null);
        if (text === null) throw new Error(`${task.id} references missing file ${target}`);
        fileCache.set(key, text.split(/\r?\n/));
        symbolsByFile.set(key, await indexedSymbolRanges(root, target, text));
      }
    }
    for (const judgment of task.relevant) {
      const lines = fileCache.get(`${task.repository}:${judgment.path}`)!;
      if (judgment.endLine > lines.length) throw new Error(`${task.id} line span exceeds ${judgment.path}`);
      const leaf = judgment.symbol.split(/[.:/]/).filter(Boolean).at(-1)!;
      const ranges = symbolsByFile.get(`${task.repository}:${judgment.path}`)?.get(leaf) ?? [];
      if (!ranges.length) {
        throw new Error(`${task.id} symbol ${judgment.symbol} is not recognized by Tree-sitter in ${judgment.path}`);
      }
      if (!ranges.some((range) => range.startLine <= judgment.endLine && range.endLine >= judgment.startLine)) {
        throw new Error(`${task.id} span does not overlap Tree-sitter symbol ${judgment.symbol}`);
      }
    }
  }
}

async function indexedSymbolRanges(root: string, relativePath: string, text: string) {
  const fragments = await extractSource(root, relativePath, text);
  const symbols = new Map<string, Array<{ startLine: number; endLine: number }>>();
  for (const fragment of fragments) {
    if (fragment.metadata?.kind !== "code" || !fragment.metadata.symbolName || fragment.range.kind !== "text") continue;
    const ranges = symbols.get(fragment.metadata.symbolName) ?? [];
    ranges.push({ startLine: fragment.range.startLine, endLine: fragment.range.endLine });
    symbols.set(fragment.metadata.symbolName, ranges);
  }
  return symbols;
}

async function extractSource(root: string, relativePath: string, text: string) {
  const absolutePath = join(root, relativePath);
  const detected = detectFileType(absolutePath);
  if (!detected || detected.kind !== "code") return [];
  const info = await stat(absolutePath);
  const file: FileInfo = {
    id: `${root}:${relativePath}`,
    absolutePath,
    relativePath,
    rootPath: root,
    sizeBytes: info.size,
    lastModifiedTime: info.mtimeMs,
    kind: detected.kind,
    format: detected.format,
  };
  return extract({ kind: "text", file, text });
}

function validateRelativePath(path: string, taskId: string) {
  if (!path || path.startsWith("/") || path.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error(`${taskId} has a non-relative qrel path`);
  }
}

async function prepareStructuralMetadata(root: string, items: HomeGrepContextItem[]) {
  const started = performance.now();
  const lexicalItems = items.map((item) => ({
    ...item,
    kind: "lexical_match" as const,
    matchedBy: "lexical" as const,
  }));
  const enriched = await enrichLexicalItemsWithStructure(root, lexicalItems, 100);
  return {
    durationMs: performance.now() - started,
    diagnostics: enriched.diagnostics,
    metadata: new Map(enriched.items.flatMap((item) => item.container?.metadata
      ? [[itemIdentity(item), { metadata: item.metadata, container: item.container }] as const]
      : [])),
  };
}

function rerankByTreeStructure(
  query: string,
  items: HomeGrepContextItem[],
  metadata: Map<string, Pick<HomeGrepContextItem, "metadata" | "container">>,
) {
  const annotated = items.map((item) => ({
    ...item,
    ...metadata.get(itemIdentity(item)),
  }));
  const stopWords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "does", "for", "from", "how", "in", "into", "is", "it", "of", "on", "or", "the", "to", "what", "when", "where", "which", "who", "with"]);
  const queryTerms = [...new Set(tokens(query))].filter((term) => !stopWords.has(term));
  const fields = [
    { name: "symbol", weight: 3, text: (item: (typeof annotated)[number]) => item.metadata?.kind === "code" ? item.metadata.symbolName ?? "" : item.metadata?.kind === "markdown" ? item.metadata.heading ?? "" : "" },
    { name: "signature", weight: 2, text: (item: (typeof annotated)[number]) => item.metadata?.kind === "code" ? item.metadata.signature ?? "" : "" },
    { name: "doc", weight: 2, text: (item: (typeof annotated)[number]) => item.metadata?.kind === "code" ? item.metadata.doc ?? "" : "" },
    { name: "scope", weight: 1, text: (item: (typeof annotated)[number]) => item.metadata?.scope ?? "" },
  ];
  const scores = annotated.map(() => 0);
  for (const field of fields) {
    const documents = annotated.map((item) => tokens(field.text(item)));
    const averageLength = mean(documents.map((document) => document.length)) || 1;
    const frequencies = new Map(queryTerms.map((term) => [
      term,
      documents.filter((document) => document.includes(term)).length,
    ]));
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index]!;
      for (const term of queryTerms) {
        const frequency = document.filter((token) => token === term).length;
        if (!frequency) continue;
        const documentFrequency = frequencies.get(term) ?? 0;
        const inverse = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
        scores[index]! += field.weight * inverse * frequency * 2.5 /
          (frequency + 1.5 * (0.25 + 0.75 * document.length / averageLength));
      }
    }
  }
  return annotated
    .map((item, index) => ({ item, score: scores[index] ?? 0, originalRank: item.rank }))
    .sort((left, right) => right.score - left.score || left.originalRank - right.originalRank)
    .map(({ item }, index) => ({ ...item, rank: index + 1 }));
}

function itemIdentity(item: HomeGrepContextItem) {
  return item.entityId ?? `${item.file.relativePath}:${JSON.stringify(item.range)}`;
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
