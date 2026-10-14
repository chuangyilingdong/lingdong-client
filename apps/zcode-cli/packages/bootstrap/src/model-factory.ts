// Model factory - creates model adapter with config

import {
  AiSdkModelAdapter,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "@zcode/adapters/model";
import type { Logger, ModelStatusSink } from "@zcode/contracts";

interface CreateModelAdapterBaseOptions {
  env?: EnvRecord;
  logger?: Logger;
  modelIoDir?: string;
  modelIoFullRetentionEnabled?: boolean;
  streamIdleTimeoutMs?: number;
  statusSink?: ModelStatusSink;
  resolveProviderApiKey?: (providerId: string) => string | undefined;
  refreshProviderRegistry?: (reason: string) => Promise<void>;
}

export type CreateModelAdapterOptions = CreateModelAdapterBaseOptions & {
  executionConfig: AiSdkModelExecutionConfig;
};

export function createModelAdapter(options: CreateModelAdapterOptions): AiSdkModelAdapter {
  if (!options.executionConfig) {
    throw new Error("createModelAdapter requires executionConfig");
  }
  return new AiSdkModelAdapter({
    ...options.executionConfig,
    debugDir: options.modelIoDir,
    env: options.env,
    logger: options.logger,
    modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    statusSink: options.statusSink,
    ...(options.resolveProviderApiKey
      ? { resolveProviderApiKey: options.resolveProviderApiKey }
      : {}),
    ...(options.refreshProviderRegistry
      ? { refreshProviderRegistry: options.refreshProviderRegistry }
      : {}),
  });
}
