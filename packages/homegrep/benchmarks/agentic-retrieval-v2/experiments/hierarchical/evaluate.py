#!/usr/bin/env python3
"""Read-only experiment: Semble file retrieval followed by within-file chunk retrieval."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

import numpy as np

from semble.index import SembleIndex
from semble.search import _search_semantic, resolve_alpha, search
from semble.tokens import tokenize


HERE = Path(__file__).resolve().parents[2]
QRELS = HERE
FILE_BUDGETS = (5, 10, 25, 50, 100)
CHUNK_CAPS = (1, 3, 10, 0)  # zero means every indexed chunk in each selected file
RANKERS = ("bm25", "dense", "rrf")
BOOTSTRAP_SAMPLES = 2000


def read_json(path: Path):
    return json.loads(path.read_text())


def index_path(state: Path, repository: dict):
    root = Path(repository["path"]).resolve()
    key = hashlib.sha256(str(root).encode()).hexdigest()
    base = state / "indexes" / key
    pointer = read_json(base / "current.json")
    generation = pointer["generation"]
    return root, base, generation, base / "generations" / generation / "semble"


def chunk_key(chunk):
    return (chunk.file_path.replace("\\", "/"), int(chunk.start_line), int(chunk.end_line))


def stable_order(ids, scores, chunks):
    return sorted(ids, key=lambda i: (-float(scores[i]), *chunk_key(chunks[i])))


def dcg(grades):
    return sum((2**grade - 1) / math.log2(rank + 1) for rank, grade in enumerate(grades, 1))


def judgment_hit(chunk, judgment):
    return (
        chunk.file_path.replace("\\", "/") == judgment["path"].replace("\\", "/")
        and chunk.start_line <= judgment["endLine"]
        and chunk.end_line >= judgment["startLine"]
    )


def unique_files(ids, chunks):
    seen = set()
    result = []
    for chunk_id in ids:
        path = chunks[chunk_id].file_path.replace("\\", "/")
        if path not in seen:
            seen.add(path)
            result.append(path)
    return result


def metrics(task, ids, chunks):
    symbols = [item for item in task["relevant"] if item.get("symbol")]
    relevant_files = task["relevantFiles"]
    found_symbols = [any(judgment_hit(chunks[i], qrel) for i in ids) for qrel in symbols]
    file_order = unique_files(ids, chunks)
    file_grades = {item["path"].replace("\\", "/"): item["grade"] for item in relevant_files}
    symbol_grades = [0] * min(10, len(ids))
    symbol_seen = set()
    for rank, chunk_id in enumerate(ids[:10]):
        matches = [i for i, judgment in enumerate(symbols) if judgment_hit(chunks[chunk_id], judgment)]
        grade = max((symbols[i]["grade"] for i in matches if i not in symbol_seen), default=0)
        symbol_grades[rank] = grade
        symbol_seen.update(matches)
    ideal_symbol = sorted((item["grade"] for item in symbols), reverse=True)[:10]
    file_dcg = [file_grades.get(path, 0) for path in file_order[:10]]
    ideal_file = sorted(file_grades.values(), reverse=True)[:10]
    symbol_hit_ids_10 = [i for i, qrel in enumerate(symbols)
                         if any(judgment_hit(chunks[chunk_id], qrel) for chunk_id in ids[:10])]
    symbol_hit_ids_100 = [i for i, qrel in enumerate(symbols)
                          if any(judgment_hit(chunks[chunk_id], qrel) for chunk_id in ids[:100])]
    return {
        "symbol_judgments": len(symbols),
        "file_judgments": len(file_grades),
        "symbol_hit_ids_10": symbol_hit_ids_10,
        "symbol_hit_ids_100": symbol_hit_ids_100,
        "symbol_recall_10": sum(found_symbols[:0]) / max(len(symbols), 1),  # replaced below using top-10
        "symbol_recall_100": sum(found_symbols) / max(len(symbols), 1),
        "symbol_ndcg_10": dcg(symbol_grades) / dcg(ideal_symbol) if ideal_symbol else 0.0,
        "file_recall_10": sum(path in file_grades for path in file_order[:10]) / max(len(file_grades), 1),
        "file_recall_100": sum(path in file_grades for path in file_order[:100]) / max(len(file_grades), 1),
        "file_ndcg_10": dcg(file_dcg) / dcg(ideal_file) if ideal_file else 0.0,
        "returned_chunks": len(ids),
        "returned_files": len(file_order),
        "context_chars_10": sum(len(chunks[i].content) for i in ids[:10]),
        "context_words_10": sum(len(chunks[i].content.split()) for i in ids[:10]),
    }


def with_symbol_recall10(values, task, ids, chunks):
    symbols = [item for item in task["relevant"] if item.get("symbol")]
    found = sum(any(judgment_hit(chunks[i], qrel) for i in ids[:10]) for qrel in symbols)
    values["symbol_recall_10"] = found / max(len(symbols), 1)
    return values


def search_channels(index, query, vector_norms):
    chunks = index.chunks
    bm25 = index._bm25_index.get_scores(tokenize(query))
    encoded = index.model.encode([query])[0]
    vectors = index._semantic_index.vectors
    query_norm = np.linalg.norm(encoded)
    dense = (vectors @ encoded) / np.maximum(vector_norms * query_norm, 1e-12)
    bm25_ids = np.flatnonzero(bm25 > 0)
    bm25_ids = stable_order(bm25_ids, bm25, chunks)[:500]
    dense_ids = stable_order(range(len(chunks)), dense, chunks)[:500]
    return bm25, dense, bm25_ids, dense_ids


def make_file_orders(index, query, channels, chunk_id_by_key):
    chunks = index.chunks
    default = [chunk_id_by_key[chunk_key(item.chunk)] for item in search(
        query, index.model, index._semantic_index, index._bm25_index, chunks, 100
    )]
    default_files = unique_files(default, chunks)
    bm25_ids, dense_ids = channels[2], channels[3]
    channel_bm25 = {}
    channel_dense = {}
    for rank, chunk_id in enumerate(bm25_ids, 1):
        path = chunks[chunk_id].file_path.replace("\\", "/")
        channel_bm25[path] = min(channel_bm25.get(path, 10**9), rank)
    for rank, chunk_id in enumerate(dense_ids, 1):
        path = chunks[chunk_id].file_path.replace("\\", "/")
        channel_dense[path] = min(channel_dense.get(path, 10**9), rank)
    all_paths = set(channel_bm25) | set(channel_dense)
    channel_files = sorted(all_paths, key=lambda path: (
        -(1 / (60 + channel_bm25[path]) if path in channel_bm25 else 0)
        -(1 / (60 + channel_dense[path]) if path in channel_dense else 0), path
    ))
    return default, {"default": default_files, "channel_rrf": channel_files}


def hierarchical(index, file_order, budget, cap, ranker, scores):
    chunks = index.chunks
    selected_paths = set(file_order[:budget])
    path_ids = {}
    for i, chunk in enumerate(chunks):
        path = chunk.file_path.replace("\\", "/")
        if path in selected_paths:
            path_ids.setdefault(path, []).append(i)
    values = scores[ranker]
    candidate_ids = [i for ids in path_ids.values() for i in ids]
    if ranker == "rrf":
        bm25 = scores["bm25"]
        dense = scores["dense"]
        b_rank = {i: rank for rank, i in enumerate(stable_order(candidate_ids, bm25, chunks), 1)}
        d_rank = {i: rank for rank, i in enumerate(stable_order(candidate_ids, dense, chunks), 1)}
        alpha = scores["alpha"]
        values = {i: (1 - alpha) / (60 + b_rank[i]) + alpha / (60 + d_rank[i]) for i in candidate_ids}
    chosen = []
    for path in sorted(path_ids):
        ordered = sorted(path_ids[path], key=lambda i: (-float(values[i]), *chunk_key(chunks[i])))
        chosen.extend(ordered if cap == 0 else ordered[:cap])
    return sorted(chosen, key=lambda i: (-float(values[i]), *chunk_key(chunks[i])))[:100]


def hierarchical_default(index, query, chunk_id_by_key, vector_norms, file_budget, chunk_cap):
    """Run the selected path as a real query: Semble file candidates, then local chunk scoring."""
    chunks = index.chunks
    default_ids = [chunk_id_by_key[chunk_key(item.chunk)] for item in search(
        query, index.model, index._semantic_index, index._bm25_index, chunks, 100
    )]
    file_order = unique_files(default_ids, chunks)
    selected_paths = set(file_order[:file_budget])
    candidate_ids = [i for i, chunk in enumerate(chunks)
                     if chunk.file_path.replace("\\", "/") in selected_paths]
    bm25 = index._bm25_index.get_scores(tokenize(query))
    encoded = index.model.encode([query])[0]
    vectors = index._semantic_index.vectors[candidate_ids]
    norms = np.maximum(vector_norms[candidate_ids] * np.linalg.norm(encoded), 1e-12)
    dense = (vectors @ encoded) / norms
    bm25_local = {i: float(bm25[i]) for i in candidate_ids}
    dense_local = {i: float(score) for i, score in zip(candidate_ids, dense)}
    ranks_bm25 = {i: rank for rank, i in enumerate(stable_order(candidate_ids, bm25_local, chunks), 1)}
    ranks_dense = {i: rank for rank, i in enumerate(stable_order(candidate_ids, dense_local, chunks), 1)}
    alpha = resolve_alpha(query, None)
    fused = {i: (1 - alpha) / (60 + ranks_bm25[i]) + alpha / (60 + ranks_dense[i])
             for i in candidate_ids}
    by_path = {}
    for i in candidate_ids:
        by_path.setdefault(chunks[i].file_path.replace("\\", "/"), []).append(i)
    selected = []
    for path in sorted(by_path):
        local = sorted(by_path[path], key=lambda i: (-fused[i], *chunk_key(chunks[i])))
        selected.extend(local if chunk_cap == 0 else local[:chunk_cap])
    return sorted(selected, key=lambda i: (-fused[i], *chunk_key(chunks[i])))[:100], len(candidate_ids)


def aggregate(rows, metric, repo=None):
    selected = [row for row in rows if repo is None or row["repository"] == repo]
    selected = [row for row in selected if metric in row["metrics"]]
    judgment_key = "symbol_judgments" if metric.startswith("symbol_") else "file_judgments"
    selected = [row for row in selected if row["metrics"][judgment_key] > 0]
    return statistics.mean(row["metrics"][metric] for row in selected) if selected else 0.0


def percentile(values, q):
    return float(np.percentile(values, q)) if values else None


def paired_bootstrap(rows, metric, baseline="baseline", samples=BOOTSTRAP_SAMPLES, seed=20261117):
    by_task = {}
    judgment_key = "symbol_judgments" if metric.startswith("symbol_") else "file_judgments"
    for row in rows:
        if row["metrics"][judgment_key] == 0:
            continue
        by_task.setdefault(row["task_id"], {})[row["config"]] = row["metrics"][metric]
    diffs = [(values["selected"] - values["baseline"]) for values in by_task.values()
             if "selected" in values and "baseline" in values]
    if not diffs:
        return {"mean_difference": None, "ci95": None, "n_tasks": 0}
    rng = np.random.default_rng(seed)
    values = np.asarray(diffs)
    samples_array = np.mean(rng.choice(values, size=(samples, len(values)), replace=True), axis=1)
    return {"mean_difference": float(values.mean()),
            "ci95": [float(np.quantile(samples_array, .025)), float(np.quantile(samples_array, .975))],
            "n_tasks": len(diffs)}


def rss_kib():
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    except OSError:
        pass
    return None


def main():
    parser = argparse.ArgumentParser()
    state = os.environ.get("HOMEGREP_HOME")
    parser.add_argument("--state", type=Path, default=Path(state) if state else None)
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("HOMEGREP_EVAL_OUTPUT", "/tmp/homegrep-hierarchical.json")))
    parser.add_argument("--timing-repetitions", type=int, default=5)
    args = parser.parse_args()
    if args.state is None:
        parser.error("set HOMEGREP_HOME to the existing agentic-retrieval-v2 index directory")

    qrel_parts = [read_json(path) for path in sorted(QRELS.glob("*.json"))]
    if len(qrel_parts) != 5:
        parser.error(f"expected the five committed qrel files under {QRELS}, found {len(qrel_parts)}")
    repos = {part["repository"]["id"]: part["repository"] for part in qrel_parts}
    tasks = [(part["repository"]["id"], part["repository"]["split"], task)
             for part in qrel_parts for task in part["tasks"]]
    indexes, manifests, load_seconds, chunk_id_maps = {}, {}, {}, {}
    vector_norms = {}
    for repo_id, repository in repos.items():
        root, base, generation, path = index_path(args.state, repository)
        started = time.perf_counter()
        indexes[repo_id] = SembleIndex.load_from_disk(path)
        chunk_id_maps[repo_id] = {chunk_key(chunk): i for i, chunk in enumerate(indexes[repo_id].chunks)}
        vector_norms[repo_id] = np.linalg.norm(indexes[repo_id]._semantic_index.vectors, axis=1)
        load_seconds[repo_id] = time.perf_counter() - started
        manifests[repo_id] = {"root": str(root), "generation": generation,
                              "index_path": str(path), "task_split": repository["split"]}

    rows = []
    channel_diagnostics = []
    task_payload = []
    preparation_seconds = []
    dense_score_crosscheck = None
    process_cpu_start = time.process_time()
    for repo_id, split, task in tasks:
        index = indexes[repo_id]
        chunks = index.chunks
        started = time.perf_counter()
        bm25, dense, bm25_ids, dense_ids = search_channels(index, task["query"], vector_norms[repo_id])
        if repo_id == "homecode" and dense_score_crosscheck is None:
            backend_ids = {chunk_key(result.chunk) for result in _search_semantic(
                task["query"], index.model, index._semantic_index, chunks, 500, None
            )}
            manual_ids = {chunk_key(chunks[i]) for i in dense_ids}
            dense_score_crosscheck = {"repository": repo_id, "queries_checked": 1,
                                      "backend_top500_overlap": len(backend_ids & manual_ids),
                                      "manual_top500_overlap": len(manual_ids),
                                      "maximum_index_vector_norm_error": float(np.max(np.abs(vector_norms[repo_id] - 1)))}
        default_ids, file_orders = make_file_orders(index, task["query"], (bm25, dense, bm25_ids, dense_ids), chunk_id_maps[repo_id])
        preparation_seconds.append(time.perf_counter() - started)
        rrf_global = {i: 0.0 for i in set(bm25_ids) | set(dense_ids)}
        alpha = resolve_alpha(task["query"], None)
        for rank, i in enumerate(bm25_ids, 1):
            rrf_global[i] += (1 - alpha) / (60 + rank)
        for rank, i in enumerate(dense_ids, 1):
            rrf_global[i] += alpha / (60 + rank)
        bm25_top = set(bm25_ids)
        dense_top = set(dense_ids)
        default_files = unique_files(default_ids, chunks)
        for judgment in task["relevant"]:
            if not judgment.get("symbol"):
                continue
            overlapping = [i for i, chunk in enumerate(chunks) if judgment_hit(chunk, judgment)]
            channel_diagnostics.append({
                "task_id": task["id"], "repository": repo_id, "split": split,
                "symbol": judgment["symbol"], "path": judgment["path"],
                "default_top100_hit": any(judgment_hit(chunks[i], judgment) for i in default_ids),
                "bm25_top500_hit": any(i in bm25_top for i in overlapping),
                "dense_top500_hit": any(i in dense_top for i in overlapping),
                "bm25_best_score": max((float(bm25[i]) for i in overlapping), default=None),
                "dense_best_score": max((float(dense[i]) for i in overlapping), default=None),
                "rrf_global_best": max((float(rrf_global.get(i, 0)) for i in overlapping), default=0),
                "overlapping_chunk_count": len(overlapping),
                "first_file_rank_default": (default_files.index(judgment["path"].replace("\\", "/")) + 1
                                             if judgment["path"].replace("\\", "/") in default_files else None),
            })

        baseline_metrics = with_symbol_recall10(metrics(task, default_ids, chunks), task, default_ids, chunks)
        rows.append({"task_id": task["id"], "repository": repo_id, "split": split,
                     "config": "baseline", "metrics": baseline_metrics})
        task_payload.append({"task_id": task["id"], "repository": repo_id, "split": split,
                             "query": task["query"], "default_top100": [chunk_key(chunks[i]) for i in default_ids]})

        for file_strategy, file_order in file_orders.items():
            for budget in FILE_BUDGETS:
                for cap in CHUNK_CAPS:
                    for ranker in RANKERS:
                        ids = hierarchical(index, file_order, budget, cap, ranker,
                                           {"bm25": bm25, "dense": dense, "rrf": None,
                                            "alpha": resolve_alpha(task["query"], None)})
                        measured = with_symbol_recall10(metrics(task, ids, chunks), task, ids, chunks)
                        selected_paths = set(file_order[:budget])
                        counts_by_path = {}
                        for indexed_chunk in chunks:
                            path = indexed_chunk.file_path.replace("\\", "/")
                            if path in selected_paths:
                                counts_by_path[path] = counts_by_path.get(path, 0) + 1
                        measured["candidate_chunks_scored"] = sum(
                            min(count, cap) if cap else count for count in counts_by_path.values()
                        )
                        config = f"{file_strategy}/files{budget}/chunks{cap or 'all'}/{ranker}"
                        rows.append({"task_id": task["id"], "repository": repo_id, "split": split,
                                     "config": config, "metrics": measured})

    # Parameter selection only on development repositories. Held-out results are reported
    # after selection and never influence the chosen setting.
    development_configs = sorted({row["config"] for row in rows if row["split"] == "development" and row["config"] != "baseline"})
    baseline_dev_file_ndcg = aggregate([row for row in rows if row["config"] == "baseline" and row["split"] == "development"], "file_ndcg_10")
    baseline_dev_file_recall = aggregate([row for row in rows if row["config"] == "baseline" and row["split"] == "development"], "file_recall_10")
    feasible_configs = [config for config in development_configs if config.startswith("default/")
                        if aggregate([row for row in rows if row["config"] == config and row["split"] == "development"], "file_ndcg_10") >= baseline_dev_file_ndcg - .03
                        and aggregate([row for row in rows if row["config"] == config and row["split"] == "development"], "file_recall_10") >= baseline_dev_file_recall - .01]
    feasible_configs = [config for config in feasible_configs
                        if aggregate([row for row in rows if row["config"] == config and row["split"] == "development"], "file_recall_100") >= aggregate([row for row in rows if row["config"] == "baseline" and row["split"] == "development"], "file_recall_100") - .02]
    if not feasible_configs:
        raise RuntimeError("no development configuration meets the predeclared file-ranking non-inferiority guard")
    selected_config = max(feasible_configs, key=lambda config: (
        aggregate([row for row in rows if row["config"] == config and row["split"] == "development"], "symbol_ndcg_10"),
        aggregate([row for row in rows if row["config"] == config and row["split"] == "development"], "symbol_recall_10"),
        aggregate([row for row in rows if row["config"] == config and row["split"] == "development"], "symbol_recall_100"),
        -aggregate([row for row in rows if row["config"] == config and row["split"] == "development"], "candidate_chunks_scored"),
    ))

    timing = {}
    for repo_id, split, task in tasks:
        if split != "held_out_repository" and split != "held_out_time":
            continue
        index = indexes[repo_id]
        strategy, budget, cap, ranker = selected_config.split("/")
        budget = int(budget.removeprefix("files"))
        cap = 0 if cap == "chunksall" else int(cap.removeprefix("chunks"))
        values = {"baseline": [], "selected": []}
        for _ in range(args.timing_repetitions):
            start = time.perf_counter()
            search(task["query"], index.model, index._semantic_index, index._bm25_index, index.chunks, 100)
            values["baseline"].append((time.perf_counter() - start) * 1000)
            start = time.perf_counter()
            hierarchical_default(index, task["query"], chunk_id_maps[repo_id], vector_norms[repo_id], budget, cap)
            values["selected"].append((time.perf_counter() - start) * 1000)
        timing[task["id"]] = values

    metric_names = ("symbol_recall_10", "symbol_recall_100", "symbol_ndcg_10",
                    "file_recall_10", "file_recall_100", "file_ndcg_10", "candidate_chunks_scored")
    comparison_metrics = metric_names[:-1]
    configs = ["baseline"] + development_configs
    summary = {}
    for config in configs:
        selected_rows = [row for row in rows if row["config"] == config]
        summary[config] = {"development": {metric: (None if metric == "candidate_chunks_scored" and config == "baseline"
                                                        else aggregate([row for row in selected_rows if row["split"] == "development"], metric))
                                            for metric in metric_names},
                           "held_out": {metric: (None if metric == "candidate_chunks_scored" and config == "baseline"
                                                     else aggregate([row for row in selected_rows if row["split"].startswith("held_out")], metric))
                                         for metric in metric_names}}
    paired = {metric: paired_bootstrap(
        [{"task_id": row["task_id"], "config": "baseline" if row["config"] == "baseline" else "selected",
          "metrics": row["metrics"]} for row in rows if row["config"] in ("baseline", selected_config)
         and row["split"].startswith("held_out")], metric)
        for metric in comparison_metrics}
    repository_summary = {repo_id: {
        config: {metric: (None if metric == "candidate_chunks_scored" and config == "baseline"
                          else aggregate([row for row in rows if row["config"] == config], metric, repo_id))
                for metric in metric_names}
        for config in ("baseline", selected_config)
    } for repo_id in repos}
    channel_failure_analysis = {}
    for split_name in ("development", "held_out_repository"):
        failures = [row for row in channel_diagnostics if row["split"] == split_name and not row["default_top100_hit"]]
        intra_file = [row for row in failures if row["first_file_rank_default"] is not None]
        def channel_cells(items):
            return {"bm25_and_dense": sum(item["bm25_top500_hit"] and item["dense_top500_hit"] for item in items),
                    "bm25_only": sum(item["bm25_top500_hit"] and not item["dense_top500_hit"] for item in items),
                    "dense_only": sum(item["dense_top500_hit"] and not item["bm25_top500_hit"] for item in items),
                    "neither_top500": sum(not item["bm25_top500_hit"] and not item["dense_top500_hit"] for item in items)}
        channel_failure_analysis[split_name] = {"all_symbol_misses": len(failures),
                                                "channel_candidates_for_all_misses": channel_cells(failures),
                                                "intra_file_misses": len(intra_file),
                                                "channel_candidates_for_intra_file_misses": channel_cells(intra_file)}
    intra_file_summary = {}
    for split_name in ("development", "held_out_repository"):
        baseline_rows = {row["task_id"]: row for row in rows if row["config"] == "baseline" and row["split"] == split_name}
        chosen_rows = {row["task_id"]: row for row in rows if row["config"] == selected_config and row["split"] == split_name}
        missed = [(task_id, symbol_id) for task_id, baseline_row in baseline_rows.items()
                  for symbol_id in set(range(baseline_row["metrics"]["symbol_judgments"])) - set(baseline_row["metrics"]["symbol_hit_ids_100"])]
        # Restrict to misses whose qrel file appears among Semble's top-100 results.
        task_by_id = {task["id"]: [item for item in task["relevant"] if item.get("symbol")]
                      for _, _, task in tasks}
        files_by_task = {item["task_id"]: {path for path, _, _ in item["default_top100"]}
                         for item in task_payload}
        missed_in_file = [(task_id, symbol_id) for task_id, symbol_id in missed
                          if task_by_id[task_id][symbol_id]["path"] in files_by_task[task_id]]
        chosen_hits = sum(symbol_id in chosen_rows[task_id]["metrics"]["symbol_hit_ids_100"]
                          for task_id, symbol_id in missed_in_file)
        intra_file_summary[split_name] = {"baseline_misses_with_file_in_top100": len(missed_in_file),
                                          "selected_recovered": chosen_hits,
                                          "selected_recall_on_subset": chosen_hits / len(missed_in_file) if missed_in_file else None}

    latency = {key: [value for entry in timing.values() for value in entry[key]] for key in ("baseline", "selected")}
    selected_rows = [row for row in rows if row["config"] == selected_config]
    baseline_rows = [row for row in rows if row["config"] == "baseline"]
    context_summary = {"baseline": {}, "selected": {}}
    for key, source_rows in (("baseline", [row for row in baseline_rows if row["split"].startswith("held_out")]),
                             ("selected", [row for row in selected_rows if row["split"].startswith("held_out")])):
        for metric in ("context_chars_10", "context_words_10", "candidate_chunks_scored"):
            available = [row["metrics"][metric] for row in source_rows if metric in row["metrics"]]
            context_summary[key][metric] = {"p50": percentile(available, 50), "p95": percentile(available, 95)}
    result = {
        "schema_version": 1,
        "experiment": "hierarchical-file-to-chunk",
        "production_ranking_changed": False,
        "engine_revision": "8ee6463efbb1ff755c339e965c7298b7afd7db5b",
        "dataset": {"repositories": manifests, "tasks": len(tasks),
                    "symbol_judgments": sum(bool(j.get("symbol")) for _, _, t in tasks for j in t["relevant"]),
                    "file_judgments": sum(len(t["relevantFiles"]) for _, _, t in tasks)},
        "parameter_selection": {"selection_split": "development", "held_out_repositories": [r for r, m in manifests.items() if m["task_split"].startswith("held_out")],
                                "selected_config": selected_config,
        "selection_rule": "Default Semble file order only. Keep development file Recall@10 within 0.01, Recall@100 within 0.02, and nDCG@10 within 0.03 absolute of baseline; maximize symbol nDCG@10, then symbol Recall@10 and Recall@100; break ties by fewer scored chunks. No held-out metric participates."},
        "summary": summary,
        "selected_held_out_paired_bootstrap_vs_baseline": paired,
        "all_repository_performance": repository_summary,
        "intra_file_failure_subset": intra_file_summary,
        "channel_failure_analysis": channel_failure_analysis,
        "held_out_latency_ms": {key: {"p50": float(np.percentile(values, 50)), "p95": float(np.percentile(values, 95))}
                                 for key, values in latency.items()},
        "full_corpus_channel_diagnostic_seconds_per_task": {"p50": float(np.percentile(preparation_seconds, 50)),
                                                             "p95": float(np.percentile(preparation_seconds, 95))},
        "index_load_seconds_by_repository": load_seconds,
        "process_cpu_seconds_for_full_sweep": time.process_time() - process_cpu_start,
        "max_rss_kib": rss_kib(),
        "dense_score_crosscheck": dense_score_crosscheck,
        "context_measures": "10 returned chunks; characters and whitespace-separated words (not model tokens)",
        "held_out_context_and_candidate_budget": context_summary,
        "channel_diagnostics": channel_diagnostics,
        "task_results": [{"task_id": row["task_id"], "repository": row["repository"], "split": row["split"],
                           "config": row["config"], "metrics": {key: value for key, value in row["metrics"].items()
                                                                    if key not in ("symbol_hit_ids_10", "symbol_hit_ids_100")}}
                          for row in rows if row["config"] in ("baseline", selected_config)],
        "timing_repetitions_per_held_out_query": args.timing_repetitions,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"selected_config": selected_config, "baseline_dev": summary["baseline"]["development"],
                      "selected_dev": summary[selected_config]["development"],
                      "baseline_held_out": summary["baseline"]["held_out"],
                      "selected_held_out": summary[selected_config]["held_out"],
                      "paired_ci": paired, "latency_ms": result["held_out_latency_ms"],
                      "prep_seconds": result["preparation_seconds_per_task"], "max_rss_kib": result["max_rss_kib"],
                      "output": str(args.output)}, indent=2))


if __name__ == "__main__":
    main()
