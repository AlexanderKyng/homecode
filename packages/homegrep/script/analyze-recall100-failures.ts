import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createSembleGrep } from "../src/index.js";
import type { HomeGrepContextItem } from "../src/engine/service/types.js";

type Judgment = { path: string; startLine: number; endLine: number; grade: number; symbol?: string };
type FileJudgment = { path: string; grade: number };
type Task = {
  id: string;
  category: string;
  query: string;
  answerable?: boolean;
  relevantFiles: FileJudgment[];
  relevant: Judgment[];
  repository: string;
  split: string;
};
type Repository = { id: string; path: string; commit: string; split: string };
type IndexChunk = { file_path: string; start_line: number; end_line: number };
type IndexRange = { startLine: number; endLine: number };
type Candidate = { path: string; startLine: number; endLine: number; rank: number };

const qrelsDirectory = new URL("../benchmarks/agentic-retrieval-v2/", import.meta.url);
const files = (await readdir(qrelsDirectory)).filter((name) => name.endsWith(".json"));
const parts = await Promise.all(files.map(async (name) =>
  JSON.parse(await readFile(new URL(name, qrelsDirectory), "utf8")) as {
    repository: Repository;
    tasks: Omit<Task, "repository" | "split">[];
  },
));
const repositories = Object.fromEntries(parts.map((part) => [part.repository.id, part.repository]));
const tasks = parts.flatMap((part) => part.tasks.map((task) => ({
  ...task,
  repository: part.repository.id,
  split: part.repository.split,
})));
const stateDirectory = process.env.HOMEGREP_HOME;
const repetitions = Number(process.env.HOMEGREP_REPETITIONS ?? 3);
if (!stateDirectory) throw new Error("Set HOMEGREP_HOME to the existing evaluation index directory");
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("HOMEGREP_REPETITIONS must be positive");

