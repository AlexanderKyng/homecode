import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { env, pipeline } from "@huggingface/transformers";
import type { HomeGrepContextItem } from "../src/engine/service/types.js";
import { createSembleGrep } from "../src/index.js";

type Judgment = {
  path: string;
  startLine: number;
  endLine: number;
  grade: number;
  symbol?: string;
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
};
type Repository = { id: string; path: string; commit: string; split: string };
type Pool = {
  items: HomeGrepContextItem[];
  searchMs: number;
};
type Row = {
  taskId: string;
  repository: string;
  split: string;
  symbolJudgmentCount: number;
  candidateSymbolRecallAt100: number;
  hybrid: Record<string, number>;
  codeEmbedding: Record<string, number>;
  searchMs: number[];
  rerankMs: number[];
  hybridTokens: number[];
  returnedTokens: number[];
};

const dataDirectory = new URL("../benchmarks/agentic-retrieval-v2/", import.meta.url);
const parts = await Promise.all(
  (await readdir(dataDirectory)).filter((name) => name.endsWith(".json")).map(async (name) =>
    JSON.parse(await readFile(new URL(name, dataDirectory), "utf8")) as { repository: Repository; tasks: Omit<Task, "repository" | "split">[] },
  ),
);
const repositories = Object.fromEntries(parts.map((part) => [part.repository.id, part.repository]));
const tasks = parts.flatMap((part) => part.tasks.map((task) => ({
  ...task,
  repository: part.repository.id,
  split: part.repository.split,
})));
const repeats = Number(process.env.HOMEGREP_EVAL_REPETITIONS ?? 30);
const warmups = Number(process.env.HOMEGREP_EVAL_WARMUPS ?? 3);
const taskLimit = Number(process.env.HOMEGREP_EVAL_TASK_LIMIT ?? tasks.length);
const maxTokens = Number(process.env.HOMEGREP_EVAL_MAX_TOKENS ?? 256);
const batchSize = Number(process.env.HOMEGREP_EVAL_EMBEDDING_BATCH_SIZE ?? 16);
const stateDirectory = process.env.HOMEGREP_HOME;
const modelPath = process.env.HOMEGREP_EVAL_CODE_MODEL;
const modelName = process.env.HOMEGREP_EVAL_MODEL_NAME ?? "Shuu12121/NightOwl-CodeEmbedding";
const modelRevision = process.env.HOMEGREP_EVAL_MODEL_REVISION ?? "cfc3c6d172a93c79826db380ce82b6fee377ae1c";
const modelLicense = process.env.HOMEGREP_EVAL_MODEL_LICENSE ?? "Apache-2.0";
const pooling = (process.env.HOMEGREP_EVAL_MODEL_POOLING ?? "cls") as "cls" | "mean";
const vectorDimension = Number(process.env.HOMEGREP_EVAL_VECTOR_DIMENSIONS ?? 768);
if (!stateDirectory) throw new Error("Set HOMEGREP_HOME to a new isolated evaluation state directory");
if (!modelPath) throw new Error("Set HOMEGREP_EVAL_CODE_MODEL to a local pinned ONNX model directory");
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("HOMEGREP_EVAL_REPETITIONS must be positive");
if (!Number.isInteger(warmups) || warmups < 0) throw new Error("HOMEGREP_EVAL_WARMUPS must not be negative");
if (!Number.isInteger(taskLimit) || taskLimit < 1) throw new Error("HOMEGREP_EVAL_TASK_LIMIT must be positive");
if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("HOMEGREP_EVAL_MAX_TOKENS must be positive");
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("HOMEGREP_EVAL_EMBEDDING_BATCH_SIZE must be positive");
if (!Number.isInteger(vectorDimension) || vectorDimension < 1) throw new Error("HOMEGREP_EVAL_VECTOR_DIMENSIONS must be positive");
validateRepositories(repositories);
const evaluationTasks = tasks.slice(0, taskLimit);

