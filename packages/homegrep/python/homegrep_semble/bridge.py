"""Persistent JSON-lines adapter around the pinned, unmodified Semble engine."""

from __future__ import annotations

import hashlib
import fnmatch
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from filelock import FileLock
from huggingface_hub import snapshot_download
from semble import ContentType, SembleIndex
from semble.index.create import create_index_from_path
from semble.index.dense import load_model
from semble.index.file_walker import walk_files
from semble.index.files import (
    MAX_FILE_BYTES,
    FileStatus,
    get_extensions,
    get_file_status,
)
from semble.index.types import FileManifestEntry, PreviousIndex, make_chunk_id

ENGINE_REVISION = "8ee6463efbb1ff755c339e965c7298b7afd7db5b"
DEFAULT_MODEL_ID = "minishlab/potion-code-16M-v2"
DEFAULT_MODEL_REVISION = "e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b"
INDEX_FORMAT = 1
CONTENT_TYPES = (ContentType.CODE, ContentType.DOCS, ContentType.CONFIG)
EMBEDDING_DIMENSION = 256
_INDEX_CACHE: dict[tuple[str, str], SembleIndex] = {}


def _embedding_identity() -> dict[str, Any]:
    return {
        "provider": "model2vec",
        "model_id": DEFAULT_MODEL_ID,
        "revision": DEFAULT_MODEL_REVISION,
        "tokenizer_revision": DEFAULT_MODEL_REVISION,
        "query_prompt": None,
        "document_prompt": None,
        "pooling": "model2vec-static",
        "normalization": "model2vec-model-default",
        "dimension": EMBEDDING_DIMENSION,
        "representation": "dense-f32",
        "metric": "cosine",
    }


def _root_key(root: Path) -> str:
    return hashlib.sha256(os.fsencode(str(root))).hexdigest()


def _state_path(state_root: Path, root: Path) -> Path:
    return state_root / "indexes" / _root_key(root)


def _new_scan_diagnostics() -> dict[str, Any]:
    return {
        "skipped_files": 0,
        "skipped_by_reason": {
            "empty": 0,
            "too_large": 0,
            "unsupported": 0,
            "binary": 0,
        },
        "skipped_samples": [],
    }


def _scan(
    root: Path, diagnostics: dict[str, Any] | None = None
) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for path in walk_files(root, get_extensions(CONTENT_TYPES)):
        try:
            stat = path.stat()
            status = (
                FileStatus.TOO_LARGE
                if stat.st_size > MAX_FILE_BYTES
                else get_file_status(path, stat)
            )
            if status is not FileStatus.VALID:
                if diagnostics is not None:
                    reason = status.value
                    diagnostics["skipped_files"] += 1
                    diagnostics["skipped_by_reason"][reason] += 1
                    if len(diagnostics["skipped_samples"]) < 20:
                        sample = {
                            "absolute_path": str(path),
                            "relative_path": path.relative_to(root).as_posix(),
                            "reason": reason,
                            "size_bytes": stat.st_size,
                        }
                        if status is FileStatus.TOO_LARGE:
                            sample["limit_bytes"] = MAX_FILE_BYTES
                        diagnostics["skipped_samples"].append(sample)
                continue
            relative = path.relative_to(root).as_posix()
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
            hashes[relative] = digest.hexdigest()
        except (OSError, ValueError):
            # A file that changes or disappears during discovery is not silently
            # included in a generation; the caller retries after the next scan.
            raise RuntimeError(f"workspace changed while scanning: {path}") from None
    return hashes


