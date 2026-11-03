export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";
export const DEFERRED_TOOL_CALL_TOOL_NAME = "DeferredToolCall";

export type ToolSearchMode = "off" | "local";

export interface ToolSearchConfig {
  mode?: ToolSearchMode;
  minDeferredTools?: number;
  maxResults?: number;
  residentToolNames?: readonly string[];
}

export interface ToolSearchCatalogEntry {
  name: string;
  description: string;
  capability: string;
  inputSchema: unknown;
  readOnly: boolean;
  destructive: boolean;
  needsApproval: boolean;
}

export interface ToolSearchResult {
  query: string;
  tools: ToolSearchCatalogEntry[];
}

export interface ToolSearchRuntimeState {
  readonly mode: ToolSearchMode;
  readonly enabled: boolean;
  readonly maxResults: number;
  getCatalog(): readonly ToolSearchCatalogEntry[];
  isDeferred(name: string): boolean;
  search(query: string, limit?: number): ToolSearchResult;
}