const services = new Map<string, Awaited<ReturnType<typeof createSembleGrep>>>();
const chunksByRepository = new Map<string, Map<string, IndexRange[]>>();
const outputTasks = [];
try {
  for (const repository of Object.values(repositories)) {
    const root = resolve(repository.path);
    const indexDirectory = resolve(stateDirectory, "indexes", createHash("sha256").update(root).digest("hex"));
    const pointer = await Bun.file(resolve(indexDirectory, "current.json")).json() as { generation: string };
    const chunks = await Bun.file(resolve(indexDirectory, "generations", pointer.generation, "semble", "chunks.json")).json() as IndexChunk[];
    const targetPaths = new Set(tasks.filter((task) => task.repository === repository.id).flatMap((task) => [
      ...task.relevant.map((judgment) => judgment.path),
      ...task.relevantFiles.map((judgment) => judgment.path),
    ]));
    const rangesByPath = new Map<string, IndexRange[]>();
    for (const chunk of chunks) {
      if (!targetPaths.has(chunk.file_path)) continue;
      const ranges = rangesByPath.get(chunk.file_path) ?? [];
      ranges.push({ startLine: chunk.start_line, endLine: chunk.end_line });
      rangesByPath.set(chunk.file_path, ranges);
    }
    chunksByRepository.set(repository.id, rangesByPath);

    const service = await createSembleGrep({ root });
    const info = await service.info({ root, includeStatus: false });
    if (!info.indexed) throw new Error(`${repository.id} has no existing index; refusing to build or alter one`);
    services.set(repository.id, service);
  }

  for (const task of tasks) {
    const repository = repositories[task.repository]!;
    const service = services.get(task.repository)!;
    const rangesByPath = chunksByRepository.get(task.repository)!;
    const candidateRuns: Candidate[][] = [];
    for (let iteration = 0; iteration < repetitions; iteration += 1) {
      const result = await service.context({ root: repository.path, query: task.query, limit: 100, autoUpdate: false });
      candidateRuns.push(result.items.flatMap((item) => item.range.kind === "text" ? [{
        path: item.file.relativePath,
        startLine: item.range.startLine,
        endLine: item.range.endLine,
        rank: item.rank,
      }] : []));
    }

    const symbols = task.relevant.filter((judgment) => judgment.symbol);
    const symbolOutcomes = symbols.map((judgment) => {
      const hitRuns = candidateRuns.flatMap((candidates, iteration) => candidates.some((candidate) => candidateMatches(candidate, judgment)) ? [iteration + 1] : []);
      return { judgment, hitRuns };
    });
    const symbolFailures = symbolOutcomes.flatMap(({ judgment, hitRuns }) => {
      if (hitRuns.length === repetitions) return [];
      const indexedRanges = rangesByPath.get(judgment.path) ?? [];
      const spanIndexed = indexedRanges.some((chunk) => overlaps(chunk, judgment));
      const fileRanks = candidateRuns.map((candidates) => candidates.find((candidate) => candidate.path === judgment.path)?.rank ?? null);
      const spanRanks = candidateRuns.map((candidates) => candidates.find((candidate) => candidateMatches(candidate, judgment))?.rank ?? null);
      const cause = hitRuns.length
        ? "intermittent_candidate_membership"
        : !indexedRanges.length
          ? "target_file_not_indexed"
          : !spanIndexed
            ? "target_span_not_covered_by_index_chunks"
            : fileRanks.every((rank) => rank === null)
              ? "target_file_not_retrieved_in_top100"
              : "target_file_retrieved_but_relevant_chunk_not_in_top100";
      return [{
        taskId: task.id,
        repository: task.repository,
        split: task.split,
        category: task.category,
        query: task.query,
        symbol: judgment.symbol,
        path: judgment.path,
        startLine: judgment.startLine,
        endLine: judgment.endLine,
        cause,
        indexContainsTargetFile: indexedRanges.length > 0,
        indexContainsOverlappingChunk: spanIndexed,
        retrievalRunsWithTargetFile: fileRanks.filter((rank) => rank !== null).length,
        retrievalRunsWithTargetChunk: hitRuns.length,
        firstTargetFileRank: fileRanks.find((rank) => rank !== null) ?? null,
        firstTargetChunkRank: spanRanks.find((rank) => rank !== null) ?? null,
      }];
    });

    const fileFailures = task.relevantFiles.flatMap((judgment) => {
      const hits = candidateRuns.flatMap((candidates, iteration) => candidates.some((candidate) => candidate.path === judgment.path) ? [iteration + 1] : []);
      if (hits.length === repetitions) return [];
      return [{
        taskId: task.id,
        repository: task.repository,
        path: judgment.path,
        cause: (rangesByPath.get(judgment.path)?.length ?? 0) ? "indexed_file_outside_top100" : "target_file_not_indexed",
        retrievalRunsWithFile: hits.length,
      }];
    });

    outputTasks.push({
      taskId: task.id,
      repository: task.repository,
      split: task.split,
      category: task.category,
      query: task.query,
      symbolJudgmentCount: symbols.length,
      symbolHitJudgmentCount: symbolOutcomes.filter((outcome) => outcome.hitRuns.length === repetitions).length,
      symbolHitsByRun: candidateRuns.map((candidates) => symbolOutcomes.filter((outcome) =>
        candidates.some((candidate) => candidateMatches(candidate, outcome.judgment)),
      ).length),
      symbolHitAtLeastOnceCount: symbolOutcomes.filter((outcome) => outcome.hitRuns.length > 0).length,
      symbolFailures,
      relevantFileJudgmentCount: task.relevantFiles.length,
      fileHitJudgmentCount: task.relevantFiles.length - fileFailures.length,
      fileFailures,
    });
  }
} finally {
  await Promise.all([...services.values()].map((service) => service.close()));
}

