# HomeGrep retrieval evaluation v2

This dataset evaluates retrieval relevance on pinned repository snapshots. Semble remains the retrieval reference; experiments in the evaluator rerank the same candidate pool and do not alter the production engine.

See [RESULTS.md](./RESULTS.md) for the measured Tree-sitter and MiniLM comparisons, confidence intervals, runtime costs, and current decisions. Per-task JSON reports are in [`results/`](./results/).

See [RECALL100-FAILURES.md](./RECALL100-FAILURES.md) for a cause-by-cause analysis of missed top-100 symbol and file judgments using the unchanged Semble ranking.

## Dataset

The dataset contains 150 manually authored tasks: 30 each for HomeCode, HomeTrain, HomeEngine.cpp, BigCode Evaluation Harness, and mini-swe-agent. It has 158 graded file judgments and 179 Tree-sitter-extractable symbol judgments. Six answerable tasks have file-level qrels only because their target is a module-level object/schema/callback that the current index extractor does not emit as a searchable symbol. Each such task records the extractor limitation in `symbolJudgmentsUnavailable`; these tasks remain in file metrics and are excluded from symbol-only metrics.

Repository roots in the JSON files are relative to `packages/homegrep`. By default, external checkouts are expected under `repositories/` beside the HomeCode checkout. Set `HOMEGREP_EVAL_REPOS` to a JSON object mapping repository IDs to checkout paths when using a different layout; paths are resolved from the current working directory.

Three repositories are development data (HomeCode, HomeTrain, BigCode Evaluation Harness); two are held-out repositories (HomeEngine.cpp and mini-swe-agent). Each JSON pins a full Git commit and records its split. Evaluation refuses changed source snapshots and dirty external repositories. The HomeCode checkout may contain only the evaluation script, this dataset, documentation, and its package ignore-rule changes.

Queries cover symbol and API lookup, behavior, configuration, cross-file flows, indexing, search, tool integration, and repository architecture. Grades are 1–3. File judgments identify relevant files; symbol judgments carry a path, symbol name/type, and inclusive line span. Before an evaluation run, the harness validates paths, spans, symbol names, Tree-sitter extraction overlap, repository revisions, and task counts.

The annotations are a first independent-query set, not an exhaustive relevance collection. Recall is therefore recall against known qrels. There is no agent task-resolution measurement in this retrieval-only benchmark.

## Running

From `packages/homegrep`:

```sh
bun run evaluate:retrieval --validate-only
```

For a measured run, use a fresh state directory so indexes and runtime state are isolated:

```sh
HOMEGREP_HOME=.homegrep-eval-v2 \
HOMEGREP_EVAL_OUTPUT=.homegrep-eval-v2-report.json \
bun run evaluate:retrieval
```

The default run uses 3 warmups and 30 timed repetitions for each query/variant. Repetitions improve latency estimates; independent tasks and repositories are the units that support retrieval generalization claims. The report includes per-task p50/p95 latency, corpus-level p50/p95, index duration/size, process CPU/RSS, file/line/symbol retrieval metrics, and deterministic hierarchical repository-then-task bootstrap intervals. `tree-rerank` reports Tree-sitter metadata preparation separately from timed reranking. `HOMEGREP_EVAL_VARIANTS` can restrict variants for targeted runs, but must include `hybrid`; `HOMEGREP_EVAL_REPETITIONS` and `HOMEGREP_EVAL_WARMUPS` control timing samples.

Run `/usr/bin/time -v` around the command to include the Python child process in peak RSS and CPU observations. The built-in process resource counters cover only the Bun/Node process.

## Interpretation

The primary ranking comparison uses symbol nDCG@10 on tasks with symbol qrels and reports a paired, repository-then-task bootstrap interval. File ranking metrics use all answerable tasks; line metrics use tasks with line spans. Do not interpret latency repetitions as additional relevance samples. Do not treat the development set as held-out evidence, and do not claim an agent-resolution improvement from retrieval metrics alone.