const resourceBefore = process.resourceUsage();
const services = new Map<string, Awaited<ReturnType<typeof createSembleGrep>>>();
const taskPools = new Map<string, Pool[]>();
const documents = new Map<string, string>();
const indexes: Record<string, unknown> = {};
for (const task of evaluationTasks) {
  const repository = repositories[task.repository]!;
  let service = services.get(task.repository);
  if (!service) {
    service = await createSembleGrep({ root: repository.path });
    const indexed = await service.index({ root: repository.path, rebuild: true });
    const info = await service.info({ root: repository.path });
    indexes[task.repository] = {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository.path, encoding: "utf8" }).trim(),
      filesScanned: indexed.filesScanned,
      entities: indexed.entitiesCreated,
      durationMs: rounded(indexed.durationMs),
      indexBytes: await directoryBytes(info.indexPath),
    };
    services.set(task.repository, service);
  }
  const pools: Pool[] = [];
  for (let iteration = 0; iteration < repeats; iteration += 1) {
    if (iteration < warmups) await service.context({ root: repository.path, query: task.query, limit: 100, autoUpdate: false });
    const started = performance.now();
    const result = await service.context({ root: repository.path, query: task.query, limit: 100, autoUpdate: false });
    pools.push({ items: result.items, searchMs: performance.now() - started });
    for (const item of result.items) documents.set(itemIdentity(item), `${item.file.relativePath}\n${item.content}`);
  }
  taskPools.set(task.id, pools);
}

env.allowRemoteModels = false;
const modelStarted = performance.now();
const encoder = await pipeline("feature-extraction", resolve(modelPath), {
  dtype: "fp32",
  local_files_only: true,
  device: "cpu",
  session_options: {
    executionProviders: ["cpu"],
    intraOpNumThreads: Number(process.env.HOMEGREP_EVAL_CPU_THREADS ?? 4),
    interOpNumThreads: 1,
    executionMode: "sequential",
  },
});
const modelLoadMs = performance.now() - modelStarted;
const documentEntries = [...documents.entries()];
const documentTexts = documentEntries.map(([, text]) => text);
const documentVectors = new Map<string, Float32Array>();
const documentEncodingStarted = performance.now();
for (let offset = 0; offset < documentTexts.length; offset += batchSize) {
  const texts = documentTexts.slice(offset, offset + batchSize);
  const embeddings = await encoder(texts, {
    pooling,
    normalize: true,
    truncation: true,
    max_length: maxTokens,
  });
  if (embeddings.dims[0] !== texts.length || embeddings.dims[1] !== vectorDimension) {
    throw new Error(`Unexpected embedding dimensions: ${embeddings.dims.join("x")}`);
  }
  for (let index = 0; index < texts.length; index += 1) {
    const vector = new Float32Array(vectorDimension);
    const start = index * vectorDimension;
    for (let dim = 0; dim < vectorDimension; dim += 1) vector[dim] = Number(embeddings.data[start + dim]);
    documentVectors.set(documentEntries[offset + index]![0], vector);
  }
}
const documentEncodingMs = performance.now() - documentEncodingStarted;

const tokenizerPath = process.env.HOMEGREP_EVAL_POTION_TOKENIZER;
if (!tokenizerPath) throw new Error("Set HOMEGREP_EVAL_POTION_TOKENIZER to the pinned Potion tokenizer.json");
const tokenizerJson = await Bun.file(tokenizerPath).json();
const { Tokenizer } = await import("@huggingface/tokenizers");
const tokenizer = new Tokenizer(tokenizerJson, {});
const tokenCount = (text: string) => tokenizer.encode(text, { add_special_tokens: false }).ids.length;
const rows: Row[] = [];
try {
  for (const task of evaluationTasks) {
    const pools = taskPools.get(task.id)!;
    const queryVectors: Float32Array[] = [];
    const rerankMs: number[] = [];
    for (let index = 0; index < warmups; index += 1) {
      await encoder([task.query], { pooling, normalize: true, truncation: true, max_length: maxTokens });
    }
    for (let index = 0; index < pools.length; index += 1) {
      const started = performance.now();
      const encoded = await encoder([task.query], {
        pooling,
        normalize: true,
        truncation: true,
        max_length: maxTokens,
      });
      const queryVector = Float32Array.from(encoded.data as ArrayLike<number>);
      const ranked = pools[index]!.items.map((item) => ({
        item,
        score: dot(queryVector, documentVectors.get(itemIdentity(item))!),
      })).sort((left, right) => right.score - left.score || left.item.rank - right.item.rank);
      queryVectors.push(queryVector);
      rerankMs.push(performance.now() - started);
    }

    const scored = pools.map((pool, index) => {
      const queryVector = queryVectors[index]!;
      const ranked = pool.items.map((item) => ({
        item,
        score: dot(queryVector, documentVectors.get(itemIdentity(item))!),
      })).sort((left, right) => right.score - left.score || left.item.rank - right.item.rank);
      const hybridScore = scoreTask(pool.items.slice(0, 10), task);
      const codeScore = scoreTask(ranked.slice(0, 10).map((entry) => entry.item), task);
      return {
        hybridScore,
        codeScore,
        candidateSymbolRecallAt100: scoreTask(pool.items, task, 100)["symbolRecall@100"],
        searchMs: pool.searchMs,
        rerankMs: rerankMs[index]!,
        hybridTokens: tokenCount(formatOutput(pool.items.slice(0, 10))),
        returnedTokens: tokenCount(formatOutput(ranked.slice(0, 10).map((entry, rank) => ({ ...entry.item, rank: rank + 1, score: entry.score })))),
      };
    });
    const meanScores = (key: "hybridScore" | "codeScore") => Object.fromEntries(
      Object.keys(scored[0]![key]).map((metric) => [metric, mean(scored.map((sample) => sample[key][metric]!))]),
    );
    rows.push({
      taskId: task.id,
      repository: task.repository,
      split: task.split,
      symbolJudgmentCount: new Set(task.relevant.flatMap((judgment) => judgment.symbol ? [symbolKey(judgment)] : [])).size,
      candidateSymbolRecallAt100: mean(scored.map((sample) => sample.candidateSymbolRecallAt100)),
      hybrid: meanScores("hybridScore"),
      codeEmbedding: meanScores("codeScore"),
      searchMs: scored.map((sample) => sample.searchMs),
      rerankMs,
      hybridTokens: scored.map((sample) => sample.hybridTokens),
      returnedTokens: scored.map((sample) => sample.returnedTokens),
    });
  }
} finally {
  await Promise.all([...services.values()].map((service) => service.close()));
  await encoder.dispose();
}