def _load_generation(
    state: Path, root: Path, *, load_index: bool = True
) -> tuple[SembleIndex | None, dict[str, Any]] | None:
    pointer_path = state / "current.json"
    if not pointer_path.exists():
        return None
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    if pointer.get("format") != INDEX_FORMAT or pointer.get("engine_revision") != ENGINE_REVISION:
        raise ValueError("incompatible HomeGrep Semble index; rebuild into a new generation")
    generation_id = pointer.get("generation")
    if not isinstance(generation_id, str) or len(generation_id) != 32 or any(
        character not in "0123456789abcdef" for character in generation_id
    ):
        raise ValueError("invalid Semble generation pointer; refusing to open the index")
    generation = state / "generations" / generation_id
    manifest_path = generation / "homegrep-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("root") != str(root)
        or manifest.get("engine_revision") != ENGINE_REVISION
        or manifest.get("generation") != generation_id
        or manifest.get("embedding") != _embedding_identity()
    ):
        raise ValueError("index identity does not match the requested workspace or Semble revision")
    index = SembleIndex.load_from_disk(generation / "semble") if load_index else None
    if index is not None:
        _validate_complete_index(index, manifest)
    return index, manifest


def _validate_complete_index(index: SembleIndex, manifest: dict[str, Any]) -> None:
    rows = len(index.chunks)
    vectors = index._semantic_index.vectors
    files = manifest.get("content_sha256", {})
    file_manifest = index._manifest
    if (
        rows != len(index._bm25_index.doc_order)
        or rows != vectors.shape[0]
        or vectors.ndim != 2
        or vectors.shape[1] != EMBEDDING_DIMENSION
        or manifest.get("files") != len(file_manifest)
        or manifest.get("chunks") != rows
        or not isinstance(files, dict)
        or set(files) != set(file_manifest)
    ):
        raise ValueError("incomplete Semble index generation; refusing to search")
    expected_ids: list[str] = []
    next_start = 0
    for indexed_path, entry in file_manifest.items():
        if entry.start != next_start or any(
            chunk.file_path != indexed_path for chunk in index.chunks[entry.start : entry.end]
        ):
            raise ValueError("inconsistent Semble file/chunk manifest; refusing to search")
        expected_ids.extend(make_chunk_id(indexed_path, slot) for slot in range(entry.count))
        next_start += entry.count
    if next_start != rows or index._bm25_index.doc_order != expected_ids:
        raise ValueError("inconsistent Semble BM25/chunk order; refusing to search")
    expected_paths = {path for path, entry in file_manifest.items() if entry.count}
    if set(index._file_mapping) != expected_paths:
        raise ValueError("inconsistent Semble file lookup; refusing to search")


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _secure_tree(root: Path) -> None:
    for directory, subdirectories, filenames in os.walk(root):
        directory_path = Path(directory)
        os.chmod(directory_path, 0o700)
        for name in filenames:
            os.chmod(directory_path / name, 0o600)
        for name in subdirectories:
            os.chmod(directory_path / name, 0o700)


