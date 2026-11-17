import {
  COMPONENT_CODE_FORMATS,
  STRUCTURED_CODE_FORMATS,
} from "../engine/code-formats.js";
import { resolveMaxFileSizeBytes } from "../engine/file-size-policy.js";
import {
  listKnownBinaryExtensionGroups,
  listRecognizedFileTypes,
  type RecognizedFileType,
} from "../engine/file-type.js";

export function printHelp(version: string, topic?: string): void {
  if (!topic) {
    console.log(mainHelp(version));
    return;
  }

  const help = commandHelp(topic);
  if (!help) {
    throw new Error(`Unknown help topic: ${topic}`);
  }
  console.log(help);
}

const ENVIRONMENT_VARIABLES = {
  ZVEC_GREP_HOME:
    "Runtime and daemon state directory; Semble indexes use ~/.homegrep/indexes",
  ZVEC_GREP_MODE: "Default client mode: direct, server, or auto",
  ZVEC_GREP_SERVER_URL: "MCP server URL used by CLI clients",
  ZVEC_GREP_SERVER_TOKEN: "Server/client Bearer token",
  ZVEC_GREP_SERVER_TOKEN_FILE: "File containing the Server/client Bearer token",
  ZVEC_GREP_MCP_TOOLSET: "Server MCP surface: agent or full",
  ZVEC_GREP_WATCHER_IDLE_TIMEOUT_SECONDS:
    "Seconds of workspace inactivity before the Server releases its watcher; default 14400, 0 disables eviction",
  ZVEC_GREP_EMBEDDING: "Legacy variable; Semble supports Potion-Code-16M-v2 only",
  ZVEC_GREP_API_KEY: "Legacy variable; remote embedding is unsupported by Semble",
  ZVEC_GREP_ENDPOINT: "Legacy variable; remote embedding is unsupported by Semble",
  ZVEC_GREP_MODEL_CACHE: "Local embedding model cache directory",
  ZVEC_GREP_DEVICE: "Legacy variable; current Semble runtime supports CPU only",
  ZVEC_GREP_INDEX_EMBEDDING_CONCURRENCY:
    "Local/remote index-build/update embedding concurrency; explicit index CLI option takes precedence",
  DASHSCOPE_API_KEY: "Legacy provider credential; unused by Semble",
  QWEN_API_KEY: "Legacy provider credential; unused by Semble",
  ZVEC_GREP_AUTHORIZATION_KEY_FILE:
    "Workspace grant signing-key file (advanced)",
  ZVEC_GREP_METAL_KEEP_RESIDENCY:
    "Set to 1 to keep llama.cpp Metal residency enabled (advanced)",
  ZVEC_GREP_LLAMA_CONTEXT_PARALLELISM:
    "Legacy llama.cpp index limit; index CLI option and environment take precedence",
  NO_COLOR: "Disable terminal colors",
  CODEX_HOME: "Codex configuration directory used by hg --install",
  CLAUDE_CONFIG_DIR: "Claude configuration directory used by hg --install",
  GROK_HOME: "Grok Build configuration directory used by hg --install",
  QWEN_HOME: "Qwen Code configuration directory used by hg --install",
  QODER_CONFIG_DIR: "Qoder CLI configuration directory used by hg --install",
  QODER_IDE_MCP_PATH: "Full Qoder IDE mcp.json path used by hg --install",
  QODER_IDE_EXECUTABLE:
    "Qoder IDE executable used by automatic install-target detection",
  OPENCODE_CONFIG: "OpenCode configuration file used by hg --install",
  CURSOR_CONFIG_DIR: "Cursor configuration directory used by hg --install",
  COPILOT_HOME: "GitHub Copilot configuration directory used by hg --install",
  VSCODE_USER_DIR: "VS Code User profile directory used by hg --install",
  VSCODE_PORTABLE: "VS Code portable-mode directory honored by hg --install",
  VSCODE_APPDATA: "VS Code application data directory honored by hg --install",
} as const;

type EnvironmentVariableName = keyof typeof ENVIRONMENT_VARIABLES;

const MAIN_ENVIRONMENT_VARIABLES: readonly EnvironmentVariableName[] = [
  "ZVEC_GREP_HOME",
  "ZVEC_GREP_MODE",
  "ZVEC_GREP_EMBEDDING",
  "ZVEC_GREP_API_KEY",
  "ZVEC_GREP_SERVER_URL",
];

