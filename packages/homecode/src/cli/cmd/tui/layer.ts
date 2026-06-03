import { Layer } from "effect"
import { TuiConfig } from "./config/tui"
import { Npm } from "@homecode-ai/core/npm"

export const CliLayer = TuiConfig.layer.pipe(Layer.provide(Npm.defaultLayer))
