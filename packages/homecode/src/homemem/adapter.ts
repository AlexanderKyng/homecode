import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import type { Diagnostic as LspDiagnostic } from "vscode-languageserver-types"
import { Context, Effect, Layer, Semaphore } from "effect"
import * as Log from "@homecode-ai/core/util/log"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { HomeMemConfig } from "./config"

const log = Log.create({ service: "homemem.adapter" })
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])
const TEST_COMMAND =
  /(?:^|(?:&&|;|\|)\s*)(?:bun\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|pytest|python(?:3)?\s+-m\s+pytest|go\s+test|dotnet\s+test|mvn(?:w)?\s+test|gradle(?:w)?\s+test)(?:\s|$)/

type Position = { line: number; character: number }
type CanonicalDiagnostic = {
  fingerprint: string
  message: string
  path: string
  range: { start: number; end: number }
  package: string
  package_version: string
  symbol: string
}
type ObservationKind =
  | { type: "diagnostic_observed"; diagnostic: CanonicalDiagnostic }
  | {
      type: "file_edited"
      edit: {
        path: string
        before_hash: string
        after_hash: string
        replacements: { from: string; to: string; range: { start: number; end: number } }[]
      }
    }
  | { type: "diagnostic_cleared"; fingerprint: string; path: string }
  | { type: "test_completed"; command: string; passed: boolean; related_paths: string[] }
  | {
      type: "recall_requested"
      request_id: string
      request: {
        package: string
        package_version: string
        diagnostic_fingerprint: string
        symbol: string
        token_budget: number
      }
    }
  | {
      type: "recall_presented"
      exposure_id: string
      request_id: string
      capsule_id: string
      rule_id: string
      estimated_tokens: number
      channel: "shadow_log"
    }
  | {
      type: "recall_injected"
      exposure_id: string
      request_id: string
      capsule_id: string
      rule_id: string
      estimated_tokens: number
    }
  | {
      type: "host_action_observed"
      exposure_id: string
      action_id: string
      disposition: "applied" | "ignored"
    }
  | { type: "outcome_observed"; action_id: string; outcome: "successful" | "failed" }

type Observation = {
  id: string
  occurred_at_ms: number
  sequence: number
  stream: { producer: string; workspace_id: string; session_id: string }
  correlation_id: string | null
  kind: ObservationKind
}
type ToolSnapshot = {
  active: boolean
  trace: string
  database: string
  command: string[]
  workspaceID: string
  sessionID: string
  callID: string
  directory: string
  paths: string[]
  contents: Record<string, string>
  diagnostics: Record<string, LspDiagnostic[]>
}
type ToolResult = { metadata?: unknown }
type State = {
  sequence: number
  recentPaths: Map<string, string[]>
  activeDiagnostics: Map<string, Set<string>>
  presentations: Map<string, PendingPresentation[]>
  automatic: Map<string, PendingAutomatic[]>
  actions: Map<string, PendingAction[]>
  shadowLock: Semaphore.Semaphore
}
type PendingPresentation = {
  exposureID: string
  path: string
  fingerprint: string
  from: string
  to: string
}
type PendingAutomatic = {
  snapshot: ToolSnapshot
  requestID: string
  diagnostic: CanonicalDiagnostic
  capsule: ShadowCapsule
}
type PendingAction = { actionID: string; path: string }

type ShadowCapsule = {
  id: string
  rule_id: string
  text: string
  action: { type: "replace_symbol"; from: string; to: string }
  estimated_tokens: number
  confidence_basis_points: number
  utility_basis_points: number
  selection: { signals: { name: string; detail: string }[] }
}

export type RecallContextBlock = {
  source: "homemem"
  text: string
  estimatedTokens: number
  priority: number
}

