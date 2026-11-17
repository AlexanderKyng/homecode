# HomeGrep retrieval experiments

## Scope and decision

This report covers HomeGrep's local code search engine only. No relevance or
retrieval behavior was promoted into HomeCode's production defaults. The pinned
Semble hybrid route remains the fallback and reference. The only engine API
addition is an optional `hybridAlpha` override, used to run controlled hybrid
weight ablations; the default is unchanged.

The current result is **EXPERIMENT**, not a claim that HomeGrep outperforms
Semble. A small, manually judged two-repository pilot makes it possible to
reject some variants, but is too small to prove general improvements or coding
agent task-resolution gains.

## Reproduction and data

The versioned query set is
[`agentic-retrieval-v1/tasks.json`](../packages/homegrep/benchmarks/agentic-retrieval-v1/tasks.json).
It contains 17 tasks: eight answerable HomeCode development tasks, eight
answerable mini-swe-agent held-out-repository tasks, and one unanswerable
Git-history task. Judgments are manual path and line spans, written from source
inspection before running the variants. Categories cover symbols, behavior,
architecture, cross-file flows, and error handling. This is a pilot: it does
not comprehensively sample bugs, historical Git retrieval, or multi-step
agent tasks. The one Git-history item is intentionally unanswerable by the
working-tree index.

Run from `packages/homegrep`, starting with a fresh state directory:

```bash
HOMEGREP_HOME=/tmp/homegrep-eval-run-001 \
HOMEGREP_EVAL_OUTPUT=/tmp/homegrep-eval-run-001.json \
HOMEGREP_EVAL_VARIANTS=hybrid,hybrid-alpha-025,hybrid-alpha-075 \
/usr/bin/time -v bun run evaluate:retrieval --split=development
```

The runner performs three warmups and 30 timed repetitions per task and
variant. It indexes clean snapshots, reports Recall/Precision for paths and
line spans at 1/5/10, MRR, nDCG@10, task-bootstrap 95% intervals, latency,
index time and bytes. The outer GNU `time` measurement includes the Python
runtime. It does not execute a coding agent: agent resolution rate and token
budget are **not measured**. CPU is an AMD Ryzen 9 7900 (12 cores / 24 threads);
the runs used Bun 1.3.14, Node compatibility 24.3.0, uv 0.13.5 and the pinned
Semble Python environment. Variants share the same model, host, repository
snapshot and qrels. Bootstrap intervals have only eight independent tasks per
split and should be read as uncertainty indicators, not precise population
estimates.

The Semble hybrid baseline revision was `8ee6463efbb1ff755c339e965c7298b7afd7db5b`;
the embedding model was `minishlab/potion-code-16M-v2` at
`e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b`. HomeCode was clean at
`5fa237ebdd1c23ce6d76541a37a5c583c85c07f6`; mini-swe-agent was clean at
`58ad92fc1385be3f8f2326b7a42320bb3655e169`.

## Observed baseline

An earlier fixed-query baseline recorded HomeCode at 2,347 files and 25,502
entities, 5.11 s indexing, and hybrid search p50 around 153–159 ms. A fresh
isolated run on the ported `a7a86d4` integration measured 5.176 s indexing
internally (6.16 s wall), 2,347 files, 25,502 entities, 56,613,786 bytes in
the active generation, 10.32 s user CPU, and 444,608 KiB peak RSS. Across its
three fixed queries, p50 was 160.8–166.5 ms and p95 168.4–173.2 ms. These fixed
queries have no qrels, so they are latency measurements only.

On the current evaluation snapshot, a clean HomeCode index took 6.060 s
internally, contained 25,503 entities and occupied 56,616,876 bytes. A clean
mini-swe-agent index took 1.263 s, contained 1,243 entities and occupied
2,828,355 bytes. The latter difference from the original baseline reflects
the newer source snapshot and should not be interpreted as a speedup.

## Results

