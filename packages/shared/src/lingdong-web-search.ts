/**
 * 平台搜索网关（Anthropic Messages）请求构造与响应归一化。
 *
 * 这里只做纯数据转换，不碰网络与运行时凭据；网络 I/O 由 bootstrap 的
 * WebSearchPort 适配器负责。平台网关已经是 Anthropic 方言，因此不要再包一层
 * OpenAI 信封，也不要在客户端解析前改写协议。
 */

export const PLATFORM_WEB_SEARCH_PATH = "search/messages";
export const PLATFORM_WEB_SEARCH_TIMEOUT_MS = 85_000;
export const PLATFORM_WEB_SEARCH_DEFAULT_MAX_USES = 8;
export const PLATFORM_WEB_SEARCH_MAX_USES = 10;

export interface PlatformWebSearchRequestInput {
  query: string;
  maxUses?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface PlatformWebSearchResultItem {
  title?: string;
  url: string;
  pageAge?: string;
}

export interface PlatformWebSearchSource {
  title?: string;
  url: string;
}

export interface PlatformWebSearchParsedResponse {
  summary?: string;
  results: PlatformWebSearchResultItem[];
  sources: PlatformWebSearchSource[];
  webSearchRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** `gateway.baseUrl` 是 `/api/gateway/v1`，搜索端点在其下。 */
export function resolvePlatformWebSearchUrl(baseUrl: string | undefined): string | undefined {
  const normalized = baseUrl?.trim().replace(/\/+$/u, "");
  if (!normalized) return undefined;
  if (normalized.endsWith(`/${PLATFORM_WEB_SEARCH_PATH}`)) return normalized;
  return `${normalized}/${PLATFORM_WEB_SEARCH_PATH}`;
}

export function buildPlatformWebSearchBody(
  input: PlatformWebSearchRequestInput,
): Record<string, unknown> {
  const maxUses = clampMaxUses(input.maxUses);
  const tool: Record<string, unknown> = {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: maxUses,
  };
  if (input.allowedDomains?.length) tool.allowed_domains = [...input.allowedDomains];
  if (input.blockedDomains?.length) tool.blocked_domains = [...input.blockedDomains];
  return {
    // 不传 model：平台 searchChannelSelection(policy, '') 会选已配置的搜索模型。
    max_tokens: 4096,
    stream: false,
    messages: [{ role: "user", content: input.query }],
    tools: [tool],
  };
}

export function parsePlatformWebSearchResponse(value: unknown): PlatformWebSearchParsedResponse {
  if (!isRecord(value)) {
    throw new Error("搜索网关返回了无法解析的响应");
  }
  const content = value.content;
  if (!Array.isArray(content)) {
    throw new Error("搜索网关响应缺少 content 数组");
  }

  const textParts: string[] = [];
  const results: PlatformWebSearchResultItem[] = [];
  let serverToolUses = 0;

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      textParts.push(block.text.trim());
      continue;
    }
    if (block.type === "web_search_tool_result") {
      const resultContent = block.content;
      if (!Array.isArray(resultContent)) continue;
      for (const item of resultContent) {
        if (!isRecord(item)) continue;
        if (item.type !== "web_search_result") continue;
        const url = stringValue(item.url);
        if (!url) continue;
        const title = stringValue(item.title);
        const pageAge = stringValue(item.page_age);
        results.push({
          url,
          ...(title ? { title } : {}),
          ...(pageAge ? { pageAge } : {}),
        });
      }
      continue;
    }
    if (block.type === "server_tool_use" && block.name === "web_search") {
      serverToolUses += 1;
    }
  }

  const summary = textParts.join("\n\n").trim() || undefined;
  const dedupedResults = dedupeResults(results);
  const sources = dedupeSources([
    ...dedupedResults.map((result) => ({
      url: result.url,
      ...(result.title ? { title: result.title } : {}),
    })),
    ...extractSourcesFromSummary(summary),
  ]);
  const usage = isRecord(value.usage) ? value.usage : undefined;
  const serverToolUse =
    usage && isRecord(usage.server_tool_use) ? usage.server_tool_use : undefined;
  const usageWebSearches = numberValue(serverToolUse?.web_search_requests);
  const inputTokens = numberValue(usage?.input_tokens);
  const outputTokens = numberValue(usage?.output_tokens);

