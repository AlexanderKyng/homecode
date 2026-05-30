import { Schema } from "effect"
import DESCRIPTION from "./shell.txt"
import { PositiveInt } from "@homecode-ai/core/schema"
import { Global } from "@homecode-ai/core/global"
import { ShellID } from "./id"

const PS = new Set(["powershell", "pwsh"])
const CMD = new Set(["cmd"])

const descriptions = {
  bash: "Brief command summary (e.g., 'ls → List directory').",
  powershell: "Brief command summary (e.g., 'Get-ChildItem → List directory').",
  cmd: "Brief command summary (e.g., 'dir → List directory').",
}

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema(description: string) {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "Command to execute" }),
    timeout: Schema.optional(PositiveInt).annotate({ description: "Timeout in ms" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: "Working directory (overrides default). Use this instead of 'cd'.",
    }),
    description: Schema.String.annotate({ description }),
  })
}

export const Parameters = parameterSchema(descriptions.bash)
export type Parameters = Schema.Schema.Type<typeof Parameters>

function renderPrompt(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`)
    return value
  })
}

function shellDisplayName(name: string) {
  if (name === "pwsh") return "PowerShell (7+)"
  if (name === "powershell") return "Windows PowerShell (5.1)"
  if (name === "cmd") return "cmd.exe"
  return name
}

function powershellNotes(name: string) {
  if (name === "pwsh") {
    return `# pwsh (7+) notes
- Supports \`&&\` and \`||\`.
- Double quotes: interpolated (\`"Hi $n"\`). Single: verbatim.
- Use full cmdlets (e.g., \`Get-ChildItem\`), avoid aliases.
- Subexpressions: \`$(...)\`. Arrays: \`@(...)\`.
- Call exe with spaces: \`& "path/to/exe" args\`.
- Escape with backtick.`
  }
  if (name === "powershell") {
    return `# WinPS (5.1) notes
- Chain dependent cmds: \`cmd1; if ($?) { cmd2 }\`. NO \`&&\` support.
- Double quotes: interpolated. Single: verbatim.
- Use full cmdlets (e.g., \`Get-ChildItem\`).
- Subexpressions: \`$(...)\`. Arrays: \`@(...)\`.
- Call exe with spaces: \`& "path/to/exe" args\`.
- Escape with backtick.`
  }
  return ""
}

function chainGuidance(name: string) {
  if (name === "powershell") {
    return "Chain dependent cmds sequentially: `cmd1; if ($?) { cmd2 }`. WinPS 5.1 lacks '&&'."
  }
  if (PS.has(name)) {
    return "Chain dependent sequential cmds with '&&' (e.g., `git add . && git commit -m \"msg\"`)."
  }
  if (CMD.has(name)) {
    return "Chain dependent sequential cmds with `&&` (e.g., `mkdir out && dir out`)."
  }
  return "Chain dependent sequential cmds with '&&' in one call (e.g., `mkdir foo && cp bar foo/`)."
}

function bashCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `1. Verify Dirs: Use \`ls\` before creating files/dirs (e.g., \`ls foo\` before \`mkdir foo/bar\`).
2. Quote Paths: Double quote paths with spaces (e.g., \`rm "path with spaces/file"\`).

Notes:
- Command required. Default timeout: ${defaultTimeoutMs}ms.
- Output > ${limits.maxLines} lines or ${limits.maxBytes} bytes truncates to file. Use 'Read'/'Grep' tools on file. NO \`head\`/\`tail\`.
- USE NATIVE TOOLS over shell cmds unless strictly required:
  - File search: Glob (NOT find/ls)
  - Content search: Grep (NOT grep/rg)
  - Read files: Read (NOT cat/head/tail)
  - Edit files: Edit (NOT sed/awk)
  - Write files: Write (NOT echo >)
  - Communication: Output text directly (NOT echo)
- Parallel cmds: Send multiple tool calls.
- ${chain}
- Use ';' ONLY to ignore failures of previous cmds. No newlines to separate cmds.
- USE \`workdir\` param. AVOID \`cd <dir> && cmd\`.`
}