All values below are from 30 repetitions per query and three warmups. Quality
metrics are over eight answerable tasks in each split. Latencies are p50/p95
milliseconds. Paired intervals compare task-level nDCG@10 differences against
the hybrid baseline.

| Split / variant | nDCG@10 (task-bootstrap 95% CI) | MRR | Path Recall@5 / @10 | Line Recall@5 / @10 | Query p50 / p95 ms |
|---|---:|---:|---:|---:|---:|
| HomeCode hybrid | 0.2058 (0.0546–0.3695) | 0.1354 | 0.250 / 0.500 | 0.250 / 0.438 | 179.35 / 193.18 |
| HomeCode alpha=0.25 | 0.2126 (0.0625–0.3763) | 0.1458 | 0.375 / 0.500 | 0.313 / 0.438 | 178.79 / 216.65 |
| HomeCode alpha=0.75 | 0.1290 (0.0328–0.2580) | 0.0804 | 0.188 / 0.250 | 0.188 / 0.250 | 178.08 / 221.44 |
| HomeCode token rerank | 0.4120 (0.1397–0.7213) | 0.4179 | 0.375 / 0.500 | 0.375 / 0.438 | 235.32 / 259.54 |
| Held-out hybrid | 0.5734 (0.3402–0.7907) | 0.5491 | 0.750 / 0.875 | 0.563 / 0.688 | 15.83 / 17.83 |
| Held-out alpha=0.25 | 0.5317 (0.2659–0.7790) | 0.5313 | 0.750 / 0.750 | 0.563 / 0.563 | 15.91 / 19.76 |
| Held-out token rerank | 0.2491 (0.0484–0.4982) | 0.1817 | 0.250 / 0.500 | 0.250 / 0.438 | 35.59 / 41.10 |

On HomeCode, alpha=0.25's paired nDCG gain was +0.0068 (95% CI 0.0000 to
0.0182); on the held-out repository it was -0.0417 (-0.1250 to 0). The weight
change therefore has no stable cross-repository gain. Alpha=0.75 reduced
HomeCode nDCG by 0.0767 (-0.1393 to -0.0190).

The evaluation-only token/path/name reranker was run on the hybrid candidate
pool (100 candidates). Its HomeCode nDCG gain was +0.2063 (-0.0053 to +0.4982),
but it regressed by -0.3243 (-0.5536 to -0.1351) on the held-out repository.
It also increased p50/p95 from 179/191 ms to 235/260 ms on HomeCode and from
15.8/17.8 ms to 35.6/41.1 ms on mini-swe-agent. This is a failed
cross-repository generalization result; do not promote or describe it as an
improvement. One earlier run accidentally selected a vector-only candidate
pool for this variant; that run was discarded and is not included here.

The fresh HomeCode evaluation processes peaked at 445,216 KiB RSS and used
121.28 s user plus 15.91 s system CPU in the token-rerank run. The held-out
three-variant run peaked at 190,108 KiB and used 18.70 s user plus 2.70 s
system CPU. These are whole-command measurements including Python and should
not be compared as if the repositories or number of variants were identical.
Index bytes above refer to the active generation, not all retained generations
in an application state directory.

## Research and approach decisions

The evaluations below guide experiments; published results are not treated as
HomeGrep measurements.

