# Semble Recall@100 failure analysis

Measured 2026-11-17 on the existing v2 Semble indexes. This analysis makes three read-only `context(limit: 100, autoUpdate: false)` calls per query. It reuses the default Semble ranking and existing index generations; it does not rebuild an index, rerank results, or change production ranking.

## Summary

| Symbol-level result | Count |
| --- | ---: |
| Relevant symbol judgments | 179 |
| Judgments hit in all three runs | 135 |
| Judgments missed in all three runs | 44 |
| Pooled Recall@100 | 0.7542 (135/179) |
| Macro average across 143 symbol-judged queries | 0.7791 |
| Queries with all symbol judgments hit | 107/143 |
| Queries with at least one miss | 36/143 |
| Queries with no relevant symbol in top 100 | 27/143 |

The archived benchmark reports macro Recall@100 per query, so its 0.7791 agrees with this analysis. The pooled 0.7542 weights each of the 179 symbol judgments equally. Both values are correct for their stated denominator. Hit membership was identical in all three runs.

## Misses by cause

| Cause | Missed symbol judgments | Share of misses | Evidence |
| --- | ---: | ---: | --- |
| Relevant file is in top 100, but the qrel-overlapping chunk is absent | 42 | 95.5% | Target file appears in all three runs; its indexed chunks cover the qrel span, but none of those overlapping chunks is returned in top 100. |
| Relevant file is absent from top 100 | 2 | 4.5% | The file and an overlapping target chunk exist in the index, but no chunk from that file appears in any run. |
| Target file absent from index | 0 | 0% | All 44 missed qrel files have indexed chunks. |
| Target span uncovered by indexed chunks | 0 | 0% | All 44 missed spans overlap at least one persisted Semble chunk. |
| Intermittent hit across three runs | 0 | 0% | Each judgment was either retrieved on all three runs or missed on all three. |

The dominant failure is therefore **within-file chunk retrieval**. In 31 of the 42 cases, the first result from the correct file is already in the top 10; the median first-file rank is 2. For example, `common/chat.cpp` is ranked first for the tool-schema query, but the chunk covering `common_chat_tools_parse_oaicompat` at lines 441–474 is not returned. This is consistent with a chunk-level candidate/ranking failure. These measurements do not separate BM25 from dense contribution and do not establish whether chunk competition, query wording, or score calibration is the underlying mechanism.

### Repository distribution

| Repository | Symbol judgments | Misses | Pooled Recall@100 |
| --- | ---: | ---: | ---: |
| HomeEngine.cpp (held out) | 34 | 19 | 0.441 |
| BigCode Evaluation Harness | 33 | 6 | 0.818 |
| HomeCode | 35 | 12 | 0.657 |
| mini-swe-agent (held out) | 47 | 6 | 0.872 |
| HomeTrain | 30 | 1 | 0.967 |

Across the two held-out repositories, 25 of 81 symbol judgments are missed (Recall@100 0.691); development repositories miss 19 of 98 (0.806). This is a repository-level difference in this small set, not evidence that the model generalizes poorly on all codebases.

The two whole-file misses are `packages/homegrep/src/engine/service/semble-grep.ts` for the HomeCode exact-structural-search query and `src/minisweagent/utils/serialize.py` for the mini-swe-agent configuration-overlay query. Both files and their qrel spans are present in the index, so these are candidate-ranking misses rather than scan or parser omissions.

For file-level judgments, 156 of 158 relevant files appear in the top 100 (Recall@100 0.987). Both file misses are indexed files outside the candidate pool.

## Interpretation and limits

- The indexed corpus covers every missed target file and every missed symbol span. The dominant loss occurs after indexing, when Semble selects its top 100 chunks.
- The 42 same-file misses show that file Recall@100 alone hides chunk-level failures: the path can rank highly while the useful section never reaches the agent.
- The 27 queries with zero judged symbols in the top 100 are likely to be especially costly for downstream work, but no agent task-resolution study was run here.
- Qrels were validated against Tree-sitter symbol spans and source lines, but they are manually authored and have no inter-annotator agreement measurement. The analysis cannot rule out an annotation or query-intent issue.
- The two whole-file misses need per-channel candidate traces to distinguish lexical/BM25 from dense retrieval failure. That evidence is not retained in the current Semble response.

The full per-query and per-symbol classifications are in [`results/2026-11-17-recall100-failures.json`](./results/2026-11-17-recall100-failures.json). Run from `packages/homegrep` with the existing benchmark state directory:

```sh
HOMEGREP_HOME=/path/to/existing/homegrep-eval-state \
HOMEGREP_EVAL_OUTPUT=/tmp/homegrep-recall100-failures.json \
HOMEGREP_REPETITIONS=3 \
bun run script/analyze-recall100-failures.ts
```

The diagnostic refuses to build a missing index and passes `autoUpdate: false` for all queries.