function powershellCommandSection(
  name: string,
  chain: string,
  pathSep: string,
  limits: Limits,
  defaultTimeoutMs: number,
) {
  return `${powershellNotes(name)}

1. Verify Dirs: Use \`Test-Path -LiteralPath <parent>\` before creating items.
2. Quote Paths: Double quote paths with spaces (e.g., \`Remove-Item "a b${pathSep}file"\`).

Notes:
- Command required. Default timeout: ${defaultTimeoutMs}ms.
- Output > ${limits.maxLines} lines or ${limits.maxBytes} bytes truncates to file. Use 'Read'/'Grep' tools. NO \`Select-Object\`.
- USE NATIVE TOOLS over shell cmdlets:
  - File search: Glob (NOT Get-ChildItem)
  - Content search: Grep (NOT Select-String)
  - Read files: Read (NOT Get-Content)
  - Edit files: Edit (NOT Set-Content)
  - Write files: Write (NOT Set-Content/Out-File)
  - Comm: Output text directly (NOT Write-Host)
- Parallel cmds: Send multiple tool calls.
- ${chain}
- Use ';' ONLY to ignore failures of previous cmds. No newlines to separate cmds.
- USE \`workdir\` param. AVOID changing directories inside command.`
}

function cmdCommandSection(chain: string, limits: Limits, defaultTimeoutMs: number) {
  return `#
- Double quote paths with spaces. Use %VAR% for env vars, \`if exist\` for checks, \`call\` for .bat scripts.

1. Verify Dirs: Use \`if exist\` before creating items.
2. Quote Paths: Double quote paths with spaces.

Notes:
- Command required. Default timeout: ${defaultTimeoutMs}ms.
- Output > ${limits.maxLines} lines or ${limits.maxBytes} bytes truncates to file. Use 'Read'/'Grep' tools. NO \`more\`.
- USE NATIVE TOOLS over shell cmds:
  - File search: Glob (NOT dir /s)
  - Content search: Grep (NOT findstr)
  - Read files: Read (NOT type)
  - Edit files: Edit (NOT copy)
  - Write files: Write (NOT echo >)
  - Comm: Output text directly (NOT echo)
- Parallel cmds: Send multiple tool calls.
- ${chain}
- Use '&' ONLY to ignore failures of previous cmds. No newlines to separate cmds.
- USE \`workdir\` param. AVOID \`cd /d\`.`
}

function profile(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const isPowerShell = PS.has(name)
  const chain = chainGuidance(name)
  if (CMD.has(name)) {
    return {
      intro: `Executes ${shellDisplayName(name)} command with optional timeout.`,
      workdirSection: "Runs in current dir. Use `workdir` param to change dirs. AVOID internal directory changes.",
      commandSection: cmdCommandSection(chain, limits, defaultTimeoutMs),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction: "Create PR via temp body file for simple quoting.",
      createPrExample: `(\n  echo ## Summary\n  echo - ^<points^>\n) > pr-body.txt\ngh pr create --title "Title" --body-file pr-body.txt`,
      parameterDescription: descriptions.cmd,
    }
  }
  if (isPowerShell) {
    return {
      intro: `Executes ${shellDisplayName(name)} command with optional timeout.`,
      workdirSection: "Runs in current dir. Use `workdir` param to change dirs. AVOID internal directory changes.",
      commandSection: powershellCommandSection(
        name,
        chain,
        platform === "win32" ? "\\" : "/",
        limits,
        defaultTimeoutMs,
      ),
      gitCommands: "git commands",
      gitCommandRestriction: "git commands",
      createPrInstruction: "Create PR using gh pr create with PowerShell here-string.",
      createPrExample: `gh pr create --title "Title" --body @'\n## Summary\n- <points>\n'@`,
      parameterDescription: descriptions.powershell,
    }
  }
  return {
    intro: "Executes bash command in persistent session with optional timeout.",
    workdirSection: "Runs in current dir. Use `workdir` param to change dirs. AVOID `cd <dir> && <cmd>`.",
    commandSection: bashCommandSection(chain, limits, defaultTimeoutMs),
    gitCommands: "bash commands",
    gitCommandRestriction: "git bash commands",
    createPrInstruction: "Create PR using gh pr create with HEREDOC formatting.",
    createPrExample: `gh pr create --title "Title" --body "$(cat <<'EOF'\n## Summary\n<points>\nEOF\n)"`,
    parameterDescription: descriptions.bash,
  }
}

export function render(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const selected = profile(name, platform, limits, defaultTimeoutMs)
  return {
    description: renderPrompt(DESCRIPTION, {
      intro: selected.intro,
      os: platform,
      shell: name,
      tmp: Global.Path.tmp,
      workdirSection: selected.workdirSection,
      commandSection: selected.commandSection,
      gitCommands: selected.gitCommands,
      toolName: ShellID.ToolID,
      gitCommandRestriction: selected.gitCommandRestriction,
      createPrInstruction: selected.createPrInstruction,
      createPrExample: selected.createPrExample,
    }),
    parameters: parameterSchema(selected.parameterDescription),
  }
}

export * as ShellPrompt from "./prompt"
