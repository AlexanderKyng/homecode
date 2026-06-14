import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import { AppFileSystem } from "@homecode-ai/core/filesystem"
import EXIT_DESCRIPTION from "./plan-exit.txt"
import ENTER_DESCRIPTION from "./plan-enter.txt"

export const Parameters = Schema.Struct({})

// Extract the plan-summary block from the last assistant message
function extractSummary(messages: MessageV2.WithParts[]): string {
  const lastAssistant = messages.findLast((m) => m.info.role === "assistant")
  if (!lastAssistant) return ""
  const textParts = lastAssistant.parts
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
  const text = textParts.join("\n")
  const match = text.match(/```plan-summary\s*\n([\s\S]*?)\n```/)
  return match ? match[1].trim() : ""
}

// Extract the text from the initial user prompt (first user message)
function extractInitialPrompt(messages: MessageV2.WithParts[]): string {
  const firstUser = messages.find((m) => m.info.role === "user" && m.info.model)
  if (!firstUser) return ""
  const textParts = firstUser.parts
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
  return textParts.join("\n")
}

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const fsys = yield* AppFileSystem.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const planPath = Session.plan(info, instance)
          const plan = path.relative(instance.worktree, planPath)

          const planContent = yield* fsys.readFileStringSafe(planPath).pipe(Effect.catch(() => Effect.succeed("")))

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
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

          // Extract the plan summary from the last assistant message
          const summary = extractSummary(messages)

          // Extract the initial user prompt
          const initialPrompt = extractInitialPrompt(messages)

          // Create synthetic user message for build agent with initial prompt, summary, and plan
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
            type: "text",
            text: `<initial-prompt>\n${initialPrompt}\n</initial-prompt>\n\n<plan-summary>\n${summary}\n</plan-summary>\n\n<plan-content>\n${planContent}\n</plan-content>\n\nThe plan has been approved. Execute the plan.`,
            synthetic: true,
          } satisfies MessageV2.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
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
      parameters: Parameters,
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

          // Create synthetic user message for plan agent
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
            type: "text",
            text: "Please create a plan for the remaining work before proceeding.",
            synthetic: true,
          } satisfies MessageV2.TextPart)

          return {
            title: "Switching to plan agent",
            output: "User approved switching to plan agent. Wait for further instructions.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