def index_workspace(request: dict[str, Any]) -> dict[str, Any]:
    root = Path(request["root"]).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise NotADirectoryError(root)
    state_root = Path(request["state_root"]).expanduser().resolve()
    state = _state_path(state_root, root)
    generations = state / "generations"
    generations.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    os.chmod(generations, 0o700)
    lock = FileLock(str(state / "writer.lock"), timeout=120)

    with lock:
        scan_diagnostics = _new_scan_diagnostics()
        hashes = _scan(root, scan_diagnostics)
        previous_entry = _load_generation(state, root)
        previous_manifest = previous_entry[1] if previous_entry else {}
        previous_hashes = previous_manifest.get("content_sha256", {})
        model_path = snapshot_download(
            DEFAULT_MODEL_ID,
            revision=DEFAULT_MODEL_REVISION,
            cache_dir=request.get("model_cache_dir"),
        )
        model, _ = load_model(model_path)
        embedding_identity = _embedding_identity()
        if int(model.dim) != EMBEDDING_DIMENSION:
            raise ValueError("Potion-Code model dimension does not match the recorded embedding space")
        previous: PreviousIndex | None = None
        reused_files = 0
        if previous_entry is not None and not request.get("rebuild", False):
            prior, manifest = previous_entry
            if manifest.get("embedding") == embedding_identity:
                old_manifest = {name: FileManifestEntry(**vars(item)) for name, item in prior._manifest.items()}
                old_hashes = manifest.get("content_sha256", {})
                for name, entry in old_manifest.items():
                    if hashes.get(name) != old_hashes.get(name):
                        entry.mtime_ns = -1
                    else:
                        reused_files += 1
                previous = PreviousIndex(
                    chunks=prior.chunks,
                    vectors=prior._semantic_index.vectors,
                    manifest=old_manifest,
                    bm25_index=prior._bm25_index,
                )

        bm25, dense, chunks, file_manifest = create_index_from_path(
            root,
            model=model,
            content=CONTENT_TYPES,
            display_root=root,
            previous=previous,
        )
        index = SembleIndex(
            model,
            bm25,
            dense,
            chunks,
            model_path,
            root=root,
            content=CONTENT_TYPES,
            manifest=file_manifest,
        )
        if _scan(root) != hashes:
            raise RuntimeError("workspace changed during indexing; the incomplete generation was discarded")
        generation_id = uuid.uuid4().hex
        staging = generations / f".staging-{generation_id}"
        target = generations / generation_id
        staging.mkdir(mode=0o700)
        try:
            index.save(staging / "semble")
            manifest = {
                "format": INDEX_FORMAT,
                "engine_revision": ENGINE_REVISION,
                "root": str(root),
                "generation": generation_id,
                "embedding": embedding_identity,
                "content_sha256": hashes,
                "files": len(file_manifest),
                "chunks": len(chunks),
                "created_time": previous_manifest.get("created_time", time.time() * 1000),
                "updated_time": time.time() * 1000,
            }
            (staging / "homegrep-manifest.json").write_text(
                json.dumps(manifest, sort_keys=True), encoding="utf-8"
            )
            _secure_tree(staging)
            for directory, _, filenames in os.walk(staging):
                for filename in filenames:
                    with (Path(directory) / filename).open("rb") as artifact:
                        os.fsync(artifact.fileno())
                _fsync_directory(Path(directory))
            os.replace(staging, target)
            _fsync_directory(generations)
            pointer = {
                "format": INDEX_FORMAT,
                "engine_revision": ENGINE_REVISION,
                "generation": generation_id,
            }
            pointer_tmp = state / f".current-{generation_id}.tmp"
            pointer_tmp.write_text(json.dumps(pointer), encoding="utf-8")
            os.chmod(pointer_tmp, 0o600)
            with pointer_tmp.open("rb") as item:
                os.fsync(item.fileno())
            os.replace(pointer_tmp, state / "current.json")
            _fsync_directory(state)
            policy_path = state / "policy.json"
            if policy_path.exists() and json.loads(policy_path.read_text(encoding="utf-8")) != "enabled":
                policy_tmp = state / f".policy-{generation_id}.tmp"
                policy_tmp.write_text(json.dumps("enabled"), encoding="utf-8")
                os.chmod(policy_tmp, 0o600)
                os.replace(policy_tmp, policy_path)
                _fsync_directory(state)
        finally:
            if staging.exists():
                import shutil

                shutil.rmtree(staging)

        _INDEX_CACHE[(str(state), generation_id)] = index
        for cache_key in [key for key in _INDEX_CACHE if key[0] == str(state) and key[1] != generation_id]:
            del _INDEX_CACHE[cache_key]

        return {
            "root": str(root),
            "generation": generation_id,
            "files": len(file_manifest),
            "chunks": len(chunks),
            "reused_files": reused_files,
            "files_added": len(hashes.keys() - previous_hashes.keys()),
            "files_modified": sum(
                1 for name in hashes.keys() & previous_hashes.keys() if hashes[name] != previous_hashes[name]
            ),
            "files_deleted": len(previous_hashes.keys() - hashes.keys()),
            "files_unchanged": sum(
                1 for name in hashes.keys() & previous_hashes.keys() if hashes[name] == previous_hashes[name]
            ),
            "scan_diagnostics": scan_diagnostics,
            "engine_revision": ENGINE_REVISION,
        }


