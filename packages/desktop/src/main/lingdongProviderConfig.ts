import {
  decodeProviderConfigFile,
  NodePersonalProviderConfigRepository,
} from "@zcode/provider-node";
import type { ModelSelection } from "@zcode/shared/model-selection";

export const LINGDONG_PROVIDER_ID = "lingdong-platform-gateway";
export interface LingdongProviderContext {
  readonly gateway?: { readonly baseUrl?: string; readonly key?: string };
  readonly models?: readonly { readonly id?: unknown; readonly displayName?: unknown }[];
  readonly defaultModel?: unknown;
}

/** Main 只写平台条目；Personal 文件的 schema、排他锁和原子提交复用配置仓库。 */
export function createLingdongProviderBinding(filePath: string) {
  const repository = new NodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
  });
  let previousSelection: ModelSelection | undefined;
  let installed = false;
  let disposed = false;
  let lastKey: string | undefined;
  let pending: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.then(operation);
    // 失败不会阻断下一次显式重试；原始调用仍返回 rejected，不能把保存失败当成功。
    pending = next.catch(() => undefined);
    return next;
  }

  async function apply(context: LingdongProviderContext): Promise<void> {
    if (disposed) throw new Error("课堂 Provider 已释放。");
    const baseUrl = context.gateway?.baseUrl?.trim();
    const key = context.gateway?.key?.trim();
    if (!baseUrl || !key) throw new Error("平台没有下发完整的模型网关配置。");
    const ids = [
      ...new Set(
        (context.models ?? []).map((item) => String(item.id ?? "").trim()).filter(Boolean),
      ),
    ];
    if (!ids.length) throw new Error("平台没有下发可用的课堂模型。");
    const requested = typeof context.defaultModel === "string" ? context.defaultModel.trim() : "";
    const modelId = ids.includes(requested) ? requested : ids[0]!;
    // 与 Host/Agent 相同的公开 codec 先验证，避免只写出看似合法、运行时却无法读取的 JSON。
    const platform = decodeProviderConfigFile({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: LINGDONG_PROVIDER_ID,
              providerName: "灵动ai 平台网关",
              config: {
                group: "standard-personal",
                personalModelIds: ids,
                access: { type: "api-key", apiKey: key },
                api: { type: "openai-chat-completions", baseUrl },
                visibility: "visible",
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: ids.map((id) => ({
            providerId: LINGDONG_PROVIDER_ID,
            modelId: id,
            config: { enabled: true },
          })),
          manualProviderModelRules: [],
        },
        defaultModelSelection: { providerId: LINGDONG_PROVIDER_ID, modelId },
      },
    });
    await enqueue(async () => {
      await repository.update((current) => {
        if (!installed && current.defaultModelSelection?.providerId !== LINGDONG_PROVIDER_ID) {
          previousSelection = current.defaultModelSelection;
        }
        const remainingModels = current.models
          .deleteExactForProvider(LINGDONG_PROVIDER_ID)
          .toPersonalJSON();
        const mergedModels = decodeProviderConfigFile({
          schemaVersion: 1,
          config: {
            providerConfigRules: { providerRules: [] },
            modelConfigRules: {
              providerModelRules: [
                ...remainingModels.providerModelRules,
                ...platform.models.toPersonalJSON().providerModelRules,
              ],
              manualProviderModelRules: remainingModels.manualProviderModelRules,
            },
          },
        }).models;
        return {
          providers: current.providers.delete(LINGDONG_PROVIDER_ID).overlay(platform.providers),
          models: mergedModels,
          providerOrder: [
            LINGDONG_PROVIDER_ID,
            ...(current.providerOrder ?? []).filter((id) => id !== LINGDONG_PROVIDER_ID),
          ],
          defaultModelSelection:
            !installed || current.defaultModelSelection?.providerId === LINGDONG_PROVIDER_ID
              ? platform.defaultModelSelection
              : current.defaultModelSelection,
        };
      });
      installed = true;
      lastKey = key;
    });
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    try {
      await enqueue(async () => {
        if (!installed) return;
        await repository.update((current) => {
          const access = current.providers.get(LINGDONG_PROVIDER_ID)?.access?.toJSON();
          // 旧会话退出不能移除新会话已更新的条目；清理只针对本 owner 最近写入的凭据。
          if (!access || !("apiKey" in access) || access.apiKey !== lastKey) return current;
          return {
            providers: current.providers.delete(LINGDONG_PROVIDER_ID),
            models: current.models.deleteExactForProvider(LINGDONG_PROVIDER_ID),
            providerOrder: current.providerOrder?.filter((id) => id !== LINGDONG_PROVIDER_ID),
            defaultModelSelection:
              current.defaultModelSelection?.providerId === LINGDONG_PROVIDER_ID
                ? previousSelection
                : current.defaultModelSelection,
          };
        });
      });
    } finally {
      lastKey = undefined;
      repository.dispose();
    }
  }

  return { filePath, apply, dispose };
}
