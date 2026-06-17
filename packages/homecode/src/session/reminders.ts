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

  // Remove stale plan mode reminders when the agent is no longer "plan".
  // Only strip from the last user message to preserve KV cache prefix stability
  // in prior messages that are already cached by the LLM server.
  if (agentName !== "plan") {
    const parts = userMessage.parts.filter((p) => {
      if (p.type !== "text" || !p.synthetic) return true
      return !p.text.includes("Plan mode active")
    })
    userMessage.parts.length = 0
    userMessage.parts.push(...parts)

    yield* addSynthetic(BUILD_MODE)
    return input.messages
  }

  // Plan mode: remove stale build mode reminders only from the last user message.
  const parts = userMessage.parts.filter((p) => {
    if (p.type !== "text" || !p.synthetic) return true
    return !p.text.includes("Build mode active")
  })
  userMessage.parts.length = 0
  userMessage.parts.push(...parts)

  // Plan mode: inject plan mode reminder with tool restrictions.
  const planPath = Session.plan(input.session, ctx)
  const plan = path.relative(ctx.worktree, planPath)
  const exists = yield* fsys.existsSafe(planPath)
  if (!exists) yield* fsys.ensureDir(path.dirname(planPath)).pipe(Effect.catch(Effect.die))
  const text = PLAN_MODE.replace("${planInfo}", () =>
    exists
      ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
      : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
  )
  yield* addSynthetic(text)
  return input.messages
})

export * as SessionReminders from "./reminders"
