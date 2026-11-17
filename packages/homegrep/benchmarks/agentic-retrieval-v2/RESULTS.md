# HomeGrep retrieval evaluation results

Evaluations recorded on 2026-11-17. Semble remains the unchanged reference. These are retrieval experiments only; none changes production ranking or claims an agent task-resolution gain.

## Dataset and comparison protocol

The v2 qrels contain 150 queries across five pinned repositories (30 each), 149 answerable queries, 143 with symbol judgments, 158 file judgments, and 179 symbol judgments. HomeCode, HomeTrain, and BigCode Evaluation Harness are development repositories; HomeEngine.cpp and mini-swe-agent are held out by repository. Six answerable queries have file-only judgments because the current extractor does not expose their module-level targets. The annotation README documents the task classes and validation.

The runs use the same 150 queries, Semble candidate generator, and qrels. The four external repositories were at their pinned commits. HomeCode's task corpus is pinned to `d3f301fd1ef69a839945d93532bfe61b8499bb9d`; the benchmark ran at `1210444e2f527f2ee1440e7f262392acdbad861b`, which adds only evaluation data and scripts excluded from the index. Each query has 3 warmups and 30 measured retrieval samples. Quality is averaged within each query across those paired samples; the independent relevance sample remains 143 symbol-judged queries, not 4,500 repetitions. Confidence intervals resample repositories and then queries. The held-out split contains 60 queries, of which all 60 have symbol judgments.

The dense experiment reranks Semble's top 100 results. It cannot recover a symbol absent from this pool: mean symbol Recall@100 is 0.779. `all-MiniLM-L6-v2` is a generic sentence embedding model, not a code-specialized model. It has 22.7M parameters, 384-dimensional output, and an Apache-2.0 license according to its [model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2). This run uses mean pooling, normalized vectors, CPU ONNX Runtime, four intra-op threads, and a 128-token input cap.

## MiniLM dense reranking against Semble

Metrics below are averaged over answerable tasks, except symbol metrics, which use symbol-judged tasks. Deltas are MiniLM minus Semble. The intervals are paired, repository-then-query bootstrap intervals with 2,000 replicates.

| Metric | Semble | MiniLM rerank | Paired delta (95% CI) |
| --- | ---: | ---: | ---: |
| Symbol nDCG@10 | 0.3983 | 0.3976 | -0.001 [-0.069, 0.072] |
| Symbol MRR | 0.3694 | 0.3476 | -0.022 [-0.103, 0.070] |
| Symbol Recall@10 | 0.5210 | 0.6101 | +0.089 [-0.029, 0.197] |
| Path Recall@10 | 0.8926 | 0.7819 | -0.111 [-0.207, -0.020] |
| Path precision@10 | 0.0938 | 0.1088 | +0.015 [0.000, 0.028] |
| Line precision@10 | 0.0564 | 0.0839 | +0.028 [0.011, 0.045] |
| File nDCG@10 | 0.6496 | 0.5427 | -0.107 [-0.195, -0.011] |

The reranker raises symbol Recall@10 and the two precision measures, but does not improve symbol nDCG or MRR and loses file-level nDCG and path recall. The symbol nDCG interval includes both useful gains and regressions. It is not a reliable overall improvement, and the file-level losses are statistically distinguishable from zero in this evaluation.

Held-out repositories show symbol nDCG 0.3143 for Semble and 0.3212 for MiniLM, while file nDCG is 0.6496 and 0.4794 respectively. These two repositories are a small held-out sample, so this is not enough evidence to promote the reranker.

| Repository | Symbol qrel tasks | Semble symbol nDCG@10 | MiniLM symbol nDCG@10 |
| --- | ---: | ---: | ---: |
| HomeEngine.cpp (held out) | 30 | 0.1820 | 0.2021 |
| BigCode Evaluation Harness (development) | 29 | 0.3779 | 0.3711 |
| HomeCode (development) | 24 | 0.4305 | 0.4854 |
| mini-swe-agent (held out) | 30 | 0.4466 | 0.4403 |
| HomeTrain (development) | 30 | 0.5602 | 0.5058 |

### Cost

| Measurement | Result |
| --- | ---: |
| HomeCode indexing | 5.470 s; 2,347 files; 25,503 entities; 56,616,876 index bytes |
| HomeEngine.cpp indexing | 16.424 s; 2,311 files; 50,472 entities; 130,712,898 bytes |
| All five index builds | 23.215 s combined |
| Candidate documents encoded | 5,883 |
| Candidate document encoding | 194.175 s; 9,036,288 vector bytes |
| HomeCode Semble search latency | p50 192.86 ms; p95 242.27 ms |
| All-repository Semble search latency | p50 29.36 ms; p95 235.39 ms, 4,500 samples |
| MiniLM query encoding plus reranking | p50 2.08 ms; p95 2.90 ms, 4,500 samples |
| Estimated combined search and rerank | p50 31.64 ms; p95 237.37 ms |
| Evaluation wall time | 12:14; 180% CPU; 1,259.50 s user and 64.66 s system CPU from `/usr/bin/time -v` |
| Peak Bun process RSS | 7,181,568 KiB (6.85 GiB) |
| Returned-context Potion-tokenizer count | Semble mean 2,188 / p50 1,914 / p95 4,814; MiniLM mean 1,939 / p50 1,861 / p95 2,528 |

The query latency includes the unchanged Semble candidate search. The dense variant's 2.08 ms p50 excludes candidate-document vector preparation; its 194 s preparation cost is reported separately. Index and latency values are specific to this machine and the pinned repository snapshots. The prior 5.11 s / 25,502 HomeCode index observation is close but not identical to this run's 5.47 s / 25,503. The earlier 153–159 ms latency came from only three HomeCode queries; it is not directly comparable to this 30-query HomeCode distribution or the five-repository aggregate.

