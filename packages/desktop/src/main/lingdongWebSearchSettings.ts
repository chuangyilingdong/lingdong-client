export interface LingdongWebSearchContext {
  classroom: unknown | null;
  gateway?: {
    baseUrl?: string;
    key?: string;
    searchUrl?: string;
  };
  features?: {
    webSearch?: boolean;
  };
}

/** 平台下发的搜索地址优先；缺省时按 gateway.baseUrl 派生。 */
export function resolveLingdongWebSearchSettings(context: LingdongWebSearchContext): {
  url: string;
  enabled: boolean;
} {
  const baseUrl = String(context.gateway?.baseUrl || "")
    .trim()
    .replace(/\/+$/u, "");
  const explicitUrl = String(context.gateway?.searchUrl || "").trim();
  const url = explicitUrl || (baseUrl ? `${baseUrl}/search/messages` : "");
  const hasKey = Boolean(String(context.gateway?.key || "").trim());
  // 平台明确下发 false 时一律关闭；老平台没有能力位时，仅在课堂且拿到 key 时启用。
  const enabled =
    Boolean(url) &&
    hasKey &&
    (context.features?.webSearch === true ||
      (context.features?.webSearch === undefined && Boolean(context.classroom)));
  return { url, enabled };
}