export interface Interface {
  readonly beforeTool: (input: {
    tool: string
    args: Record<string, unknown>
    sessionID: string
    callID: string
  }) => Effect.Effect<ToolSnapshot>
  readonly dynamicContext: (input: { sessionID: string; tokenBudget: number }) => Effect.Effect<RecallContextBlock[]>
  readonly afterTool: (input: {
    tool: string
    args: Record<string, unknown>
    sessionID: string
    callID: string
    before: ToolSnapshot
    result: ToolResult
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@homecode/HomeMemAdapter") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const lsp = yield* LSP.Service
    const state = yield* InstanceState.make<State>(() =>
      Effect.succeed({
        sequence: Date.now() * 1_000,
        recentPaths: new Map(),
        activeDiagnostics: new Map(),
        presentations: new Map(),
        automatic: new Map(),
        actions: new Map(),
        shadowLock: Semaphore.makeUnsafe(1),
      }),
    )

    const write = Effect.fn("HomeMemAdapter.write")(function* (snapshot: ToolSnapshot, kinds: ObservationKind[]) {
      if (!snapshot.active || kinds.length === 0) return []
      const current = yield* InstanceState.get(state)
      const observations = kinds.map((kind) => {
        current.sequence++
        const occurred = Date.now()
        return {
          id: stableID("observation", snapshot.sessionID, snapshot.callID, String(current.sequence), kind.type),
          occurred_at_ms: occurred,
          sequence: current.sequence,
          stream: {
            producer: "homecode",
            workspace_id: snapshot.workspaceID,
            session_id: snapshot.sessionID,
          },
          correlation_id: snapshot.callID,
          kind,
        } satisfies Observation
      })
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(path.dirname(snapshot.trace), { recursive: true })
          await appendFile(snapshot.trace, observations.map((item) => JSON.stringify(item)).join("\n") + "\n")
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) => {
          log.warn("failed to record HomeMem observations", { cause })
          return Effect.void
        }),
      )
      return observations
    })

    const shadow = Effect.fn("HomeMemAdapter.shadow")(function* (
      snapshot: ToolSnapshot,
      request?: {
        package: string
        package_version: string
        diagnostic_fingerprint: string
        symbol: string
        token_budget: number
      },
      context?: { requestID: string; diagnostic: CanonicalDiagnostic; automatic: boolean },
    ) {
      if (!snapshot.active) return
      const current = yield* InstanceState.get(state)
      yield* current.shadowLock.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const [command, ...args] = snapshot.command
            if (!command) throw new Error("HomeMem engine command is empty")
            const stdout = await runHomeMemCommand(
              command,
              [...args, "shadow", "--database", snapshot.database, "--trace", snapshot.trace],
              request ? JSON.stringify(request) : "",
            )
            return JSON.parse(stdout) as unknown
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.tap((report) =>
            Effect.gen(function* () {
              if (!isRecord(report) || !isRecord(report.retrieval) || !Array.isArray(report.retrieval.capsules)) return
              const capsules = report.retrieval.capsules.filter(isShadowCapsule)
              capsules.forEach((capsule) =>
                log.info("HomeMem Recall Candidate", {
                  rule: capsule.text,
                  confidence: capsule.confidence_basis_points / 10_000,
                  utility: capsule.utility_basis_points / 10_000,
                  reason: capsule.selection.signals.map((signal) => `${signal.name}: ${signal.detail}`).join("; "),
                }),
              )
              if (!context) return
              if (context.automatic) {
                const automatic = current.automatic.get(snapshot.sessionID) ?? []
                current.automatic.set(snapshot.sessionID, automatic)
                automatic.push(
                  ...capsules.map((capsule) => ({
                    snapshot,
                    requestID: context.requestID,
                    diagnostic: context.diagnostic,
                    capsule,
                  })),
                )
                return
              }
              const presented = capsules.map((capsule) => ({
                capsule,
                exposureID: stableID("exposure", snapshot.sessionID, context.requestID, capsule.id),
                from: capsule.action.from,
                to: capsule.action.to,
              }))
              yield* write(
                snapshot,
                presented.map((item) => ({
                  type: "recall_presented",
                  exposure_id: item.exposureID,
                  request_id: context.requestID,
                  capsule_id: item.capsule.id,
                  rule_id: item.capsule.rule_id,
                  estimated_tokens: item.capsule.estimated_tokens,
                  channel: "shadow_log",
                })),
              )
              const pending = current.presentations.get(snapshot.sessionID) ?? []
              current.presentations.set(snapshot.sessionID, pending)
              pending.push(
                ...presented.map((item) => ({
                  exposureID: item.exposureID,
                  path: context.diagnostic.path,
                  fingerprint: context.diagnostic.fingerprint,
                  from: item.from,
                  to: item.to,
                })),
              )
            }),
          ),
          Effect.catch((cause) => {
            log.warn("HomeMem shadow process unavailable; trace recording continues", { cause })
            return Effect.void
          }),
        ),
      )
    })

    const recallDiagnostic = Effect.fn("HomeMemAdapter.recallDiagnostic")(function* (
      snapshot: ToolSnapshot,
      diagnostic: CanonicalDiagnostic,
      automatic: boolean,
      tokenBudget: number,
    ) {
      const requestID = stableID(
        "request",
        snapshot.sessionID,
        snapshot.callID,
        diagnostic.path,
        diagnostic.fingerprint,
      )
      const request = {
        package: diagnostic.package,
        package_version: diagnostic.package_version,
        diagnostic_fingerprint: diagnostic.fingerprint,
        symbol: diagnostic.symbol,
        token_budget: tokenBudget,
      }
      yield* write(snapshot, [{ type: "recall_requested", request_id: requestID, request }])
      yield* shadow(snapshot, request, { requestID, diagnostic, automatic })
    })

    const dynamicContext = Effect.fn("HomeMemAdapter.dynamicContext")(function* (input: {
      sessionID: string
      tokenBudget: number
    }) {
      if ((yield* config.get()).experimental?.homemem?.automatic !== true) return []
      const current = yield* InstanceState.get(state)
      const pending = current.automatic.get(input.sessionID) ?? []
      current.automatic.delete(input.sessionID)
      const selected = pending
        .toSorted(
          (left, right) =>
            right.capsule.utility_basis_points - left.capsule.utility_basis_points ||
            right.capsule.confidence_basis_points - left.capsule.confidence_basis_points ||
            left.capsule.id.localeCompare(right.capsule.id),
        )
        .reduce<{ items: PendingAutomatic[]; tokens: number }>(
          (result, item) => {
            if (result.tokens + item.capsule.estimated_tokens > input.tokenBudget) return result
            result.items.push(item)
            result.tokens += item.capsule.estimated_tokens
            return result
          },
          { items: [], tokens: 0 },
        ).items
      yield* Effect.forEach(
        selected,
        (item) => {
          const exposureID = stableID("exposure", item.snapshot.sessionID, item.requestID, item.capsule.id, "context")
          const presentations = current.presentations.get(input.sessionID) ?? []
          current.presentations.set(input.sessionID, presentations)
          presentations.push({
            exposureID,
            path: item.diagnostic.path,
            fingerprint: item.diagnostic.fingerprint,
            from: item.capsule.action.from,
            to: item.capsule.action.to,
          })
          return write(item.snapshot, [
            {
              type: "recall_injected",
              exposure_id: exposureID,
              request_id: item.requestID,
              capsule_id: item.capsule.id,
              rule_id: item.capsule.rule_id,
              estimated_tokens: item.capsule.estimated_tokens,
            },
          ])
        },
        { discard: true },
      )
      return selected.map((item) => ({
        source: "homemem" as const,
        text: item.capsule.text,
        estimatedTokens: item.capsule.estimated_tokens,
        priority: item.capsule.utility_basis_points * 10_000 + item.capsule.confidence_basis_points,
      }))
    })

    const beforeTool = Effect.fn("HomeMemAdapter.beforeTool")(function* (input: {
      tool: string
      args: Record<string, unknown>
      sessionID: string
      callID: string
    }) {
      const instance = yield* InstanceState.context
      const cfg = (yield* config.get()).experimental?.homemem
      const active = cfg?.enabled === true || cfg?.record === true
      const root = path.join(instance.worktree, ".homecode", "homemem")
      const snapshot: ToolSnapshot = {
        active,
        trace: path.join(root, "sessions", input.sessionID, "observations.jsonl"),
        database: cfg?.database ?? HomeMemConfig.defaultDatabase(),
        command: HomeMemConfig.resolve(cfg).command,
        workspaceID: stableID("workspace", instance.worktree),
        sessionID: input.sessionID,
        callID: input.callID,
        directory: instance.directory,
        paths: [],
        contents: {},
        diagnostics: {},
      }
      if (!active || !EDIT_TOOLS.has(input.tool)) return snapshot

      snapshot.paths = toolPaths(input.tool, input.args, instance.directory)
      snapshot.diagnostics = yield* lsp.diagnostics()
      snapshot.contents = Object.fromEntries(
        yield* Effect.forEach(snapshot.paths, (file) =>
          Effect.promise(
            async () => [file, await readTextOrEmpty(file)] as const,
          ),
        ),
      )
      const current = yield* InstanceState.get(state)
      const activeSet = current.activeDiagnostics.get(input.sessionID) ?? new Set<string>()
      current.activeDiagnostics.set(input.sessionID, activeSet)
      const diagnostics = (yield* Effect.forEach(
        snapshot.paths.flatMap((file) =>
          (snapshot.diagnostics[normalizePath(file)] ?? []).map((item) => ({ file, item })),
        ),
        ({ file, item }) =>
          resolveEnvironment(canonicalDiagnostic(file, item, snapshot.contents[file]), instance.worktree),
      )).filter((diagnostic) => !activeSet.has(diagnosticIdentity(diagnostic)))
      yield* write(
        snapshot,
        diagnostics.map((diagnostic) => ({ type: "diagnostic_observed", diagnostic })),
      )
      diagnostics.forEach((diagnostic) => activeSet.add(diagnosticIdentity(diagnostic)))
      if (cfg?.enabled === true) {
        yield* Effect.forEach(
          diagnostics,
          (diagnostic) => recallDiagnostic(snapshot, diagnostic, cfg.automatic === true, cfg.token_budget ?? 180),
          { discard: true },
        )
      }
      return snapshot
    })

    const afterTool = Effect.fn("HomeMemAdapter.afterTool")(function* (input: {
      tool: string
      args: Record<string, unknown>
      sessionID: string
      callID: string
      before: ToolSnapshot
      result: ToolResult
    }) {
      if (!input.before.active) return
      const cfg = (yield* config.get()).experimental?.homemem
      if (EDIT_TOOLS.has(input.tool)) {
        const diagnostics = resultDiagnostics(input.result)
        const paths = Array.from(new Set([...input.before.paths, ...resultPaths(input.result)]))
        const current = Object.fromEntries(
          yield* Effect.forEach(paths, (file) =>
            Effect.promise(
              async () => [file, await readTextOrEmpty(file)] as const,
            ),
          ),
        )
        const cleared = paths.flatMap((file) => {
          const after = diagnostics[normalizePath(file)] ?? []
          return (input.before.diagnostics[normalizePath(file)] ?? [])
            .filter((item) => !after.some((candidate) => diagnosticKey(candidate) === diagnosticKey(item)))
            .map((item) => ({
              file,
              item,
              diagnostic: canonicalDiagnostic(file, item, input.before.contents[file] ?? ""),
            }))
        })
        const instance = yield* InstanceState.context
        const appeared = yield* Effect.forEach(
          paths.flatMap((file) => {
            const before = input.before.diagnostics[normalizePath(file)] ?? []
            return (diagnostics[normalizePath(file)] ?? [])
              .filter((item) => !before.some((candidate) => diagnosticKey(candidate) === diagnosticKey(item)))
              .map((item) => ({ file, item }))
          }),
          ({ file, item }) =>
            resolveEnvironment(canonicalDiagnostic(file, item, current[file] ?? ""), instance.worktree),
        )
        const kinds: ObservationKind[] = paths.flatMap((file) => {
          const relevant = cleared.filter((item) => item.file === file)
          if (relevant.length === 0) return []
          return [
            {
              type: "file_edited" as const,
              edit: {
                path: normalizePath(file),
                before_hash: hash(input.before.contents[file] ?? ""),
                after_hash: hash(current[file] ?? ""),
                replacements: relevant.flatMap((item) => {
                  const to = replacementAt(
                    item.item.range.start,
                    input.before.contents[file] ?? "",
                    current[file] ?? "",
                  )
                  if (!item.diagnostic.symbol || !to || to === item.diagnostic.symbol) return []
                  return [{ from: item.diagnostic.symbol, to, range: item.diagnostic.range }]
                }),
              },
            },
            ...relevant.map((item) => ({
              type: "diagnostic_cleared" as const,
              fingerprint: item.diagnostic.fingerprint,
              path: item.diagnostic.path,
            })),
          ]
        })
        const currentState = yield* InstanceState.get(state)
        const active = currentState.activeDiagnostics.get(input.sessionID) ?? new Set<string>()
        currentState.activeDiagnostics.set(input.sessionID, active)
        const fresh = appeared.filter((diagnostic) => !active.has(diagnosticIdentity(diagnostic)))
        yield* write(input.before, [
          ...kinds,
          ...fresh.map((diagnostic) => ({ type: "diagnostic_observed" as const, diagnostic })),
        ])
        cleared.forEach((item) => active.delete(diagnosticIdentity(item.diagnostic)))
        fresh.forEach((diagnostic) => active.add(diagnosticIdentity(diagnostic)))
        if (paths.length > 0) currentState.recentPaths.set(input.sessionID, paths.map(normalizePath))
        const presentations = currentState.presentations.get(input.sessionID) ?? []
        const resolved = presentations.filter((presentation) =>
          cleared.some(
            (item) =>
              item.diagnostic.path === presentation.path && item.diagnostic.fingerprint === presentation.fingerprint,
          ),
        )
        yield* write(
          input.before,
          resolved.map((presentation) => {
            const applied = kinds.some(
              (kind) =>
                kind.type === "file_edited" &&
                kind.edit.path === presentation.path &&
                kind.edit.replacements.some(
                  (replacement) => replacement.from === presentation.from && replacement.to === presentation.to,
                ),
            )
            const actionID = stableID("action", input.sessionID, input.callID, presentation.exposureID)
            if (applied) {
              const actions = currentState.actions.get(input.sessionID) ?? []
              currentState.actions.set(input.sessionID, actions)
              actions.push({ actionID, path: presentation.path })
            }
            return {
              type: "host_action_observed" as const,
              exposure_id: presentation.exposureID,
              action_id: actionID,
              disposition: applied ? ("applied" as const) : ("ignored" as const),
            }
          }),
        )
        currentState.presentations.set(
          input.sessionID,
          presentations.filter((presentation) => !resolved.includes(presentation)),
        )
        if (cfg?.enabled === true) {
          yield* Effect.forEach(
            fresh,
            (diagnostic) => recallDiagnostic(input.before, diagnostic, cfg.automatic === true, cfg.token_budget ?? 180),
            { discard: true },
          )
          yield* shadow(input.before).pipe(Effect.forkDetach)
        }
        return
      }

      if (input.tool !== "shell" || !isRecord(input.result.metadata)) return
      if (!isTestCommand(input.args.command) || typeof input.result.metadata.exit !== "number") return
      const currentState = yield* InstanceState.get(state)
      const relatedPaths = currentState.recentPaths.get(input.sessionID) ?? []
      const passed = input.result.metadata.exit === 0
      const actions = currentState.actions.get(input.sessionID) ?? []
      const resolved = actions.filter((action) => relatedPaths.includes(action.path))
      yield* write(input.before, [
        {
          type: "test_completed",
          command: input.args.command,
          passed,
          related_paths: relatedPaths,
        },
        ...resolved.map((action) => ({
          type: "outcome_observed" as const,
          action_id: action.actionID,
          outcome: passed ? ("successful" as const) : ("failed" as const),
        })),
      ])
      currentState.actions.set(
        input.sessionID,
        actions.filter((action) => !resolved.includes(action)),
      )
      if (cfg?.enabled === true) yield* shadow(input.before).pipe(Effect.forkDetach)
    })

    return Service.of({ beforeTool, dynamicContext, afterTool })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(LSP.defaultLayer))