function mainHelp(version: string): string {
  return `HomeGrep ${version}

Usage:
  hg [search options] <query>
  hg --<action> [action options]

Search is the default operation. Management actions use reserved long options,
so words such as "index", "install", and "status" remain valid queries.
Leading command-shaped words emit a migration warning; use hg -- "index" to
confirm that such a word is intended as literal search input.

Actions:
  --index        Build, rebuild, or drop the workspace index
  --status       Show workspace and index status
  --config       Legacy config interface; Semble supports CPU Potion only
  --auth         Legacy authorization; remote embedding is unsupported
  --server       Start, stop, inspect, or run the shared MCP server
  --install      Install agent integrations
  --uninstall    Remove agent integrations
  --help         Show help for an action or topic
  --version      Print the installed version

Examples:
  hg "where authentication is validated"
  hg --fts "AuthService"
  hg --rg -F "AuthService" src
  hg --index --embedding local/potion-code-16m-v2
  hg --status
  hg --server on
  hg --install

Environment:
${formatEnvironmentVariables(MAIN_ENVIRONMENT_VARIABLES)}

Run hg --help models or hg --help file-types for supported indexing capabilities.
Run hg --help environment for all variables, scopes, aliases, and precedence.
Run hg --help <action> or hg --<action> --help for action-specific help.
Use hg -h/--help for this page and hg -v/--version for the version.`;
}

