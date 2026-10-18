import type {
  Model,
  ModelUsage,
  SessionId,
  TraceContext,
  WebSearchInput,
  WebSearchResultItem,
  WebSearchSource,
} from "@zcode/contracts";

/**
 * 客户端搜索后端：当模型不支持 provider-native WebSearch 时，由宿主注入。
 * 端口只返回归一化后的结果；鉴权、配额、上游选择全部留在实现方。
 */
export interface WebSearchPortRequest {
  input: WebSearchInput;
  model: Model;
  sessionId: SessionId;
  traceContext?: TraceContext;
  abortSignal: AbortSignal;
}

export interface WebSearchPortResult {
  results: WebSearchResultItem[];
  sources: WebSearchSource[];
  summary?: string;
  webSearchRequests?: number;
  modelUsage?: ModelUsage;
}

export interface WebSearchPort {
  /** 只对当前课堂 Provider 返回 true，避免个人 Provider 误走课堂搜索网关。 */
  supportsModel(model: Model): boolean;
  search(request: WebSearchPortRequest): Promise<WebSearchPortResult>;
}