export function isTestCommand(command: unknown): command is string {
  return typeof command === "string" && TEST_COMMAND.test(command.trim())
}

export function canonicalDiagnostic(file: string, diagnostic: LspDiagnostic, content = ""): CanonicalDiagnostic {
  const source = diagnostic.source?.trim() || "lsp"
  const code = diagnostic.code
  return {
    fingerprint: stableID(
      "diagnostic",
      source,
      String(code ?? "unknown"),
      diagnostic.message.replaceAll(/\s+/g, " ").trim(),
    ),
    message: diagnostic.message,
    path: normalizePath(file),
    range: { start: diagnostic.range.start.line, end: diagnostic.range.end.line },
    package: source,
    package_version: "unknown",
    symbol: symbolAt(diagnostic.range.start, diagnostic.range.end, content),
  }
}

const resolveEnvironment = Effect.fn("HomeMemAdapter.resolveEnvironment")(function* (
  diagnostic: CanonicalDiagnostic,
  worktree: string,
) {
  const packages = diagnostic.package === "ts" ? ["typescript"] : [diagnostic.package]
  const resolved = (yield* Effect.forEach(packages, (name) =>
    Effect.tryPromise({
      try: async () => {
        const info: unknown = JSON.parse(await readFile(path.join(worktree, "node_modules", name, "package.json"), "utf8"))
        if (!isRecord(info) || typeof info.version !== "string") return undefined
        return { name, version: info.version }
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined))),
  )).find((item) => item !== undefined)
  if (!resolved) return diagnostic
  return { ...diagnostic, package: resolved.name, package_version: resolved.version }
})