const answerable = rows.filter((row) => tasks.find((task) => task.id === row.taskId)?.answerable !== false);
const symbolRows = answerable.filter((row) => row.symbolJudgmentCount > 0);
const pairedComparisons = Object.fromEntries([
  ["symbolNdcg@10", symbolRows],
  ["symbolRecall@10", symbolRows],
  ["symbolMrr", symbolRows],
  ["fileNdcg@10", answerable],
  ["pathRecall@10", answerable],
  ["pathPrecision@10", answerable],
  ["linePrecision@10", answerable],
].map(([metric, selected]) => [metric, bootstrapHierarchicalCI(selected.map((row) => ({
  repository: row.repository,
  value: row.codeEmbedding[metric]! - row.hybrid[metric]!,
})))]));
const report = {
  schemaVersion: 1,
  dataset: "agentic-retrieval-v2",
  engine: "Semble hybrid candidate pool, unchanged baseline",
  engineRevision: "8ee6463efbb1ff755c339e965c7298b7afd7db5b",
  reranker: {
    model: modelName,
    modelSnapshot: modelRevision,
    license: modelLicense,
    device: "CPU via Transformers.js / ONNX Runtime",
    cpuThreads: Number(process.env.HOMEGREP_EVAL_CPU_THREADS ?? 4),
    pooling: pooling.toUpperCase(),
    normalized: true,
    maxTokens,
    candidateLimit: 100,
    score: "cosine similarity",
  },
  measuredAt: new Date().toISOString(),
  stateDirectory: resolve(stateDirectory),
  tasks: rows.length,
  answerableTasks: answerable.length,
  symbolQrelTasks: symbolRows.length,
  repetitionsPerTask: repeats,
  warmupsPerTask: warmups,
  modelLoadMs: rounded(modelLoadMs),
  indexes,
  candidateDocumentCount: documents.size,
  candidateDocumentEncodingMs: rounded(documentEncodingMs),
  candidateVectorBytes: documents.size * vectorDimension * Float32Array.BYTES_PER_ELEMENT,
  aggregate: {
    hybrid: aggregate(answerable, "hybrid"),
    codeEmbedding: aggregate(answerable, "codeEmbedding"),
    candidateSymbolRecallAt100: mean(symbolRows.map((row) => row.candidateSymbolRecallAt100)),
    pairedMetricDelta95CI: pairedComparisons,
    latencyMs: {
      sembleSearch: summarizeSamples(rows.flatMap((row) => row.searchMs)),
      codeQueryEncodingAndRerank: summarizeSamples(rows.flatMap((row) => row.rerankMs)),
      estimatedCombined: summarizeSamples(rows.flatMap((row) => row.searchMs.map((duration, index) => duration + row.rerankMs[index]!))),
    },
    returnedContextTokens: {
      hybridMean: mean(answerable.flatMap((row) => row.hybridTokens)),
      hybridP50: percentile(answerable.flatMap((row) => row.hybridTokens), 0.5),
      hybridP95: percentile(answerable.flatMap((row) => row.hybridTokens), 0.95),
      codeEmbeddingMean: mean(answerable.flatMap((row) => row.returnedTokens)),
      codeEmbeddingP50: percentile(answerable.flatMap((row) => row.returnedTokens), 0.5),
      codeEmbeddingP95: percentile(answerable.flatMap((row) => row.returnedTokens), 0.95),
      tokenizer: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
      note: "Exact token count for HomeCode grep output under the Semble embedding tokenizer, not the downstream LLM tokenizer or full prompt usage.",
    },
  },
  byRepository: Object.fromEntries([...new Set(answerable.map((row) => row.repository))].map((repository) => {
    const selected = answerable.filter((row) => row.repository === repository);
    return [repository, { split: selected[0]?.split, hybrid: aggregate(selected, "hybrid"), codeEmbedding: aggregate(selected, "codeEmbedding") }];
  })),
  processResourceDelta: {
    userCpuMs: (process.resourceUsage().userCPUTime - resourceBefore.userCPUTime) / 1000,
    systemCpuMs: (process.resourceUsage().systemCPUTime - resourceBefore.systemCPUTime) / 1000,
    maxRssKiB: process.resourceUsage().maxRSS,
    note: "Node process only; wrap with /usr/bin/time -v to include the Semble Python child process.",
  },
  taskResults: rows,
};
const output = JSON.stringify(report, null, 2);
if (process.env.HOMEGREP_EVAL_OUTPUT) await Bun.write(process.env.HOMEGREP_EVAL_OUTPUT, `${output}\n`);
console.log(JSON.stringify({ aggregate: report.aggregate, indexes: Object.keys(indexes), processResourceDelta: report.processResourceDelta }, null, 2));

