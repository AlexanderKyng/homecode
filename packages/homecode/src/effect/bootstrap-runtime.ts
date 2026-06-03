import { Layer, ManagedRuntime } from "effect"

import * as EffectLogger from "@homecode-ai/core/effect/logger"
import { Plugin } from "@/plugin"
import { LSP } from "@/lsp/lsp"
import { FileWatcher } from "@/file/watcher"
import { Format } from "@/format"
import { ShareNext } from "@/share/share-next"
import { File } from "@/file"
import { Vcs } from "@/project/vcs"
import { Snapshot } from "@/snapshot"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { memoMap } from "@homecode-ai/core/effect/memo-map"

export const BootstrapLayer = Layer.mergeAll(
  Config.defaultLayer,
  Plugin.defaultLayer,
  ShareNext.defaultLayer,
  Format.defaultLayer,
  LSP.defaultLayer,
  File.defaultLayer,
  FileWatcher.defaultLayer,
  Vcs.defaultLayer,
  Snapshot.defaultLayer,
  Bus.defaultLayer,
)

export const BootstrapRuntime = ManagedRuntime.make(Layer.provideMerge(BootstrapLayer, EffectLogger.layer), { memoMap })
