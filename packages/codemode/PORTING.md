# Interpreter provenance

The confined AST interpreter and standard library in `src/` are selectively ported from OpenCode v2 `2.0.32`, commit `22e771f5893e255ea78fc10557ed3fb98d3a1072`, package `@opencode/codemode`. OpenAPI-specific helpers are not exported or used by HomeCode. HomeCode adaptations target the repository's Effect `4.0.0-beta.66` catalog and keep the interpreter isolated in this workspace package. See `LICENSE.upstream` for the upstream MIT notice.
