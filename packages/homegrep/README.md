# HomeGrep

HomeGrep is a local workspace search engine for humans and agents. Its
standalone TypeScript package provides the engine API, `hg` CLI, loopback
daemon, MCP transports, and authorization helpers. Semantic indexing and
retrieval use a pinned external Python Semble runtime; exact and regex search
use ripgrep.

## Requirements

- Node.js 22 or newer
- `uv` on `PATH` (or set `HOMEGREP_UV` to its executable)
- Python 3.10 or newer; `uv` creates the locked runtime environment

The first semantic operation downloads the pinned Potion-Code model from the
Hugging Face Hub. Its files and the generated index are stored outside the
source tree. Remote embedding providers are disabled in this Semble adapter.

## Build and use

From `packages/homegrep` in the HomeCode repository:

```bash
bun install
bun run build
node dist/cli/index.js --help
node dist/cli/index.js --index /path/to/workspace
node dist/cli/index.js --status /path/to/workspace
node dist/cli/index.js "where bearer tokens are validated"
node dist/cli/index.js --rg -F "validateBearerToken"
node dist/cli/index.js --server --stdio
```

The package exposes the `hg` command and the `zg` compatibility alias. It also
provides `npm run index -- /path/to/workspace`, `npm run daemon --`, and
`npm run mcp`. The HTTP daemon binds to loopback; when a bearer token is
configured, MCP requests without that token are rejected. See CLI help for
server token, toolset, and transport options.

Run `bun run typecheck` and `bun run test` from this package. The regression
tests exercise indexing, incremental updates, BM25/vector retrieval, exact
ripgrep, generation publication and corruption handling, Python bridge errors,
daemon lifecycle, and MCP authentication.

## Semble provenance

The bridge depends on Semble 0.7.0 at revision
`8ee6463efbb1ff755c339e965c7298b7afd7db5b`; Semble is not vendored or modified.
The bridge reuses its indexing, incremental indexing, file and chunk helpers,
model loading, persistence, and hybrid search. HomeGrep implements the
JSON-lines process bridge, content hashing, generation validation, locking,
and atomic publication. The upstream revision is MIT licensed; the exact
license and attribution are included in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
The HomeGrep package itself is Apache-2.0. Model and transitive dependency
licenses are separate.
