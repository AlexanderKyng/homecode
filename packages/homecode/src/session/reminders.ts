import path from "path"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { AppFileSystem } from "@homecode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* AppFileSystem.Service
  const sessions = yield* Session.Service
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

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") yield* addSynthetic(PROMPT_PLAN)
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") yield* addSynthetic(BUILD_SWITCH)
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const text = exists
      ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
      : BUILD_SWITCH
    yield* addSynthetic(text)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const text = PLAN_MODE.replace("${planInfo}", () =>
    exists
      ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
      : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
  )
  yield* addSynthetic(text)
  return input.messages
})

export * as SessionReminders from "./reminders"
