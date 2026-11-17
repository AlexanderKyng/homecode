import { createHmac, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  readGlobalConfig,
  resolveEmbeddingRuntimeOptions,
  type EmbeddingRuntimeConfig,
} from "../config.js";
import {
  createEmbeddingModel,
  EmbeddingPurpose,
  getEmbeddingModelCatalogEntry,
  normalizeLocalEmbeddingConcurrency,
  resolveIndexEmbeddingConcurrencyOverride,
  type CreateEmbeddingModelOptions,
  type EmbeddingModel,
  type EmbeddingModelInfo,
} from "../models/index.js";
import { remoteEmbeddingAuthorizationGuard } from "../../authorization/operation.js";
import { RemoteEmbeddingAuthorizationStore } from "../../authorization/store.js";
import type { CreateHomeGrepOptions } from "./types.js";
import { defaultHome } from "../utils/path.js";

export type EmbeddingModelIdentity = Pick<
  EmbeddingModelInfo,
  "provider" | "name"
>;

const API_KEY_IDENTITY_SECRET = randomBytes(32);

export function createEmbeddingModelForIdentity(
  identity: EmbeddingModelIdentity,
  options: CreateHomeGrepOptions = {},
  workspaceRuntime: EmbeddingRuntimeConfig = {},
): EmbeddingModel {
  const reference = `${identity.provider}/${identity.name}`;
  const modelOptions = providerOptions(options, identity, workspaceRuntime);
  const model = createEmbeddingModel(reference, modelOptions);
  if (model.info.provider !== "qwen") return model;

  const endpoint = model.info.endpoint;
  if (!endpoint)
    throw new Error("Remote embedding model did not provide an endpoint");
  const authorize = remoteEmbeddingAuthorizationGuard({
    store: new RemoteEmbeddingAuthorizationStore({
      signingKeyPath: options.authorizationSigningKeyPath,
    }),
  });
  return {
    info: model.info,
    async embed(contents, embedOptions) {
      await authorize({
        provider: model.info.provider,
        model: model.info.name,
        endpoint,
        purpose: embedOptions?.purpose ?? EmbeddingPurpose.Document,
        contentKinds: contents.map((content) => content.kind),
        contentCount: contents.length,
      });
      return model.embed(contents, embedOptions);
    },
    dispose: () => model.dispose(),
  };
}

export function embeddingModelPoolKeyForIdentity(
  identity: EmbeddingModelIdentity,
  options: CreateHomeGrepOptions = {},
  workspaceRuntime: EmbeddingRuntimeConfig = {},
): string {
  const reference = `${identity.provider}/${identity.name}`;
  return `${reference}/${fingerprint(providerOptions(options, identity, workspaceRuntime))}`;
}

export function resolveIndexEmbeddingConcurrency(
  identity: EmbeddingModelIdentity,
  requested?: number,
): number | undefined {
  const backend = getEmbeddingModelCatalogEntry(
    `${identity.provider}/${identity.name}`,
  )?.backend;
  return resolveIndexEmbeddingConcurrencyOverride({
    embeddingConcurrency: requested,
    legacyLlama: backend === "llama-cpp",
  });
}

function providerOptions(
  options: CreateHomeGrepOptions,
  identity: EmbeddingModelIdentity,
  workspaceRuntime: EmbeddingRuntimeConfig,
): CreateEmbeddingModelOptions {
  const reference = `${identity.provider}/${identity.name}`;
  const backend = getEmbeddingModelCatalogEntry(reference)?.backend;
  const concurrency =
    backend === "llama-cpp" || backend === "transformers-js"
      ? normalizeLocalEmbeddingConcurrency(options.embeddingConcurrency)
      : undefined;
  const runtime = resolveEmbeddingRuntimeOptions(
    reference,
    options,
    workspaceRuntime,
    readGlobalConfig(),
  );
  const config = readGlobalConfig();
  return {
    apiKey: runtime.apiKey,
    endpoint: runtime.endpoint,
    modelCacheDir:
      options.modelCacheDir ??
      config.defaults?.modelCacheDir ??
      process.env.ZVEC_GREP_MODEL_CACHE ??
      join(options.home ?? defaultHome(), "models"),
    device: runtime.device,
    ...(concurrency !== undefined ? { embeddingConcurrency: concurrency } : {}),
  };
}

function fingerprint(options: CreateEmbeddingModelOptions): string {
  const apiKey = typeof options.apiKey === "string" ? options.apiKey : "";
  const publicFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        options.endpoint,
        options.modelCacheDir,
        options.device,
        options.embeddingConcurrency,
      ]),
    )
    .digest("hex");
  const secretFingerprint = createHmac("sha256", API_KEY_IDENTITY_SECRET)
    .update(apiKey)
    .digest("hex");
  return `${secretFingerprint}:${publicFingerprint}`;
}
