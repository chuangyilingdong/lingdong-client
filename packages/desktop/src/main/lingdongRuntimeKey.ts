export const LINGDONG_RUNTIME_KEY_PREFIX = "rt1";

export interface RuntimeKeyRefreshDecisionInput {
  key: unknown;
  now: number;
  lastRefreshAt: number;
  refreshMarginMs: number;
  fallbackIntervalMs: number;
}

/** 运行时密钥是 rt1.<base64url payload>.<mac>；只读取 exp，不校验签名。 */
export function readRuntimeKeyExpiresAt(key: unknown): number | null {
  const token = typeof key === "string" ? key.trim() : "";
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== LINGDONG_RUNTIME_KEY_PREFIX) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object") return null;
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * 课堂轮询会持续拿到平台新签发的运行时密钥。
 * 密钥能解析出 exp 时只在临近过期续签；解析失败才退回固定周期，避免每个轮询都写 Provider 配置。
 */
export function shouldRefreshRuntimeKey(input: RuntimeKeyRefreshDecisionInput): boolean {
  const expiresAt = readRuntimeKeyExpiresAt(input.key);
  if (expiresAt !== null) {
    return expiresAt - input.now <= input.refreshMarginMs;
  }
  return input.now - input.lastRefreshAt >= input.fallbackIntervalMs;
}