function validateRepositories(data: Record<string, Repository>) {
  for (const repository of Object.values(data)) {
    const root = resolve(repository.path);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (commit !== repository.commit && repository.id !== "homecode") {
      throw new Error(`${repository.id} is at ${commit}, expected ${repository.commit}`);
    }
  }
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return directoryBytes(child);
    if (entry.isFile()) return (await Bun.file(child).stat()).size;
    return 0;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

function itemIdentity(item: HomeGrepContextItem) {
  const range = item.range.kind === "text" ? `${item.range.startLine}-${item.range.endLine}` : "non-text";
  return textIdentity(`${item.file.relativePath}:${range}\n${item.content}`);
}

function textIdentity(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function rangeMatches(item: HomeGrepContextItem, judgment: Judgment) {
  return item.file.relativePath === judgment.path && item.range.kind === "text" &&
    item.range.startLine <= judgment.endLine && item.range.endLine >= judgment.startLine;
}

function symbolKey(judgment: Judgment) {
  return `${judgment.path}::${judgment.symbol}`;
}

function scoreTask(items: HomeGrepContextItem[], task: Task, limit = 10) {
  const symbols = [...new Map(task.relevant.flatMap((judgment) => judgment.symbol ? [[symbolKey(judgment), judgment] as const] : [])).values()];
  const files = [...new Map(task.relevantFiles.map((judgment) => [judgment.path, judgment] as const)).values()];
  const foundSymbols = new Set<string>();
  const foundFiles = new Set<string>();
  const top = items.slice(0, limit).map((item) => {
    const matchingSymbols = task.relevant.filter((judgment) => judgment.symbol && rangeMatches(item, judgment));
    const novelSymbols = matchingSymbols.filter((judgment) => {
      const key = symbolKey(judgment);
      if (foundSymbols.has(key)) return false;
      foundSymbols.add(key);
      return true;
    });
    const file = files.find((judgment) => judgment.path === item.file.relativePath);
    const novelFile = file && !foundFiles.has(file.path) ? file : undefined;
    if (novelFile) foundFiles.add(novelFile.path);
    return {
      fileRelevant: Boolean(file),
      lineRelevant: matchingSymbols.length > 0,
      symbolRelevant: novelSymbols.length > 0,
      fileGrade: novelFile?.grade ?? 0,
      lineGrade: Math.max(0, ...matchingSymbols.map((judgment) => judgment.grade)),
      symbolGrade: Math.max(0, ...novelSymbols.map((judgment) => judgment.grade)),
    };
  });
  const fileRank = top.findIndex((entry) => entry.fileRelevant);
  const lineRank = top.findIndex((entry) => entry.lineRelevant);
  const symbolRank = top.findIndex((entry) => entry.symbolRelevant);
  const at = (cutoff: number) => {
    const chunk = top.slice(0, cutoff);
    const relevantFiles = new Set(chunk.flatMap((entry, index) => entry.fileRelevant ? [items[index]!.file.relativePath] : []));
    const retrievedFiles = new Set(chunk.map((_, index) => items[index]!.file.relativePath));
    const relevantSymbols = new Set(task.relevant.filter((judgment) => judgment.symbol && items.slice(0, cutoff).some((item) => rangeMatches(item, judgment))).map(symbolKey));
    return {
      [`pathRecall@${cutoff}`]: files.length ? relevantFiles.size / files.length : 0,
      [`pathPrecision@${cutoff}`]: retrievedFiles.size ? relevantFiles.size / retrievedFiles.size : 0,
      [`symbolRecall@${cutoff}`]: symbols.length ? relevantSymbols.size / symbols.length : 0,
      [`lineRecall@${cutoff}`]: task.relevant.length ? relevantSymbols.size / task.relevant.length : 0,
      [`linePrecision@${cutoff}`]: chunk.length ? chunk.filter((_, index) => task.relevant.some((judgment) => rangeMatches(items[index]!, judgment))).length / chunk.length : 0,
    };
  };
  return {
    ...at(1),
    ...at(5),
    ...at(10),
    ...at(100),
    fileMrr: fileRank < 0 ? 0 : 1 / (fileRank + 1),
    lineMrr: lineRank < 0 ? 0 : 1 / (lineRank + 1),
    symbolMrr: symbolRank < 0 ? 0 : 1 / (symbolRank + 1),
    "symbolNdcg@10": ndcg(top.map((entry) => entry.symbolGrade), symbols.map((judgment) => judgment.grade)),
    "fileNdcg@10": ndcg(top.map((entry) => entry.fileGrade), files.map((judgment) => judgment.grade)),
  };
}

function aggregate(selected: Row[], variant: "hybrid" | "codeEmbedding") {
  const symbolSelected = selected.filter((row) => row.symbolJudgmentCount > 0);
  const metricSet = (rows: Row[], key: "hybrid" | "codeEmbedding") => Object.fromEntries(
    Object.keys(rows[0]?.[key] ?? {}).map((metric) => [metric, mean(rows.map((row) => row[key][metric]!))]),
  );
  return {
    tasks: selected.length,
    symbolTasks: symbolSelected.length,
    file: metricSet(selected, variant),
    symbol: metricSet(symbolSelected, variant),
  };
}

function bootstrapHierarchicalCI(values: Array<{ repository: string; value: number }>) {
  const groups = [...new Set(values.map((item) => item.repository))].map((repository) =>
    values.filter((item) => item.repository === repository).map((item) => item.value),
  );
  let seed = 991_873;
  const random = (length: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % length;
  };
  const samples = Array.from({ length: 2000 }, () => mean(Array.from({ length: groups.length }, () => {
    const group = groups[random(groups.length)]!;
    return mean(Array.from({ length: group.length }, () => group[random(group.length)]!));
  }))).sort((left, right) => left - right);
  return {
    mean: rounded(mean(values.map((item) => item.value))),
    low95: rounded(samples[Math.floor(samples.length * 0.025)]!),
    high95: rounded(samples[Math.floor(samples.length * 0.975)]!),
    tasks: values.length,
    repositories: groups.length,
    bootstrapReplicates: samples.length,
    method: "repository-then-task paired bootstrap",
  };
}

function summarizeSamples(samples: number[]) {
  return { p50: rounded(percentile(samples, 0.5)), p95: rounded(percentile(samples, 0.95)), samples: samples.length };
}

function percentile(samples: number[], quantile: number) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * quantile)] ?? 0;
}

function ndcg(gains: number[], idealGains: number[]) {
  const dcg = gains.slice(0, 10).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const idcg = [...idealGains].sort((left, right) => right - left).slice(0, 10).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  return idcg ? dcg / idcg : 0;
}

function dot(left: Float32Array, right: Float32Array) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index]! * right[index]!;
  return score;
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rounded(value: number) {
  return Number(value.toFixed(3));
}

function formatOutput(items: HomeGrepContextItem[]) {
  return items.map((item) => {
    const lineRange = item.range.kind === "text" ? `:${item.range.startLine}-${item.range.endLine}` : "";
    const score = item.score === undefined ? "" : ` score=${item.score.toFixed(3)}`;
    return `${item.rank}. ${item.file.relativePath}${lineRange} [${item.matchedBy}; ${item.status}${score}]\n${item.content}`;
  }).join("\n\n");
}