function toolPaths(tool: string, args: Record<string, unknown>, directory: string) {
  if ((tool === "edit" || tool === "write") && typeof args.filePath === "string") {
    return [path.isAbsolute(args.filePath) ? args.filePath : path.join(directory, args.filePath)]
  }
  if (tool !== "apply_patch" || typeof args.patchText !== "string") return []
  return Array.from(args.patchText.matchAll(/^\*\*\* (?:Update|Delete) File: (.+)$/gm), (match) =>
    path.resolve(directory, match[1]),
  )
}

function resultPaths(result: ToolResult) {
  if (!isRecord(result.metadata)) return []
  const direct = typeof result.metadata.filepath === "string" ? [result.metadata.filepath] : []
  if (!Array.isArray(result.metadata.files)) return direct
  return [
    ...direct,
    ...result.metadata.files.flatMap((file) =>
      isRecord(file) && typeof file.filePath === "string" ? [file.filePath] : [],
    ),
  ]
}

function resultDiagnostics(result: ToolResult): Record<string, LspDiagnostic[]> {
  if (!isRecord(result.metadata) || !isRecord(result.metadata.diagnostics)) return {}
  return Object.fromEntries(
    Object.entries(result.metadata.diagnostics).filter((entry): entry is [string, LspDiagnostic[]] =>
      Array.isArray(entry[1]),
    ),
  )
}