def search_workspace(request: dict[str, Any]) -> dict[str, Any]:
    root = Path(request["root"]).expanduser().resolve(strict=True)
    state_root = Path(request["state_root"]).expanduser().resolve()
    state = _state_path(state_root, root)
    policy_path = state / "policy.json"
    if policy_path.exists() and json.loads(policy_path.read_text(encoding="utf-8")) == "disabled":
        raise PermissionError("semantic search is disabled for this workspace")
    loaded = _load_generation(state, root, load_index=False)
    if loaded is None:
        raise FileNotFoundError("no Semble index exists for this workspace")
    _, manifest = loaded
    freshness_started = time.perf_counter()
    current_hashes = _scan(root)
    freshness_ms = (time.perf_counter() - freshness_started) * 1000
    refresh_ms = 0.0
    if request.get("auto_refresh", True) and current_hashes != manifest.get("content_sha256", {}):
        refresh_started = time.perf_counter()
        index_workspace({**request, "operation": "index"})
        refresh_ms = (time.perf_counter() - refresh_started) * 1000
        loaded = _load_generation(state, root, load_index=False)
        if loaded is None:
            raise FileNotFoundError("Semble index publication failed")
        _, manifest = loaded
    elif current_hashes != manifest.get("content_sha256", {}):
        raise RuntimeError("index is stale; refresh it before searching")
    generation = manifest["generation"]
    index = _INDEX_CACHE.get((str(state), generation))
    if index is None:
        loaded = _load_generation(state, root)
        if loaded is None or loaded[0] is None:
            raise ValueError("incomplete Semble index generation; refusing to search")
        index = loaded[0]
        _INDEX_CACHE[(str(state), generation)] = index
    filters = request.get("filters", {})
    if filters.get("symbol_types"):
        raise ValueError("symbol-type filtering is unavailable for the pinned Semble chunk schema")
    filter_paths = _select_paths(root, index, filters)
    if filter_paths == []:
        return {
            "root": str(root),
            "generation": generation,
            "engine_revision": ENGINE_REVISION,
            "freshness_ms": freshness_ms,
            "refresh_ms": refresh_ms,
            "semble_search_ms": 0.0,
            "results": [],
        }
    search_started = time.perf_counter()
    results = index.search(
        request["query"],
        top_k=max(1, min(int(request.get("limit", 10)), 1000)),
        alpha=request.get("alpha"),
        filter_paths=filter_paths,
        filter_languages=None,
    )
    semble_search_ms = (time.perf_counter() - search_started) * 1000
    offset_cache: dict[Path, tuple[list[int], list[int]]] = {}
    return {
        "root": str(root),
            "generation": generation,
        "engine_revision": ENGINE_REVISION,
        "freshness_ms": freshness_ms,
        "refresh_ms": refresh_ms,
        "semble_search_ms": semble_search_ms,
        "results": [
            {
                "path": result.chunk.file_path,
                "start_line": result.chunk.start_line,
                "end_line": result.chunk.end_line,
                "start_offset": _line_offset(root / result.chunk.file_path, result.chunk.start_line, offset_cache),
                "end_offset": _line_end_offset(root / result.chunk.file_path, result.chunk.end_line, offset_cache),
                "language": result.chunk.language,
                "content": result.chunk.content,
                "score": float(result.score),
            }
            for result in results
        ],
    }