const symbolFailures = outputTasks.flatMap((task) => task.symbolFailures);
const fileFailures = outputTasks.flatMap((task) => task.fileFailures);
const symbolJudgmentCount = tasks.reduce((count, task) => count + task.relevant.filter((judgment) => judgment.symbol).length, 0);
const symbolHitsByRun = Array.from({ length: repetitions }, (_, run) => outputTasks.reduce((count, task) => count + task.symbolHitsByRun[run], 0));
const byCause = (failures: Array<{ cause: string }>) => Object.fromEntries(
  [...new Set(failures.map((failure) => failure.cause))].map((cause) => [cause, failures.filter((failure) => failure.cause === cause).length]),
);
const report = {
  schemaVersion: 1,
  dataset: "agentic-retrieval-v2",
  engine: "Semble default ranking, unchanged",
  engineRevision: "8ee6463efbb1ff755c339e965c7298b7afd7db5b",
  measuredAt: new Date().toISOString(),
  independentQueries: tasks.length,
  repetitionsPerQuery: repetitions,
  answerableQueries: tasks.filter((task) => task.answerable !== false).length,
  symbolJudgments: symbolJudgmentCount,
  symbolHitsByRun,
  symbolJudgmentMissesAcrossAllRuns: symbolJudgmentCount * repetitions - symbolHitsByRun.reduce((sum, hits) => sum + hits, 0),
  symbolRecallAt100ByRun: symbolHitsByRun.map((hits) => hits / symbolJudgmentCount),
  meanSymbolRecallAt100: symbolHitsByRun.reduce((sum, hits) => sum + hits / symbolJudgmentCount, 0) / repetitions,
  symbolsHitInEveryRun: outputTasks.reduce((count, task) => count + task.symbolHitJudgmentCount, 0),
  stableSymbolRecallAt100: outputTasks.reduce((count, task) => count + task.symbolHitJudgmentCount, 0) / symbolJudgmentCount,
  symbolsHitAtLeastOnce: outputTasks.reduce((count, task) => count + task.symbolHitAtLeastOnceCount, 0),
  symbolRecallAt100AtLeastOnce: outputTasks.reduce((count, task) => count + task.symbolHitAtLeastOnceCount, 0) / symbolJudgmentCount,
  symbolJudgmentTargetsNotHitEveryRun: symbolFailures.length,
  symbolFailureCauses: byCause(symbolFailures),
  fileJudgmentCount: tasks.reduce((count, task) => count + task.relevantFiles.length, 0),
  fileFailureCount: fileFailures.length,
  fileRecallAt100ThisRun: 1 - fileFailures.length / tasks.reduce((count, task) => count + task.relevantFiles.length, 0),
  fileFailureCauses: byCause(fileFailures),
  causeDefinitions: {
    target_file_not_indexed: "No Semble index chunks exist for the qrel target file; discovery, file type, ignore, size, or parse/write eligibility must be inspected separately.",
    target_span_not_covered_by_index_chunks: "The target file is indexed, but no stored chunk range overlaps the qrel symbol span.",
    target_file_not_retrieved_in_top100: "The target span is indexed, but no result from its file appears in any sampled top-100 pool.",
    target_file_retrieved_but_relevant_chunk_not_in_top100: "The target span is indexed and its file appears in top 100, but the relevant chunk does not.",
    intermittent_candidate_membership: "The relevant chunk appears in some but not all repeated top-100 results.",
  },
  perQuery: outputTasks,
};
const serialized = JSON.stringify(report, null, 2);
if (process.env.HOMEGREP_EVAL_OUTPUT) await Bun.write(process.env.HOMEGREP_EVAL_OUTPUT, `${serialized}\n`);
console.log(JSON.stringify({
  queries: report.independentQueries,
  symbolJudgments: report.symbolJudgments,
  symbolHitsByRun: report.symbolHitsByRun,
  meanSymbolRecallAt100: report.meanSymbolRecallAt100,
  stableSymbolRecallAt100: report.stableSymbolRecallAt100,
  symbolJudgmentTargetsNotHitEveryRun: report.symbolJudgmentTargetsNotHitEveryRun,
  symbolFailureCauses: report.symbolFailureCauses,
  fileJudgmentCount: report.fileJudgmentCount,
  fileFailureCount: report.fileFailureCount,
  fileFailureCauses: report.fileFailureCauses,
}, null, 2));

function overlaps(item: Pick<Candidate | IndexRange, "startLine" | "endLine">, judgment: Judgment) {
  return item.startLine <= judgment.endLine && item.endLine >= judgment.startLine;
}

function candidateMatches(candidate: Candidate, judgment: Judgment) {
  return candidate.path === judgment.path && overlaps(candidate, judgment);
}