| Approach | Evidence and cost | Decision |
|---|---|---|
| Keep Semble hybrid as baseline | Stable current behavior; baseline for all paired local comparisons. | **GO** as the unchanged production fallback. |
| Hybrid-weight tuning | Alpha=0.25 was near-neutral on development and lower on held-out; alpha=0.75 significantly lower on development. | **NO-GO** for changing the default. Keep the explicit override for future controlled ablations. |
| Deterministic token/path reranking | Development gain did not transfer; held-out nDCG fell 0.324 and p50 more than doubled. | **NO-GO** for promotion. Any future reranker needs broader frozen qrels and validation of candidate coverage. |
| Potion-Code-16M-v2 | Current compact CPU embedding baseline; local retrieval is measured above, but no comparison with another code embedding has been run. | **EXPERIMENT**: compare a specialized retriever on identical qrels and include CPU/RAM/index cost. No fine-tuning yet. |
| CodeRankEmbed 137M / small code retrievers | CORE-Bench reports materially different results by task type; its issue-to-edit and context retrieval results are far below snippet retrieval. This supports evaluating repository tasks directly, not model selection by a single score. [CORE-Bench](https://arxiv.org/abs/2606.11864) | **EXPERIMENT** only after the qrels are broadened; no CPU comparison or local integration performed. |
| Late interaction / ColBERT (ColGREP) | The ColGREP paper reports CPU trajectory-time and token reductions for trained localization agents. That is an agent-plus-tool result, not a direct HomeGrep query-latency result. [Small Agents with Semantic Search](https://arxiv.org/abs/2610.05099), [implementation](https://github.com/lightonai/next-plaid/tree/main/colgrep) | **EXPERIMENT** as a separately measured backend only if the current hybrid baseline shows a task-specific recall gap; assess index size and CPU query cost. |
| File-centered structure (RepoNav) | RepoNav reports Function Acc@5 0.557 versus 0.484 for flat snippets on LocBench, with a lightweight post-retrieval scaffold; its full agent uses more tokens/time. [RepoNav](https://arxiv.org/abs/2609.08355), [implementation](https://github.com/CCChz233/reponav) | **EXPERIMENT** in an agent harness with token and task-resolution measurements. Not implemented; current qrels do not establish an agent benefit. |
| Tree-sitter symbols and call/import graphs | Relevant for file-to-symbol navigation and inter-file context, but static parsing alone does not establish better retrieval. Existing Tree-sitter dependencies are not a measured structured-ranking implementation. | **EXPERIMENT** as a small extraction/ranking ablation against the same candidates before building a persistent graph. |
| GraphRAG / dynamic multi-hop LLM retrieval | Published approaches often assume a known target, offline summaries, graph preparation, or multiple LLM calls; these costs and task assumptions do not match general local search. [FeatLens](https://arxiv.org/abs/2609.26480), [DyRetriever](https://arxiv.org/abs/2608.01927) | **NO-GO** for adding a graph store or an LLM planner to the current independent search engine. Revisit a bounded graph experiment only with a measured cross-file gap. |
| CPU fine-tuning of a small retriever | Eight development queries and eight held-out queries are not a credible training/validation/test corpus. | **NO-GO for now**. First expand annotations, split by repository and time, then test whether a measurable retrieval weakness remains. |
| Commit-history search | The current index searches the working tree and cannot answer the unanswerable history query. Historical retrieval is a separate corpus and relevance task. | **EXPERIMENT** as a separately indexed, opt-in Git search mode after building temporal qrels; do not imply current HomeGrep covers history. |

## Limits and next measurements

The pilot includes only two repositories, 16 answerable tasks, and manually
chosen targets. It cannot establish statistical generalization across
languages, repository sizes, issue types, or agent backbones. There is no
agent execution harness, task-resolution rate, context-token budget, or
confidence interval over agent trajectories. Incremental indexing
correctness and corruption behavior remain covered by functional tests, not
by this quality evaluation. RAM/CPU figures are for each full evaluation
process; they do not isolate idle daemon footprint or per-query CPU.

The next quality gate is to expand frozen, manually reviewed qrels across more
repositories and languages, including issue-to-edit, architectural context,
and multi-hop call flows. Keep test repositories and historical periods out of
variant selection. Run agent tasks only after defining fixed model, prompt,
tool budget, and success adjudication. Add incremental-index duration and
resource measurements to the evaluation runner before making storage or graph
changes. Any future candidate that fails held-out nDCG/recall or latency gates
stays behind an opt-in experiment and leaves the Semble hybrid fallback intact.