The Bun process reported peak RSS of 6.85 GiB. The Python bridge's highest sampled RSS was 894,804 KiB; it was not continuously sampled, so this is not a process-tree peak or a precise Python maximum. Do not add the two figures as if they were a simultaneous aggregate.

Token counts use Semble's pinned Potion-Code tokenizer on the returned HomeGrep context. They do not measure a downstream LLM tokenizer or full prompt usage.

## Existing Tree-sitter reranking ablation

The evaluation-only Tree-sitter variant uses the structural extraction and metadata already present in HomeGrep. It does not add a persistent graph. On the same 143 symbol-qrel queries, symbol nDCG@10 fell from 0.4106 to 0.2390; paired delta was -0.1709 with 95% interval [-0.2568, -0.0861]. Symbol MRR fell from 0.3745 to 0.1923. It retained only 0.779 symbol Recall@100 in its Semble candidate pool.

Tree-sitter preparation parsed 10,073 files, enriched 7,227, and took 37.867 s total. Preparation p50/p95 was 220.87/795.31 ms; reported reranking p50/p95 was 31.30/243.87 ms and excludes that preparation. This structural reranker is a **NO-GO** in its current form: both relevance and amortized latency are worse. It does not rule out a future structure-aware retrieval method; it only rejects this metadata reranking rule.

## Decisions

| Approach | Decision | Evidence and next gate |
| --- | --- | --- |
| Semble hybrid | **GO as reference** | Unchanged retrieval baseline; keep the qrels and paired evaluation as the comparison gate. |
| Existing Tree-sitter metadata rerank | **NO-GO** | Measured nDCG/MRR regression and substantial preparation cost. Do not persist a symbol graph on this evidence. |
| MiniLM cosine rerank over Semble top 100 | **EXPERIMENT** | Cheap per-query reranking but a 194 s candidate-vector preparation pass and no reliable overall relevance gain. Keep evaluation-only. |
| NightOwl-CodeEmbedding CPU rerank | **EXPERIMENT / quality unmeasured** | A 100-candidate smoke needed about 56 s for document encoding and peaked near 6.04 GiB RSS. This is a CPU feasibility preflight, not qrel evidence; no full run was warranted. |
| Fine-tuning a small code retriever | **NO-GO for now** | The held-out-by-repository qrels are evaluation data, not a credible training set. First acquire a separate training corpus and show a measured failure that fine-tuning could address. |
| ColBERT / late interaction | **DEFER** | No observed failure yet requires token-level interaction; revisit after candidate-pool and per-task error analysis. |
| Persistent AST/call graph or GraphRAG | **DEFER** | Current structural reranking failed; first test simpler query-to-symbol and cross-file retrieval against expanded qrels. |
| Agent task resolution | **NOT MEASURED** | The suite has retrieval judgments only. No agent success rate or token savings claim is supported. |

The literature supports keeping these comparisons task-specific. [CoIR](https://www.alphaxiv.org/abs/2407.02883) and [Beyond Retrieval](https://www.alphaxiv.org/abs/2605.04615) motivate multi-task code retrieval evaluation. [Embeddings vs. Grep](https://www.alphaxiv.org/abs/2611.20455) highlights how candidate construction and label choices can change apparent dense-search gains; it is motivation for our paired whole-candidate-pool protocol, not evidence that MiniLM should win here. [Structural Code Search using Natural Language Queries](https://www.alphaxiv.org/abs/2507.02107) evaluates a structural-query approach, not this metadata rerank, so its results are not directly comparable.

No new embedding, graph, memory, or agent architecture has been integrated. HomeGrep remains independent of HomeMem; this work adds no HomeMem dependency or memory feature.

## Reproduction

Run from `packages/homegrep`. Use the five pinned checkouts in the qrels, a fresh `HOMEGREP_HOME`, and a local ONNX export of the listed model. The archived run used the local cached artifact whose `onnx/model.onnx` SHA-256 was `4f148ba8ae9c2c7fbee98c3d22b8393e6`.

```sh
HOMEGREP_HOME=.homegrep \
HOMEGREP_EVAL_OUTPUT=benchmark-report.json \
HOMEGREP_EVAL_CODE_MODEL="$MODEL_DIR" \
HOMEGREP_EVAL_MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2 \
HOMEGREP_EVAL_MODEL_REVISION=local-cache-sha256-4f148ba8ae9c2c7fbee98c3d22b8393e6 \
HOMEGREP_EVAL_MODEL_LICENSE=Apache-2.0 \
HOMEGREP_EVAL_MODEL_POOLING=mean \
HOMEGREP_EVAL_VECTOR_DIMENSIONS=384 \
HOMEGREP_EVAL_CPU_THREADS=4 \
HOMEGREP_EVAL_EMBEDDING_BATCH_SIZE=64 \
HOMEGREP_EVAL_REPETITIONS=30 \
HOMEGREP_EVAL_WARMUPS=3 \
HOMEGREP_EVAL_MAX_TOKENS=128 \
HOMEGREP_EVAL_POTION_TOKENIZER="$POTION_TOKENIZER_JSON" \
/usr/bin/time -v bun run script/evaluate-code-embedding-rerank.ts
```

Machine-local paths and host fields are removed from archived JSON reports. The per-task scores, latencies, index sizes, model settings, source revisions, and metric confidence intervals are retained in [`results/`](results/).