def workspace_status(request: dict[str, Any]) -> dict[str, Any]:
    root = Path(request["root"]).expanduser().resolve(strict=True)
    state = _state_path(Path(request["state_root"]).expanduser().resolve(), root)
    policy_path = state / "policy.json"
    policy = json.loads(policy_path.read_text(encoding="utf-8")) if policy_path.exists() else "enabled"
    loaded = _load_generation(state, root, load_index=False)
    manifest = loaded[1] if loaded else None
    stale = manifest is not None and _scan(root) != manifest.get("content_sha256", {})
    return {
        "root": str(root),
        "indexed": manifest is not None,
        "index_policy": policy,
        "files": manifest.get("files", 0) if manifest else 0,
        "chunks": manifest.get("chunks", 0) if manifest else 0,
        "stale": stale,
        "created_time": manifest.get("created_time") if manifest else None,
        "updated_time": manifest.get("updated_time") if manifest else None,
        "generation": manifest.get("generation") if manifest else None,
        "engine_revision": ENGINE_REVISION,
        "index_path": str(state),
    }


def set_workspace_policy(request: dict[str, Any]) -> dict[str, Any]:
    root = Path(request["root"]).expanduser().resolve(strict=True)
    state = _state_path(Path(request["state_root"]).expanduser().resolve(), root)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    lock = FileLock(str(state / "writer.lock"), timeout=120)
    with lock:
        policy_path = state / "policy.json"
        if request.get("operation") == "drop":
            if not policy_path.exists() and not (state / "current.json").exists():
                return {"dropped": False}
            disabled_tmp = state / ".policy-drop.tmp"
            disabled_tmp.write_text(json.dumps("disabled"), encoding="utf-8")
            os.chmod(disabled_tmp, 0o600)
            with disabled_tmp.open("rb") as item:
                os.fsync(item.fileno())
            os.replace(disabled_tmp, policy_path)
            _fsync_directory(state)
            pointer_path = state / "current.json"
            if pointer_path.exists():
                pointer_path.unlink()
            _fsync_directory(state)
            generations = state / "generations"
            if generations.exists():
                tombstone = state / f".dropped-{uuid.uuid4().hex}"
                os.replace(generations, tombstone)
                _fsync_directory(state)
                import shutil

                shutil.rmtree(tombstone)
                _fsync_directory(state)
            for cache_key in [key for key in _INDEX_CACHE if key[0] == str(state)]:
                del _INDEX_CACHE[cache_key]
            return {"dropped": True}
        policy = "disabled" if request.get("operation") == "disable" else "enabled"
        temporary = state / ".policy.tmp"
        temporary.write_text(json.dumps(policy), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, policy_path)
        _fsync_directory(state)
        return {"policy": policy}


def _line_offsets(path: Path, cache: dict[Path, tuple[list[int], list[int]]]) -> tuple[list[int], list[int]]:
    offsets = cache.get(path)
    if offsets is None:
        starts = [0]
        ends: list[int] = []
        try:
            with path.open("r", encoding="utf-8", errors="replace", newline="") as source:
                for value in source:
                    width = len(value.encode("utf-16-le")) // 2
                    line_end = width
                    if value.endswith("\r\n"):
                        line_end -= 2
                    elif value.endswith(("\n", "\r")):
                        line_end -= 1
                    ends.append(starts[-1] + line_end)
                    starts.append(starts[-1] + width)
        except OSError:
            return [0], [0]
        offsets = (starts, ends)
        cache[path] = offsets
    return offsets


def _line_offset(path: Path, line: int, cache: dict[Path, tuple[list[int], list[int]]]) -> int:
    starts, _ = _line_offsets(path, cache)
    return starts[max(0, min(line - 1, len(starts) - 1))]


def _line_end_offset(path: Path, line: int, cache: dict[Path, tuple[list[int], list[int]]]) -> int:
    _, ends = _line_offsets(path, cache)
    if not ends:
        return 0
    return ends[max(0, min(line - 1, len(ends) - 1))]


