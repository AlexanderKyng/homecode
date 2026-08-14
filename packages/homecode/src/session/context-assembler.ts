import type { ModelMessage } from "ai"

export type DynamicContextBlock = {
  source: "homemem" | "homesitter"
  text: string
  estimatedTokens: number
  priority: number
}

export function assemble(input: { messages: ModelMessage[]; blocks: DynamicContextBlock[]; tokenBudget: number }) {
  const selected = input.blocks
    .toSorted(
      (left, right) =>
        right.priority - left.priority ||
        left.source.localeCompare(right.source) ||
        left.text.localeCompare(right.text),
    )
    .reduce<{ blocks: DynamicContextBlock[]; tokens: number }>(
      (result, block) => {
        if (result.tokens + block.estimatedTokens > input.tokenBudget) return result
        result.blocks.push(block)
        result.tokens += block.estimatedTokens
        return result
      },
      { blocks: [], tokens: 0 },
    )
  if (selected.blocks.length === 0) return input.messages

  const sources = [...new Set(selected.blocks.map((block) => block.source))].sort((left, right) =>
    left.localeCompare(right),
  )
  const multipleSources = sources.length > 1
  const text = [
    `<dynamic_context source="${sources.join(",")}">`,
    ...(multipleSources
      ? ["Relevant deterministic context evidence:"]
      : ["Relevant evidence-derived Recall Capsules:"]),
    ...selected.blocks.map((block) => `${multipleSources ? `[${block.source}] ` : "- "}${block.text}`),
    "</dynamic_context>",
  ].join("\n")
  const index = input.messages.findLastIndex((message) => message.role === "user")
  if (index === -1) return [...input.messages, { role: "user" as const, content: text }]

  return input.messages.map((message, current) => {
    if (current !== index || message.role !== "user") return message
    if (typeof message.content === "string") return { ...message, content: `${message.content}\n\n${text}` }
    return { ...message, content: [...message.content, { type: "text" as const, text }] }
  })
}