function commandHelp(topic: string): string | undefined {
  switch (topic) {
    case "search":
      return `Usage:
  hg <query> [options]
  hg --hybrid <query> --fts <query> --vector <query> [--fuse]
  hg --rg [rg-options] <pattern> [path...]

Search routes:
  positional query                  Hybrid FTS and vector search
  --hybrid <query>                  Add an explicit hybrid query
  --fts <query>                     Add an exact/lexical query
  --vector <query>                  Add a semantic/vector query
  --fuse                            Fuse all query groups into one ranked list
  --rg                              Run exhaustive managed ripgrep

Result options:
  --limit <n>                       Maximum results per group (default: 7)
  --compact                         Force compact output intended for pipes
  --preview <none|short|full>       Indexed preview size (default: terminal=full, pipe=none)
  --debug                           Print diagnostics to stderr
  --trace                           Unsupported by the current Semble adapter
  --refresh <background|wait|off>   Refresh policy (defaults: server=background, direct=off)
                                    In direct mode, background warns and falls back to off
  --mode <direct|server|auto>       Select indexed query transport (default: auto)

Indexed results are shown by query group, preserving each group's own rank.
A result that matches more than one group is shown in each matching group.

Embedding runtime:
  --model-cache <path>              Local model cache directory

Indexed query filters:
  Path, glob, file-type, and mtime filters are applied to indexed results.
  Symbol filtering is not yet supported. Use --rg for exhaustive exact matches.

Managed --rg supports common ripgrep matching, context, engine, encoding,
discovery, glob, and type flags. Use -e when a pattern begins with "-".
Options that replace rg's output format are rejected.

Environment:
${formatEnvironmentVariables([
  "ZVEC_GREP_MODE",
  "ZVEC_GREP_API_KEY",
  "ZVEC_GREP_ENDPOINT",
  "ZVEC_GREP_MODEL_CACHE",
  "ZVEC_GREP_DEVICE",
])}

If no index exists, hg creates one with a local embedding model before searching.
Terminal output is human-readable by default; redirected output is compact.

See hg --help environment for precedence and Server-mode scope.`;
    case "index":
      return `Usage:
  hg --index [root] [options]
  hg --index [root] --rebuild [options]
  hg --index [root] --drop [--yes]

Index options:
  --rebuild                         Rebuild the existing index
  --drop                            Permanently remove the workspace index
  --yes                             Confirm --drop without prompting
  --debug                           Print file-scan and model failure diagnostics
  --mode <direct|server|auto>       Select indexing transport

Embedding options:
  --embedding <model>               Only local/potion-code-16m-v2 is supported
  --endpoint <url>                  Unsupported by the current Semble runtime
  --model-cache <path>              Local model cache directory
  --index-embedding-concurrency <n> Unsupported by the current Semble indexer

The Semble adapter uses the official indexer and currently rejects custom
index-scope and embedding-concurrency overrides.

File selection:
  Custom indexing scopes and discovery overrides are not yet supported by the
  Semble adapter; unsupported overrides fail explicitly.

New indexes use pinned Potion-Code-16M-v2. Existing .zvec-grep indexes remain
untouched and are never interpreted as Semble indexes.

Environment:
${formatEnvironmentVariables([
  "ZVEC_GREP_MODE",
  "ZVEC_GREP_EMBEDDING",
  "ZVEC_GREP_API_KEY",
  "ZVEC_GREP_ENDPOINT",
  "ZVEC_GREP_MODEL_CACHE",
  "ZVEC_GREP_DEVICE",
  "ZVEC_GREP_INDEX_EMBEDDING_CONCURRENCY",
])}

See hg --help environment for precedence and Server-mode scope.`;
    case "status":
      return `Usage:
  hg --status [root] [--mode <direct|server|auto>] [--check-ready] [--debug]

Shows the workspace root, Semble generation state, model schema, freshness,
and suggested next action.

--debug includes recorded indexing diagnostics.
--check-ready preserves the normal output and exits non-zero unless the
Workspace index is ready.`;
    case "config":
      return `Usage:
  hg --config provider set <provider> --api-key <key>
  hg --config model set <model> [--endpoint <url> | --device <device>] [--default]

Provider options:
  --api-key <key>                   Default API key for the provider

Model options:
  --endpoint <url>                  Unsupported by the current Semble runtime
  --device <device>                 CPU only in the current Semble runtime
  --default                         Use this model for new indexes

This command edits legacy provider configuration only. The Semble runtime does
not use those provider/model settings; indexed search uses pinned CPU Potion.

Legacy global settings remain in ~/.zvec-grep/config.json.`;
    case "auth":
      return `Usage:
  hg --auth grant [root] --capability embedding --scope workspace [--embedding <model>]
  hg --auth status [root]
  hg --auth revoke [root]

This legacy command manages old Remote Embedding grants. Semble is local-only;
these grants do not authorize or affect the active search runtime.

Environment used by auth grant:
${formatEnvironmentVariables([
  "ZVEC_GREP_EMBEDDING",
  "ZVEC_GREP_API_KEY",
  "ZVEC_GREP_ENDPOINT",
  "ZVEC_GREP_AUTHORIZATION_KEY_FILE",
])}`;
    case "server":
      return `Usage:
  hg --server --stdio [--token-file <path>] [--mcp-toolset <agent|full>]
  hg --server on [--listen 127.0.0.1:7999] [--token-file <path>] [--mcp-toolset <agent|full>]
  hg --server off [--token-file <path>]
  hg --server status [--check-ready]
  hg --server run [--listen 127.0.0.1:7999] [--token-file <path>] [--mcp-toolset <agent|full>]

--stdio is the MCP client bootstrap transport. It safely starts or reuses the
shared daemon, proxies MCP over stdin/stdout, and leaves the daemon running
when the client disconnects.

The server listens on loopback. Authentication is disabled by default; pass a
token file or set ZVEC_GREP_SERVER_TOKEN to require Bearer authentication.
The public MCP endpoint defaults to the agent toolset (indexed search only).
Use --mcp-toolset full, or ZVEC_GREP_MCP_TOOLSET=full, to expose managed rg and
the four index and status tools. CLI managed rg, index, and status commands
continue to use the daemon's internal administration endpoint.
--check-ready exits non-zero unless the server is ready.

Environment:
${formatEnvironmentVariables([
  "ZVEC_GREP_HOME",
  "ZVEC_GREP_SERVER_URL",
  "ZVEC_GREP_SERVER_TOKEN",
  "ZVEC_GREP_SERVER_TOKEN_FILE",
  "ZVEC_GREP_MCP_TOOLSET",
  "ZVEC_GREP_WATCHER_IDLE_TIMEOUT_SECONDS",
])}

See hg --help environment for daemon startup scope.`;
    case "install":
      return `Usage:
  hg --install [--target codex|claude|qwen|qoder|opencode|cursor|copilot|vscode|grok|all|auto] [--mcp-transport stdio|http] [--mcp-toolset agent|full] [--yes] [--force]

Options:
  --target <agent>                  codex, claude, qwen, qoder, opencode, cursor, copilot, vscode, grok, auto, or all;
                                    repeatable
  --mcp-transport <stdio|http>      MCP connection mode (default: stdio)
  --mcp-toolset <agent|full>        Daemon MCP toolset (default: agent)
  --mcp-tool-timeout <seconds>      MCP tool timeout where supported (default: 600)
  --mcp-token-env <name>            HTTP mode Bearer token environment variable
  --yes                             Install detected agents without prompting
  --force                           Replace conflicting unmanaged configuration

The qoder target configures Qoder CLI and Qoder IDE together. The copilot
target configures GitHub Copilot CLI and Agent Host. The vscode target
configures every detected VS Code profile and shares the Copilot user
instructions, so it also registers the server for Agent Host and the Copilot
CLI. The grok target configures Grok Build's user-level config.toml, global
rules file, and tool pre-approval.

Interactive setup detects supported agents, configures stdio by default, and
starts the shared daemon. In stdio mode an agent reconnect also starts the
daemon automatically after a reboot. HTTP users manage later daemon restarts.
Codex, Claude Code, Qwen Code, Qoder CLI, OpenCode, GitHub Copilot, VS Code,
and Grok Build
also receive managed guidance. Qoder IDE has no supported global Rules file, so
only its MCP configuration is managed.
Codex and Claude Code receive local tool pre-approval. Grok Build receives
pre-approval through its permission rules unless the configuration already
defines a [permission] table. Qoder's CLI-backed
runtime receives exact pre-approval for zvec_grep_search and zvec_grep_rg. Remote Embedding
authorization remains separate and is requested by HomeGrep on first remote
use. Restart the agent or open a new session after installation. This does not
install the npm package.`;
    case "uninstall":
      return `Usage:
  hg --uninstall [--target codex|claude|qwen|qoder|opencode|cursor|copilot|vscode|grok|all|auto] [--yes]

Removes zvec-grep-managed MCP configuration, agent-specific approval, and
guidance. The qoder target removes the managed Qoder CLI and IDE integration
together.`;
    case "help":
      return `Usage:
  hg --help [action|topic]
  hg --<action> --help
  hg -h
  hg --help

Topics:
  search                             Search options and behavior
  models                             Supported embedding models
  file-types                         Supported file types and structural parsing
  environment, env                   Environment variables and precedence`;
    case "models":
      return modelsHelp();
    case "file-types":
      return fileTypesHelp();
    case "environment":
    case "env":
      return environmentHelp();
    case "version":
      return `Usage:
  hg -v
  hg --version`;
    default:
      return undefined;
  }
}