def _select_paths(root: Path, index: SembleIndex, filters: dict[str, Any]) -> list[str] | None:
    if not any(
        filters.get(key)
        for key in (
            "paths",
            "include_paths",
            "exclude_paths",
            "globs",
            "insensitive_globs",
            "file_types",
            "excluded_file_types",
            "languages",
        )
    ) and filters.get("max_depth") is None and filters.get("modified_after") is None and filters.get(
        "modified_before"
    ) is None:
        return None
    rules = filters.get("paths") or filters.get("include_paths") or []
    includes = list(rules) + list(filters.get("globs") or [])
    insensitive = list(filters.get("insensitive_globs") or [])
    excludes = list(filters.get("exclude_paths") or []) + list(filters.get("excluded_globs") or [])
    file_types = {value.lower().lstrip(".") for value in filters.get("file_types") or []}
    excluded_types = {value.lower().lstrip(".") for value in filters.get("excluded_file_types") or []}
    languages = {value.lower() for value in filters.get("languages") or []}
    selected: list[str] = []
    for indexed_path in index._file_mapping:
        path = Path(indexed_path)
        normalized = path.as_posix()
        if includes and not any(_matches_path_rule(root, normalized, rule) for rule in includes):
            if not any(_matches_path_rule(root, normalized, rule, case_sensitive=False) for rule in insensitive):
                continue
        if not includes and insensitive and not any(
            _matches_path_rule(root, normalized, rule, case_sensitive=False) for rule in insensitive
        ):
            continue
        if any(_matches_path_rule(root, normalized, rule) for rule in excludes):
            continue
        suffix = path.suffix.lower().lstrip(".")
        path_languages = {index.chunks[row].language for row in index._file_mapping[normalized]}
        if languages and not ({language.lower() for language in path_languages} & languages):
            continue
        if file_types and suffix not in file_types and not (path_languages & file_types):
            continue
        if suffix in excluded_types or path_languages & excluded_types:
            continue
        if filters.get("max_depth") is not None and len(path.parts) > int(filters["max_depth"]) + 1:
            continue
        try:
            modified = (root / path).stat().st_mtime * 1000
        except OSError:
            continue
        if filters.get("modified_after") is not None and modified < float(filters["modified_after"]):
            continue
        if filters.get("modified_before") is not None and modified > float(filters["modified_before"]):
            continue
        selected.append(normalized)
    return selected


def _matches_path_rule(root: Path, indexed_path: str, rule: str, *, case_sensitive: bool = True) -> bool:
    candidate = Path(rule)
    if candidate.is_absolute():
        resolved = candidate.resolve()
        try:
            candidate = resolved.relative_to(root)
        except ValueError:
            raise ValueError("filter path escapes the indexed workspace") from None
    pattern = candidate.as_posix().rstrip("/")
    if not pattern:
        return True
    if not case_sensitive:
        indexed_path, pattern = indexed_path.casefold(), pattern.casefold()
    if any(character in pattern for character in "*?["):
        return (
            fnmatch.fnmatchcase(indexed_path, pattern)
            or fnmatch.fnmatchcase(indexed_path, f"**/{pattern}")
            or (pattern.startswith("**/") and fnmatch.fnmatchcase(indexed_path, pattern[3:]))
        )
    return indexed_path == pattern or indexed_path.startswith(f"{pattern}/")


def serve() -> None:
    for line in sys.stdin:
        request: Any = None
        try:
            request = json.loads(line)
            operation = request.get("operation")
            if operation == "close":
                print(json.dumps({"id": request.get("id"), "ok": True}), flush=True)
                return
            if operation == "index":
                result = index_workspace(request)
            elif operation == "search":
                result = search_workspace(request)
            elif operation == "status":
                result = workspace_status(request)
            elif operation in ("disable", "enable", "drop"):
                result = set_workspace_policy(request)
            else:
                raise ValueError(f"unsupported operation: {operation!r}")
            response = {"id": request.get("id"), "ok": True, "result": result}
        except Exception as error:  # Keep protocol errors machine-readable; details go to stderr.
            print(f"HomeGrep Semble runtime error: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "ok": False,
                "error": {"type": type(error).__name__, "message": str(error)},
            }
        print(json.dumps(response, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    serve()
