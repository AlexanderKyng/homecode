# HomeCode CLI

The HomeCode terminal application lives in this package. See the [repository README](../../README.md) for setup, provider configuration, and the first run.

From the repository root:

```sh
bun install
bun run dev --help
bun run dev /path/to/project
```

Run package checks from this directory:

```sh
bun test
bun typecheck
```

To build the standalone CLI for the current platform, run `bun run build --single --skip-install` from this directory. See the root README for the MIT license and OpenCode attribution.
