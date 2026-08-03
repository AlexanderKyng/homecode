import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import { AppFileSystem } from "@homecode-ai/core/filesystem"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import ENTER_DESCRIPTION from "./plan-enter.txt"

export function todosFromPlan(plan: string): Todo.Info[] {
  const lines = plan.split("\n")
  const todoStart = lines.findIndex((line) => /^\s{0,3}#{2,}\s+TODO\s*#*\s*$/i.test(line))
  if (todoStart === -1) return []
  const nextSection = lines.slice(todoStart + 1).findIndex((line) => /^\s{0,3}#{1,2}\s+/.test(line))
  const todoLines = nextSection === -1 ? lines.slice(todoStart + 1) : lines.slice(todoStart + 1, todoStart + 1 + nextSection)

  return todoLines.flatMap((line) => {
    const match = line.match(/^\s*[-*+]\s+\[ \]\s+(.+?)\s*$/)
    if (!match?.[1]) return []
    return [{ content: match[1], status: "pending", priority: "medium" }]
  })
}

export const Parameters = Schema.Struct({
  plan: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((plan) =>
        todosFromPlan(plan).length > 0
          ? undefined
          : "The plan must include at least one Markdown task-list item under a ## TODO heading",
      ),
    ),
  ).annotate({
    description:
      "The complete implementation plan in Markdown. Include a ## TODO section with one - [ ] actionable item per implementation task.",
  }),
  summary: Schema.NonEmptyArray(Schema.String).annotate({
    description: "A short, user-facing bullet-point summary of the plan. Include brief context when needed.",
  }),
})

const EnterParameters = Schema.Struct({})

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const todo = yield* Todo.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const fs = yield* AppFileSystem.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const planPath = Session.plan(info, instance)
          const baseDir = instance.worktree === "/" ? instance.directory : instance.worktree
          const plan = path.relative(baseDir, planPath)
          yield* fs.writeWithDirs(planPath, params.plan)

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Plan ready:\n\n${params.summary.map((item) => `- ${item}`).join("\n")}\n\nWould you like to start implementing it?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Accept", description: "Switch to build agent and start implementing the plan" },
                  { label: "Reject", description: "Stay in plan mode and replace the plan" },
                  { label: "Keep talking", description: "Stay in plan mode and continue discussing the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] !== "Accept") yield* new Question.RejectedError()

          yield* todo.update({ sessionID: ctx.sessionID, todos: todosFromPlan(params.plan) })

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const modelRef =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          // Switch agent by creating a synthetic user message with the new agent field
          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: modelRef,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text" as const,
            text: "The plan has been approved. Proceed with implementation.",
            synthetic: true,
          })

          return {
            title: "Switching to build agent",
            output: `User approved switching to build agent. Saved the plan to ${plan} and initialized ${todosFromPlan(params.plan).length} todos.`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const PlanEnterTool = Tool.define(
  "plan_enter",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service

    return {
      description: ENTER_DESCRIPTION,
      parameters: EnterParameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: "Would you like to switch to the plan agent to plan before implementing?",
                header: "Plan Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to plan agent to create a plan first" },
                  { label: "No", description: "Stay with build agent and continue implementing" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] === "No") yield* new Question.RejectedError()

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const modelRef =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          // Switch agent by creating a synthetic user message with the new agent field
          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "plan",
            model: modelRef,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text" as const,
            text: "The user has requested to switch to plan mode.",
            synthetic: true,
          })

          return {
            title: "Switching to plan agent",
            output: "User approved switching to plan agent. Wait for further instructions.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
