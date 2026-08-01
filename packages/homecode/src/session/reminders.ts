import path from "path"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { AppFileSystem } from "@homecode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import PLAN_MODE from "./prompt/plan-mode.txt"
import BUILD_MODE from "./prompt/build-mode.txt"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const agentName = input.agent.name
  const fsys = yield* AppFileSystem.Service
  const sessions = yield* Session.Service
  const ctx = yield* InstanceState.context
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // Check if a synthetic text part with the given content already exists.
  // This prevents duplicate injection when messages are reloaded from DB
  // and ensures KV cache stability across turns.
  const hasSyntheticText = (text: string) =>
    userMessage.parts.some((p) => p.type === "text" && p.synthetic && p.text === text)

  // Persist synthetic parts to the database so they are stable across turns.
  // Without persistence, synthetic parts are added in-memory each turn but
  // may differ if conditions change, causing KV cache prefix mismatches.
  const addSynthetic = (text: string) => {
    if (hasSyntheticText(text)) return Effect.void
    return Effect.gen(function* () {
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text" as const,
        text,
        synthetic: true,
      })
      userMessage.parts.push(part)
    })
  }

  // Remove stale mode reminders from both in-memory and DB.
  // Only strip from the last user message to preserve KV cache prefix stability
  // in prior messages that are already cached by the LLM server.
  const removeModeReminders = (marker: string) => {
    return Effect.gen(function* () {
      for (const p of userMessage.parts) {
        if (p.type !== "text" || !p.synthetic || !p.text.includes(marker)) continue
        yield* sessions.removePart({
          sessionID: userMessage.info.sessionID,
          messageID: userMessage.info.id,
          partID: p.id,
        })
      }
      // Also remove from in-memory array to keep it consistent with DB.
      const parts = userMessage.parts.filter((p) => {
        if (p.type !== "text" || !p.synthetic) return true
        return !p.text.includes(marker)
      })
      userMessage.parts.length = 0
      userMessage.parts.push(...parts)
    })
  }

  // Build mode: remove stale plan mode reminders, inject build mode.
  if (agentName !== "plan") {
    yield* removeModeReminders("Plan mode active")
    yield* addSynthetic(BUILD_MODE)
    return input.messages
  }

  // Plan mode: remove stale build mode reminders, then ensure plan reminder is present.
  yield* removeModeReminders("Build mode active")

  // Inject stable plan mode reminder first. This part never changes within a session,
  // ensuring KV cache prefix stability across tool-call turns.
  yield* addSynthetic(PLAN_MODE)

  // Inject dynamic plan file state as a separate synthetic part at the end.
  // This part may change (file created/deleted during tools) but is placed after
  // the stable reminder so it doesn't break cache prefix for earlier content.
  const planPath = Session.plan(input.session, ctx)
  const baseDir = ctx.worktree === "/" ? ctx.directory : ctx.worktree
  const plan = path.relative(baseDir, planPath)
  const exists = yield* fsys.existsSafe(planPath)
  if (!exists) yield* fsys.ensureDir(path.dirname(planPath)).pipe(Effect.catch(Effect.die))

  const planStateText = exists
    ? `[Plan file: exists at ${plan}. You can read it and make incremental edits using the edit tool.]`
    : `[Plan file: not yet created at ${plan}. You should create your plan there using the write tool.]`

  // Remove old plan state part if it exists (content may have changed)
  const existingPlanState = userMessage.parts.find(
    (p) => p.type === "text" && p.synthetic && p.text.startsWith("[Plan file:"),
  ) as MessageV2.TextPart | undefined
  if (existingPlanState) return input.messages

  yield* addSynthetic(planStateText)
  return input.messages
})

export * as SessionReminders from "./reminders"
