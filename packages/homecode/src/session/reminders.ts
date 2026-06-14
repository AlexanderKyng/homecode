import path from "path"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { AppFileSystem } from "@homecode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  if (input.agent.name !== "plan") return input.messages

  const fsys = yield* AppFileSystem.Service
  const ctx = yield* InstanceState.context
  const planPath = Session.plan(input.session, ctx)
  yield* fsys.ensureDir(path.dirname(planPath)).pipe(Effect.catch(Effect.die))

  return input.messages
})

export * as SessionReminders from "./reminders"