  return {
    ...(summary ? { summary } : {}),
    results: dedupedResults,
    sources,
    ...(usageWebSearches !== undefined
      ? { webSearchRequests: usageWebSearches }
      : serverToolUses > 0
        ? { webSearchRequests: serverToolUses }
        : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

export interface PlatformWebSearchErrorDetails {
  status: number;
  code?: string;
  type?: string;
  message: string;
}

export type PlatformWebSearchErrorKind =
  | "auth-refresh"
  | "rate-limited"
  | "unavailable"
  | "classroom-inactive"
  | "external-blocked"
  | "invalid-request"
  | "upstream-auth"
  | "unknown";

export interface PlatformWebSearchErrorClassification {
  kind: PlatformWebSearchErrorKind;
  retry: "none" | "key" | "backoff";
  userMessage: string;
}

export function parsePlatformWebSearchError(
  value: unknown,
  status: number,
): PlatformWebSearchErrorDetails {
  if (isRecord(value) && isRecord(value.error)) {
    const code = stringValue(value.error.code);
    const type = stringValue(value.error.type);
    const message = stringValue(value.error.message) ?? `搜索网关返回 HTTP ${status}`;
    return {
      status,
      ...(code ? { code } : {}),
      ...(type ? { type } : {}),
      message,
    };
  }
  return { status, message: `搜索网关返回 HTTP ${status}` };
}

/** 平台稳定机器码优先；只有平台没给 code 时才用 HTTP 状态兜底。 */
export function classifyPlatformWebSearchError(
  details: PlatformWebSearchErrorDetails,
): PlatformWebSearchErrorClassification {
  const code = details.code;
  if (code === "RUNTIME_KEY_EXPIRED" || code === "RUNTIME_KEY_INVALID") {
    return {
      kind: "auth-refresh",
      retry: "key",
      userMessage: "课堂搜索凭据已过期，请重试",
    };
  }
  if (code === "UPSTREAM_RATE_LIMITED" || details.status === 429) {
    return {
      kind: "rate-limited",
      retry: "backoff",
      userMessage: "搜索请求过于频繁，请稍后再试",
    };
  }
  if (
    code === "RUNTIME_CLASSROOM_INACTIVE" ||
    code === "RUNTIME_CLASSROOM_UNAVAILABLE" ||
    code === "RUNTIME_STUDENT_NOT_ACTIVE"
  ) {
    return {
      kind: "classroom-inactive",
      retry: "none",
      userMessage: "课堂已结束或你已不在课堂中，无法搜索",
    };
  }
  if (code === "STUDENT_EXTERNAL_AI_BLOCKED") {
    return {
      kind: "external-blocked",
      retry: "none",
      userMessage: "当前课堂未开启联网搜索",
    };
  }
  if (code === "UPSTREAM_AUTH") {
    return {
      kind: "upstream-auth",
      retry: "none",
      userMessage: "搜索服务配置异常，请稍后再试",
    };
  }
  if (
    code === "RUNTIME_SEARCH_TOOL_REQUIRED" ||
    code === "RUNTIME_SEARCH_STREAM_UNSUPPORTED" ||
    code === "VALIDATION_REQUIRED" ||
    code === "UPSTREAM_INVALID_REQUEST" ||
    code === "UPSTREAM_NOT_FOUND"
  ) {
    return {
      kind: "invalid-request",
      retry: "none",
      userMessage: "搜索请求无效，请更新客户端后重试",
    };
  }
  if (
    code === "RUNTIME_SEARCH_TIMEOUT" ||
    code === "RUNTIME_SEARCH_UPSTREAM_UNREACHABLE" ||
    code === "UPSTREAM_UNAVAILABLE" ||
    details.status === 502 ||
    details.status === 503 ||
    details.status === 504
  ) {
    return {
      kind: "unavailable",
      retry: "none",
      userMessage: "搜索暂不可用，请稍后再试",
    };
  }
  return {
    kind: "unknown",
    retry: "none",
    userMessage: "搜索失败，请稍后再试",
  };
}

export function platformWebSearchErrorMessage(value: unknown, status: number): string {
  return parsePlatformWebSearchError(value, status).message;
}

function clampMaxUses(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return PLATFORM_WEB_SEARCH_DEFAULT_MAX_USES;
  return Math.max(1, Math.min(PLATFORM_WEB_SEARCH_MAX_USES, Math.floor(value)));
}

function extractSourcesFromSummary(summary: string | undefined): PlatformWebSearchSource[] {
  if (!summary) return [];
  const sources: PlatformWebSearchSource[] = [];
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu;
  for (const match of summary.matchAll(pattern)) {
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (!url) continue;
    sources.push({ url, ...(title ? { title } : {}) });
  }
  return sources;
}

function dedupeResults(results: PlatformWebSearchResultItem[]): PlatformWebSearchResultItem[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSources(sources: PlatformWebSearchSource[]): PlatformWebSearchSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}