function diagnosticIdentity(diagnostic: CanonicalDiagnostic) {
  return `${diagnostic.path}\u001f${diagnostic.fingerprint}`
}

function diagnosticKey(diagnostic: LspDiagnostic) {
  return JSON.stringify({
    code: diagnostic.code,
    message: diagnostic.message,
    source: diagnostic.source,
    range: diagnostic.range,
  })
}

function symbolAt(start: Position, end: Position, content: string) {
  if (start.line !== end.line) return ""
  return content.split(/\r?\n/)[start.line]?.slice(start.character, end.character).trim() ?? ""
}

function replacementAt(position: Position, before: string, after: string) {
  const oldLine = before.split(/\r?\n/)[position.line] ?? ""
  const newLine = after.split(/\r?\n/)[position.line] ?? ""
  const oldToken = tokenAt(oldLine, position.character)
  const newToken = tokenAt(newLine, position.character)
  if (oldToken && newToken && oldToken !== newToken) return newToken
  const oldTokens = oldLine.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? []
  const newTokens = newLine.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? []
  return newTokens.find((token, index) => token !== oldTokens[index]) ?? ""
}

function tokenAt(line: string, character: number) {
  return Array.from(line.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)).find(
    (match) => match.index <= character && match.index + match[0].length >= character,
  )?.[0]
}

function isShadowCapsule(value: unknown): value is ShadowCapsule {
  if (!isRecord(value) || !isRecord(value.selection) || !Array.isArray(value.selection.signals)) return false
  return (
    typeof value.id === "string" &&
    typeof value.rule_id === "string" &&
    typeof value.text === "string" &&
    isRecord(value.action) &&
    value.action.type === "replace_symbol" &&
    typeof value.action.from === "string" &&
    typeof value.action.to === "string" &&
    typeof value.estimated_tokens === "number" &&
    typeof value.confidence_basis_points === "number" &&
    typeof value.utility_basis_points === "number" &&
    value.selection.signals.every(
      (signal) => isRecord(signal) && typeof signal.name === "string" && typeof signal.detail === "string",
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizePath(value: string) {
  return path.resolve(value).replaceAll("\\", "/")
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function stableID(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("\u001f")).digest("hex")}`
}

function readTextOrEmpty(file: string) {
  return readFile(file, "utf8").catch((cause) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return ""
    throw cause
  })
}

function runHomeMemCommand(command: string, args: string[], input: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.once("error", reject)
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `HomeMem exited with status ${code}`))
      resolve(stdout)
    })
    child.stdin?.end(input)
  })
}
