# HomeCode

HomeCode is an open-source coding agent built from the [OpenCode](https://github.com/anomalyco/opencode) codebase, with a focus on local-model workflows. It includes a terminal interface, a web interface, a desktop client, and HomeGrep code search.

This is an independent fork and is not affiliated with the OpenCode project or its maintainers.

## Requirements

- [Bun](https://bun.sh/) 1.3.14 (the version pinned in `package.json`)
- Git

## Run from source

```sh
git clone https://github.com/AlexanderKyng/homecode.git
cd homecode
bun install
bun run dev --help
```

To open a project in the terminal interface:

```sh
bun run dev /path/to/project
```

The command-line application is in `packages/homecode`. The web interface, desktop client, and HomeGrep packages are in `packages/app`, `packages/desktop`, and `packages/homegrep` respectively.

## Configure a model

In the terminal interface, run `/connect` to configure a provider. See the [provider guide](packages/web/src/content/docs/providers.mdx) and [configuration reference](packages/web/src/content/docs/config.mdx) for provider and local-model settings.

## Development checks

Run CLI tests and type checking from the CLI package directory:

```sh
cd packages/homecode
bun test
bun typecheck
```

The repository's root `test` command intentionally exits with an error; tests must be run from their package directories.

## Security and limitations

The agent can run shell commands and access files according to its configured permissions. Permission prompts are not a security sandbox. See [SECURITY.md](SECURITY.md) before using HomeCode with untrusted projects.

## License

HomeCode is distributed under the [MIT License](LICENSE). It includes code from OpenCode; see the license and source headers for attribution.
