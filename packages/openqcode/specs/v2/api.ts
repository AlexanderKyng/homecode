// @ts-nocheck

import { OpenQCode } from "@openqcode-ai/core"
import { ReadTool } from "@openqcode-ai/core/tools"

const openqcode = OpenQCode.make({})

openqcode.tool.add(ReadTool)

openqcode.tool.add({
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

openqcode.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

openqcode.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await openqcode.session.create({
  agent: "build",
})

openqcode.subscribe((event) => {
  console.log(event)
})

await openqcode.session.prompt({
  sessionID,
  text: "hey what is up",
})

await openqcode.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await openqcode.session.wait()

console.log(await openqcode.session.messages(sessionID))
