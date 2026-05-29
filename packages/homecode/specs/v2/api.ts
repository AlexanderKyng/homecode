// @ts-nocheck

import { HomeCode } from "@homecode-ai/core"
import { ReadTool } from "@homecode-ai/core/tools"

const homecode = HomeCode.make({})

homecode.tool.add(ReadTool)

homecode.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

homecode.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

homecode.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await homecode.session.create({
  agent: "build",
})

homecode.subscribe((event) => {
  console.log(event)
})

await homecode.session.prompt({
  sessionID,
  text: "hey what is up",
})

await homecode.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await homecode.session.wait()

console.log(await homecode.session.messages(sessionID))