function modelsHelp(): string {


  return `Usage:
  hg --help models

Supported embedding models:
${formatTable(["MODEL", "RUNTIME", "INPUT", "DIMS", "TOKENS", "BACKEND"], [["local/potion-code-16m-v2", "local", "text", "256", "2048", "Semble / Model2Vec"]], new Set([3, 4]))}

Potion-Code is downloaded to the local model cache on first use. The current
Semble runtime supports CPU inference only; remote providers and alternate models
are not enabled.

Existing indexes keep their stored model. See hg --help environment for
new-index model selection and runtime precedence.`;
}

function fileTypesHelp(): string {
  const types = listRecognizedFileTypes();
  const structuredFormats: ReadonlySet<string> = new Set(
    STRUCTURED_CODE_FORMATS,
  );
  const componentFormats: ReadonlySet<string> = new Set(COMPONENT_CODE_FORMATS);
  const codeTypes = types.filter((type) => type.kind === "code");
  const structuredCode = codeTypes.filter((type) =>
    structuredFormats.has(type.format),
  );
  const componentCode = codeTypes.filter((type) =>
    componentFormats.has(type.format),
  );
  const plainCode = codeTypes.filter(
    (type) =>
      !structuredFormats.has(type.format) && !componentFormats.has(type.format),
  );
  const documentsAndData = types.filter(
    (type) => type.kind === "text" || type.kind === "data",
  );
  const images = types.filter((type) => type.kind === "image");
  const skipped = listKnownBinaryExtensionGroups().map((group) => [
    group.label,
    group.extensions.join(", "),
  ]);
  const sizeLimits = (
    [
      ["Code", "code"],
      ["Text", "text"],
      ["Data", "data"],
      ["Image", "image"],
    ] as const
  ).map(([label, kind]) => [
    label,
    `${resolveMaxFileSizeBytes(kind) / (1024 * 1024)} MiB`,
  ]);

  return `Usage:
  hg --help file-types

Structured code (symbols and scopes):
${formatFileTypeTable(structuredCode)}

Component code (JavaScript and TypeScript script blocks):
${formatFileTypeTable(componentCode)}

Other code (plain-text chunks):
${formatFileTypeTable(plainCode)}

Documents and data:
${formatFileTypeTable(documentsAndData)}
  Markdown preserves heading structure; other formats use text chunks.

Images (multimodal embedding required):
${formatFileTypeTable(images)}
  Images are ignored by default and must be explicitly selected.

Other text:
  Unknown non-binary extensions and extensionless files use text chunks.

Skipped binary types:
${formatTable(["GROUP", "EXTENSIONS"], skipped)}
  Files detected as binary by content are also skipped.

Indexing rules:
  Default size limits:
${formatTable(["KIND", "MAX SIZE"], sizeLimits)}
  Empty files are skipped. Use --max-filesize to override the size limit.
  Common dependencies, build output, generated files, and lock files are
  ignored by default. .git and .homegrep are always skipped.`;
}

