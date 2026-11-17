# HomeGrep

HomeGrep is split into three layers so the standalone engine can be built and
used without HomeCode:

1. **Engine** — `packages/homegrep/src/engine` owns file scanning, extraction,
   embedding selection, exact ripgrep search, hybrid Semble search, index
   generations, validation, locking, and atomic publication. `src/daemon`,
   `src/client`, `src/authorization`, `src/mcp`, and `src/cli` provide the
   local service lifecycle and user-facing protocols.
2. **HomeCode integration** — `packages/homecode/src/tool/grep.ts` exposes
   hybrid and exact search to agents. `packages/homecode/src/homegrep` manages
   workspace-scoped service reuse and cleanup; the `homecode homegrep index`
   command offers explicit indexing. Set `homegrep.enabled` to `false` in
   HomeCode config to disable hybrid search; exact search remains available.
3. **Packaging** — the HomeGrep package builds to `dist/` and publishes `hg`
   (plus the `zg` compatibility alias). HomeCode's compiled CLI bundles the
   Python project at `bin/homegrep/python`. The first Python invocation uses
   the checked-in `uv.lock`; `uv` must be available on `PATH`.

## Semble provenance and license

The Python bridge consumes Semble as an external dependency. It does not vendor
or modify Semble source. `python/pyproject.toml` pins revision
`8ee6463efbb1ff755c339e965c7298b7afd7db5b`, and `python/uv.lock` resolves
Semble 0.7.0 at that same commit. The pinned upstream [project metadata](https://github.com/MinishLab/semble/blob/8ee6463efbb1ff755c339e965c7298b7afd7db5b/pyproject.toml)
declares MIT; the corresponding [license text](https://github.com/MinishLab/semble/blob/8ee6463efbb1ff755c339e965c7298b7afd7db5b/LICENSE)
is copyright Thomas van Dongen, 2026. Redistributed copies of Semble or
substantial portions must retain its copyright and permission notice. The
HomeGrep package itself is Apache-2.0; Semble's license does not cover its
transitive dependencies or the separately downloaded Potion model.

The bridge calls Semble's `ContentType`, `SembleIndex`, index creation and
incremental indexing, model loading, file walking and file-type helpers,
manifest types, chunk IDs, persistence, and hybrid search APIs. It also reads
Semble's internal vector, BM25, manifest, and file-mapping structures for
generation validation. HomeGrep supplies the JSON-lines process protocol,
content hashing and unchanged-file reuse, validation and freshness checks,
write locking, and staging plus atomic generation publication. Semble's own
CLI, MCP server, and installer are not used.

## Build and run

From `packages/homegrep`:

```bash
bun run build
bun run typecheck
bun run test
uv sync --locked --project python
node dist/cli/index.js --help
node dist/cli/index.js --version
```

Use `hg --index <workspace>` for the first index, `hg --status` to inspect it,
`hg <query>` for hybrid retrieval, `hg --rg -F <literal>` for exact search, and
`hg --server --stdio` for the MCP stdio bridge. The daemon listens on loopback;
its HTTP MCP transport requires its configured bearer token and validates the
request origin. Python and model artifacts are kept outside the source tree.

## Reproducible baseline

The baseline is a measurement record, not a quality claim. Record the HomeCode
commit, HomeGrep package revision, Semble revision, model revision, Python/Node/uv
versions, hardware, workspace commit and file count, cache state, and exact
commands. Measure a clean initial index and a separate one-file incremental
update. Report query latency p50/p95 from at least 30 repetitions per query,
index duration, peak RSS, CPU time, and index disk usage. Report Recall@K,
MRR, and nDCG@K only when a versioned query/qrels set exists; otherwise mark
them **not measured**. Do not combine functional test results with relevance
evaluation results.

The first real-repository baseline was measured on 2026-11-17. The measurement
record, environment and commands are included in the implementation report;
re-run `bun run baseline <workspace>` and the timed `hg --index <workspace>`
command above to refresh it. This section and any refreshed record contain
observed values only; relevance metrics remain unavailable until qrels exist.

## Annotated retrieval pilot

`packages/homegrep/benchmarks/agentic-retrieval-v1/tasks.json` contains manual
path-and-line judgments for HomeCode and mini-swe-agent. HomeCode is the
development split; mini-swe-agent is a held-out repository. The tasks cover
behavior, symbols, architecture, multi-file flows, error handling, and one
unanswerable Git-history question. The judgments were written from source
inspection before running the retrieval variants. They are a small local pilot,
not a public benchmark or a training corpus.

The runner compares the unchanged Semble hybrid route, BM25-only and
vector-only routes, two explicit hybrid weights, and an evaluation-only local
reranker over identical repository snapshots. It reports path and line
Recall@1/5/10 and precision, MRR, nDCG@10, paired bootstrap intervals, latency,
index size, indexing time, and process resources. It does not run a coding
agent, so task-resolution rate and token use are not measured. Evaluation files
are git-ignored by the source walker to prevent query or answer leakage into the
indexed corpus; Git still tracks the versioned pilot files.

Run from `packages/homegrep` with a new state directory for each clean run:

```bash
HOMEGREP_HOME=/tmp/homegrep-eval-run-001 \
HOMEGREP_EVAL_OUTPUT=/tmp/homegrep-eval-run-001.json \
HOMEGREP_EVAL_VARIANTS=hybrid,hybrid-alpha-025,hybrid-alpha-075 \
/usr/bin/time -v bun run evaluate:retrieval --split=development
```

Use `--split=development` to inspect the HomeCode development split before
freezing a variant. Run `--split=held_out_repository` only after that choice is
fixed. Do not repeatedly tune against the held-out repository and report it as
an independent test. The pilot is too small to justify fine-tuning a retrieval
model.
