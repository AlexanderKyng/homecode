export * as ConfigToolFormat from "./tool-format"

import { Schema } from "effect"

export const ToolFormat = Schema.Literals(["atem", "hermes", "json", "xml"])
export type ToolFormat = Schema.Schema.Type<typeof ToolFormat>
