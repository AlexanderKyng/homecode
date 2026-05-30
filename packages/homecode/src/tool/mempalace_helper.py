#!/usr/bin/env python3
"""
MemPalace native helper for HomeCode.
Reads a JSON command from stdin, calls the appropriate mempalace function,
writes a compact JSON result to stdout.

Protocol:
  stdin:  {"subtool": "search", "query": "...", "wing": "...", "limit": 3}
  stdout: {"subtool": "search", "results": [...]}

If mempalace is not installed, returns {"error": "install"}.
"""

import json
import os
import sys
import hashlib
from datetime import datetime

_real_stdout = sys.stdout
_real_stdout_fd = None
try:
    _real_stdout_fd = os.dup(1)
    os.dup2(2, 1)
except (OSError, AttributeError):
    pass
sys.stdout = sys.stderr

try:
    from mempalace.config import MempalaceConfig, sanitize_name, sanitize_content
    from mempalace.query_sanitizer import sanitize_query
    from mempalace.searcher import search_memories
    from mempalace.palace import get_collection

    _HAS_MEMPALACE = True
except ImportError:
    MempalaceConfig = None
    sanitize_name = None
    sanitize_content = None
    sanitize_query = None
    search_memories = None
    get_collection = None
    _HAS_MEMPALACE = False

sys.stdout = _real_stdout
if _real_stdout_fd is not None:
    try:
        os.dup2(_real_stdout_fd, 1)
        os.close(_real_stdout_fd)
    except OSError:
        pass
    _real_stdout_fd = None

_MAX_RESULTS = 10
_TRUNCATE_CHARS = 500


def _get_collection(create: bool = False):
    config = MempalaceConfig()
    return get_collection(config.palace_path, create=create)


def _search(cmd: dict):
    query = cmd["query"]
    limit = min(cmd.get("limit", 5), _MAX_RESULTS)
    wing = cmd.get("wing") or None
    room = cmd.get("room") or None
    max_distance = cmd.get("max_distance", 1.5)

    sanitized = sanitize_query(query)
    config = MempalaceConfig()

    result = search_memories(
        sanitized["clean_query"],
        palace_path=config.palace_path,
        wing=wing,
        room=room,
        n_results=limit,
        max_distance=max_distance,
    )

    if "error" in result:
        return {"error": result["error"]}

    hits = result.get("results", [])
    compact = []
    for h in hits:
        text = h.get("text", "")
        if len(text) > _TRUNCATE_CHARS:
            text = text[:_TRUNCATE_CHARS] + "..."
        compact.append(
            {
                "w": h.get("wing", "?"),
                "r": h.get("room", "?"),
                "s": h.get("source_file", "?"),
                "sim": h.get("similarity", 0),
                "t": text,
            }
        )
    return compact


def _write(cmd: dict):
    wing = sanitize_name(cmd["wing"], "wing")
    room = sanitize_name(cmd["room"], "room")
    content = sanitize_content(cmd["content"])
    col = _get_collection(create=True)
    if not col:
        return {"error": "no palace"}

    drawer_id = (
        f"drawer_{wing}_{room}"
        f"_{hashlib.sha256((wing + room + content).encode()).hexdigest()[:24]}"
    )

    try:
        existing = col.get(ids=[drawer_id])
        if existing and existing["ids"]:
            return {"ok": True, "reason": "exists", "id": drawer_id}
    except Exception:
        pass

    try:
        col.upsert(
            ids=[drawer_id],
            documents=[content],
            metadatas=[
                {
                    "wing": wing,
                    "room": room,
                    "source_file": "",
                    "chunk_index": 0,
                    "added_by": "homecode",
                    "filed_at": datetime.now().isoformat(),
                }
            ],
        )
        return {"ok": True, "id": drawer_id, "w": wing, "r": room}
    except Exception as e:
        return {"error": str(e)}


def _read(cmd: dict):
    agent_name = sanitize_name(cmd["agent_name"], "agent_name")
    last_n = max(1, min(cmd.get("last_n", 10), 100))
    wing = cmd.get("wing") or None
    col = _get_collection()
    if not col:
        return {"error": "no palace"}

    conditions = [{"room": "diary"}, {"agent": agent_name}]
    if wing:
        conditions.insert(0, {"wing": wing})

    try:
        results = col.get(
            where={"$and": conditions},
            include=["documents", "metadatas"],
            limit=10000,
        )
    except Exception:
        return {"error": "failed to read diary"}

    if not results["ids"]:
        return {"agent": agent_name, "entries": []}

    entries = []
    for doc, meta in zip(results["documents"], results["metadatas"]):
        meta = meta or {}
        content = doc
        if len(content) > _TRUNCATE_CHARS:
            content = content[:_TRUNCATE_CHARS] + "..."
        entries.append(
            {
                "d": meta.get("filed_at", ""),
                "topic": meta.get("topic", ""),
                "c": content,
            }
        )

    entries.sort(key=lambda e: e["d"], reverse=True)
    entries = entries[:last_n]
    return {"agent": agent_name, "n": len(entries), "entries": entries}


def _status(cmd: dict):
    col = _get_collection()
    if not col:
        return {"error": "no palace"}

    count = col.count()
    try:
        wings = {}
        rooms = {}
        batch = 5000
        offset = 0
        while offset < count:
            data = col.get(
                include=["metadatas"],
                limit=batch,
                offset=offset,
            )
            for m in data.get("metadatas") or []:
                if m:
                    w = m.get("wing", "unknown")
                    r = m.get("room", "unknown")
                    wings[w] = wings.get(w, 0) + 1
                    rooms[r] = rooms.get(r, 0) + 1
            offset += len(data.get("ids", []))
        return {"d": count, "wings": wings, "rooms": rooms}
    except Exception as e:
        return {"error": str(e)}


_HANDLERS = {
    "search": _search,
    "write": _write,
    "read": _read,
    "status": _status,
}


def main():
    if not _HAS_MEMPALACE:
        sys.stdout.write(json.dumps({"error": "install"}))
        sys.stdout.write("\n")
        sys.stdout.flush()
        return

    try:
        raw = sys.stdin.read()
        cmd = json.loads(raw)
    except Exception:
        sys.stdout.write(json.dumps({"error": "invalid input"}))
        sys.stdout.write("\n")
        sys.stdout.flush()
        return

    subtool = cmd.get("subtool", "status")
    handler = _HANDLERS.get(subtool)
    if not handler:
        sys.stdout.write(json.dumps({"error": f"unknown subtool: {subtool}"}))
        sys.stdout.write("\n")
        sys.stdout.flush()
        return

    try:
        result = handler(cmd)
    except Exception as e:
        result = {"error": str(e)}

    sys.stdout.write(json.dumps(result))
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