function formatFileTypeTable(types: readonly RecognizedFileType[]): string {
  const rows = [...types]
    .sort((left, right) => left.format.localeCompare(right.format))
    .map((type) => [type.format, type.patterns.join(", ")]);
  return formatTable(["TYPE", "FILES"], rows);
}

function formatTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  rightAlignedColumns: ReadonlySet<number> = new Set(),
): string {
  const widths = header.map((label, index) =>
    Math.max(label.length, ...rows.map((row) => row[index]!.length)),
  );
  const separator = widths.map((width) => "-".repeat(width));

  return [header, separator, ...rows]
    .map(
      (row) =>
        `  ${row
          .map((value, index) =>
            index === row.length - 1
              ? value
              : rightAlignedColumns.has(index)
                ? value.padStart(widths[index]!)
                : value.padEnd(widths[index]!),
          )
          .join("  ")}`,
    )
    .join("\n");
}

function environmentHelp(): string {
  return `Usage:
  hg --help environment
  hg --help env

Client and Server:
${formatEnvironmentVariables([
  "ZVEC_GREP_MODE",
  "ZVEC_GREP_SERVER_URL",
  "ZVEC_GREP_SERVER_TOKEN",
  "ZVEC_GREP_SERVER_TOKEN_FILE",
  "ZVEC_GREP_MCP_TOOLSET",
  "ZVEC_GREP_WATCHER_IDLE_TIMEOUT_SECONDS",
])}

Embedding:
${formatEnvironmentVariables([
  "ZVEC_GREP_EMBEDDING",
  "ZVEC_GREP_API_KEY",
  "ZVEC_GREP_ENDPOINT",
  "ZVEC_GREP_MODEL_CACHE",
  "ZVEC_GREP_DEVICE",
  "ZVEC_GREP_INDEX_EMBEDDING_CONCURRENCY",
])}

Qwen credential aliases:
${formatEnvironmentVariables(["DASHSCOPE_API_KEY", "QWEN_API_KEY"])}

State and authorization:
${formatEnvironmentVariables([
  "ZVEC_GREP_HOME",
  "ZVEC_GREP_AUTHORIZATION_KEY_FILE",
])}

Advanced:
${formatEnvironmentVariables([
  "ZVEC_GREP_METAL_KEEP_RESIDENCY",
  "ZVEC_GREP_LLAMA_CONTEXT_PARALLELISM",
  "NO_COLOR",
])}

Agent integration paths:
${formatEnvironmentVariables([
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "GROK_HOME",
  "QWEN_HOME",
  "QODER_CONFIG_DIR",
  "QODER_IDE_MCP_PATH",
  "QODER_IDE_EXECUTABLE",
  "OPENCODE_CONFIG",
  "CURSOR_CONFIG_DIR",
])}

Legacy provider, model, and concurrency variables are retained for compatibility
and do not configure the current Semble runtime. Client/server variables and
agent integration path variables remain active. Semble uses local CPU Potion.

Explicit CLI options take priority. Help output never prints or stores
environment values.`;
}

function formatEnvironmentVariables(
  names: readonly EnvironmentVariableName[],
): string {
  const width = Math.max(...names.map((name) => name.length)) + 2;
  return names
    .map((name) => `  ${name.padEnd(width)}${ENVIRONMENT_VARIABLES[name]}`)
    .join("\n");
}
