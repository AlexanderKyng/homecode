# Contributing

HomeCode is developed in the open. Use the repository's issue tracker for bug reports and feature discussions, then open a focused pull request with a short description of the change and how you verified it.

## Development setup

Install the Bun version pinned in the root `package.json`, then install dependencies from the repository root:

```sh
bun install
```

The CLI package's tests and type check must be run from `packages/homecode`:

```sh
cd packages/homecode
bun test
bun typecheck
```

The root `test` script intentionally exits with an error. Other packages may define their own checks in their `package.json` files.

## Pull requests

- Keep each change focused and preserve existing behavior unless the change requires otherwise.
- Include relevant tests for behavior changes.
- For UI changes, include a screenshot when it helps reviewers understand the result.
- Do not include generated output, local configuration, credentials, or benchmark state.
