# HomeCode tests

Run the suite from `packages/homecode` with `bun test --timeout 30000`.

## Conditional tests

A Linux CI run without provider credentials reports 17 skips:

- Six `FileWatcher` cases require the native `@parcel/watcher` binding and are intentionally excluded in CI; they run locally only when the binding is available.
- Two fsmonitor checks and one worktree-removal check are enabled only on Windows, where this test suite exercises Git's fsmonitor daemon lifecycle.
- Three terminal undo and suspend cases are Windows-only because the terminal input behavior under test is platform-specific.
- The recorded native OpenAI API-key tool-loop case has no checked-in cassette. It can be recorded with the explicit `RECORD=true` flow and provider credentials described in `llm-native-recorded.test.ts`.
- Four live structured-output cases require `ANTHROPIC_API_KEY`; they are integration checks against Anthropic and remain skipped when the key is absent.

The remaining tests use local fixtures, fakes, temporary directories, or in-process servers. The test preload points models.dev reads to `test/tool/fixtures/models-api.json` and disables background network refreshes.
