import type { ModelSelectionView } from "@zcode/services";

interface ProviderAvailabilityState {
  readonly source: "registry";
  readonly hydrated: boolean;
  readonly providerCount: number;
  readonly hasUsableProvider: boolean;
}

export function resolveProviderAvailabilityState(params: {
  modelSelectionView: ModelSelectionView | null;
}): ProviderAvailabilityState {
  const providers = params.modelSelectionView?.providers ?? [];
  return {
    source: "registry",
    hydrated: params.modelSelectionView !== null,
    providerCount: providers.length,
    hasUsableProvider:
      params.modelSelectionView !== null &&
      providers.some((provider) => provider.models.length > 0),
  };
}

/** 启动引导看 Registry 的实际可用性，不把厂商 family 当成通用 Provider 的前置条件。 */
export function shouldOpenProviderLoginEntry(state: {
  readonly hasUsableProvider: boolean;
  readonly hasUser: boolean;
  readonly hasProviderFamilyDomain: boolean;
}): boolean {
  // 平台/个人 API Key Provider 不属于厂商 OAuth family；旧条件会把已可用课堂再次送进登录页。
  return !state.hasUsableProvider && (!state.hasProviderFamilyDomain || !state.hasUser);
}
