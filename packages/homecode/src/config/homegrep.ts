export * as ConfigHomeGrep from "./homegrep"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable HomeGrep as HomeCode's default code and workspace content search backend",
  }),
}).annotate({ identifier: "HomeGrepConfig" })

export type Info = Schema.Schema.Type<typeof Info>
