import type { HttpClientPort, Logger, ModelUsage } from "@zcode/contracts";
import { isHttpClientPortError } from "@zcode/contracts";
import type { WebSearchPort, WebSearchPortRequest, WebSearchPortResult } from "@zcode/core";
import {
  LINGDONG_PLATFORM_PROVIDER_ID,
  PLATFORM_WEB_SEARCH_TIMEOUT_MS,
  buildPlatformWebSearchBody,
  classifyPlatformWebSearchError,
  parsePlatformWebSearchError,
  parsePlatformWebSearchResponse,
  resolvePlatformWebSearchUrl,
} from "@zcode/shared";

export interface PlatformWebSearchPortOptions {
  /** 平台下发的完整搜索地址；优先于 baseUrl 推导。 */
  searchUrl?: string;
  /** 平台能力开关；显式 false 时不注册搜索端口。 */
  enabled?: boolean;
  baseUrl?: string;
  httpClientPort: HttpClientPort;
  /** 每次调用时读取当前课堂 Provider 的运行时 key，不能缓存进程启动时的旧值。 */
  getRuntimeKey: () => string | undefined;
  /** 401 时强制刷新 Provider Registry，和模型请求的 key 刷新路径保持一致。 */
  refreshRuntimeKey?: () => Promise<void>;
  logger?: Logger;
}

/**
 * 课堂搜索后端：把 WebSearch 工具映射到平台已有的 Anthropic 搜索网关。
 * 鉴权、课堂门禁、渠道选择与记账全部留在平台；客户端只负责发请求与归一化结果。
 */
export function createPlatformWebSearchPort(
  options: PlatformWebSearchPortOptions,
): WebSearchPort | undefined {
  if (options.enabled === false) return undefined;
  const url = options.searchUrl?.trim() || resolvePlatformWebSearchUrl(options.baseUrl);
  if (!url) return undefined;

  return {
    supportsModel(model) {
      // 只允许课堂 Provider 使用这条后端；个人 Provider 仍走自己的原生能力或保持不可用。
      return String(model.providerId) === LINGDONG_PLATFORM_PROVIDER_ID;
    },

    async search(request: WebSearchPortRequest): Promise<WebSearchPortResult> {
      const startedAt = Date.now();
      let key = readRuntimeKey(options);
      if (!key) {
        throw new Error("课堂运行时密钥不可用，请重新登录后再试");
      }

      const body = JSON.stringify(
        buildPlatformWebSearchBody({
          query: request.input.query,
          maxUses: request.input.maxUses,
          allowedDomains: request.input.allowed_domains,
          blockedDomains: request.input.blocked_domains,
        }),
      );

      const send = async (runtimeKey: string) => {
        try {
          return await options.httpClientPort.request(
            {
              url,
              method: "POST",
              headers: {
                "x-api-key": runtimeKey,
                authorization: `Bearer ${runtimeKey}`,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
                accept: "application/json",
              },
              body: new TextEncoder().encode(body),
              timeoutMs: PLATFORM_WEB_SEARCH_TIMEOUT_MS,
              maxResponseBytes: 8 * 1024 * 1024,
              redirect: "manual",
              egressPolicy: "public",
              trace: request.traceContext,
            },
            { signal: request.abortSignal },
          );
        } catch (error) {
          throw normalizeTransportError(error);
        }
      };

      let keyRetried = false;
      let rateLimitRetries = 0;
      for (;;) {
        const response = await send(key);
        const text = new TextDecoder().decode(response.body);
        const parsed = parseJson(text);

        if (response.status >= 200 && response.status < 300) {
          const result = parsePlatformWebSearchResponse(parsed);
          const modelUsage = toModelUsage(result);
          options.logger?.debug("Platform WebSearch completed", {
            event: "websearch.platform.completed",
            module: "bootstrap.app",
            durationMs: Math.max(0, Date.now() - startedAt),
            queryLength: request.input.query.length,
            resultCount: result.results.length,
            webSearchRequests: result.webSearchRequests ?? 0,
            httpStatus: response.status,
          });
          return {
            results: result.results,
            sources: result.sources,
            ...(result.summary ? { summary: result.summary } : {}),
            ...(result.webSearchRequests !== undefined
              ? { webSearchRequests: result.webSearchRequests }
              : {}),
            ...(modelUsage ? { modelUsage } : {}),
          };
        }

        const details = parsePlatformWebSearchError(parsed, response.status);
        const classification = classifyPlatformWebSearchError(details);
        options.logger?.warn("Platform WebSearch failed", {
          event: "websearch.platform.failed",
          module: "bootstrap.app",
          code: details.code,
          httpStatus: response.status,
          kind: classification.kind,
          retry: classification.retry,
          durationMs: Math.max(0, Date.now() - startedAt),
        });

        if (classification.retry === "key" && !keyRetried) {
          keyRetried = true;
          try {
            await options.refreshRuntimeKey?.();
          } catch {
            // 刷新失败仍按一次重试处理；下面读不到新 key 就返回明确错误。
          }
          await delay(500);
          const refreshedKey = readRuntimeKey(options);
          if (refreshedKey && refreshedKey !== key) {
            key = refreshedKey;
            continue;
          }
        }

        if (classification.retry === "backoff" && rateLimitRetries < 2) {
          rateLimitRetries += 1;
          await delay(rateLimitRetries === 1 ? 1000 : 2000);
          continue;
        }

        throw createWebSearchError(
          details.code,
          formatPlatformWebSearchErrorMessage(classification, details),
        );
      }
    },
  };
}

function readRuntimeKey(options: PlatformWebSearchPortOptions): string | undefined {
  return options.getRuntimeKey()?.trim() || undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function createWebSearchError(code: string | undefined, message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  if (code) error.code = code;
  return error;
}

function formatPlatformWebSearchErrorMessage(
  classification: { userMessage: string },
  details: { message: string },
): string {
  const detail = details.message.trim();
  if (!detail || classification.userMessage.includes(detail)) {
    return classification.userMessage;
  }
  return `${classification.userMessage}（${detail}）`;
}
function toModelUsage(result: {
  inputTokens?: number;
  outputTokens?: number;
  webSearchRequests?: number;
}): ModelUsage | undefined {
  if (
    result.inputTokens === undefined &&
    result.outputTokens === undefined &&
    result.webSearchRequests === undefined
  ) {
    return undefined;
  }
  return {
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.webSearchRequests !== undefined
      ? { serverToolUse: { webSearchRequests: result.webSearchRequests } }
      : {}),
  };
}

function normalizeTransportError(error: unknown): Error {
  if (isHttpClientPortError(error)) {
    switch (error.code) {
      case "timeout":
        return new Error("搜索超时，请稍后再试");
      case "cancelled":
        return new Error("搜索已取消");
      case "egress_blocked":
        return new Error("搜索被网络出口策略阻止");
      case "too_large":
        return new Error("搜索结果过大");
      case "proxy_error":
        return new Error("搜索代理连接失败");
      default:
        return new Error("搜索暂不可用，请稍后再试");
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}




