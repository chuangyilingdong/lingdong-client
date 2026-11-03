import type { ToolRegistry } from "../registry.js";
import type {
  ToolSearchCatalogEntry,
  ToolSearchConfig,
  ToolSearchMode,
  ToolSearchResult,
  ToolSearchRuntimeState,
} from "./types.js";
import { DEFERRED_TOOL_CALL_TOOL_NAME, TOOL_SEARCH_TOOL_NAME } from "./types.js";

export const DEFAULT_TOOL_SEARCH_RESIDENT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "ApplyPatch",
  "Bash",
  "Glob",
  "Grep",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
  "WebSearch",
  "WebFetch",
] as const;

const DEFAULT_MIN_DEFERRED_TOOLS = 8;
const DEFAULT_MAX_RESULTS = 5;
const CONTROL_TOOL_NAMES = new Set([TOOL_SEARCH_TOOL_NAME, DEFERRED_TOOL_CALL_TOOL_NAME]);

export function createToolSearchRuntimeState(
  registry: Pick<ToolRegistry, "list" | "get">,
  config: ToolSearchConfig | undefined,
): ToolSearchRuntimeState {
  const mode: ToolSearchMode = config?.mode === "off" ? "off" : "local";
  const resident = new Set(config?.residentToolNames ?? DEFAULT_TOOL_SEARCH_RESIDENT_TOOLS);
  const minDeferredTools = Math.max(1, config?.minDeferredTools ?? DEFAULT_MIN_DEFERRED_TOOLS);
  const maxResults = Math.max(1, Math.min(20, config?.maxResults ?? DEFAULT_MAX_RESULTS));
  const initialDeferredCount = listDeferredEntries(registry, resident).length;
  const enabled = mode === "local" && initialDeferredCount >= minDeferredTools;
  return {
    mode,
    enabled,
    maxResults,
    getCatalog: () => listDeferredEntries(registry, resident),
    isDeferred: (name) =>
      enabled && listDeferredEntries(registry, resident).some((entry) => entry.name === name),
    search: (query, limit) =>
      searchCatalog(listDeferredEntries(registry, resident), query, limit ?? maxResults),
  };
}

export function filterToolContractsForToolSearch<T extends { name: string }>(
  tools: readonly T[],
  state: ToolSearchRuntimeState | undefined,
): T[] {
  if (!state?.enabled) return [...tools];
  const deferred = new Set(state.getCatalog().map((entry) => entry.name));
  return tools.filter((tool) => !deferred.has(tool.name));
}

function listDeferredEntries(
  registry: Pick<ToolRegistry, "list" | "get">,
  resident: ReadonlySet<string>,
): ToolSearchCatalogEntry[] {
  return registry
    .list()
    .map((name) => registry.get(name))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .filter((entry) => entry.metadata.providerVisible !== false)
    .filter((entry) => entry.providerNative === undefined)
    .filter((entry) => !resident.has(entry.metadata.name))
    .filter((entry) => !CONTROL_TOOL_NAMES.has(entry.metadata.name))
    .map((entry) => ({
      name: entry.metadata.name,
      description: entry.metadata.description ?? entry.capability,
      capability: entry.capability,
      inputSchema: entry.inputSchema,
      readOnly: entry.metadata.readOnly,
      destructive: entry.metadata.destructive,
      needsApproval: entry.metadata.needsApproval,
    }));
}

function searchCatalog(
  catalog: readonly ToolSearchCatalogEntry[],
  rawQuery: string,
  limit: number,
): ToolSearchResult {
  const query = rawQuery.trim();
  const selectedName = query.startsWith("select:") ? query.slice("select:".length).trim() : "";
  if (selectedName) {
    const selected = catalog.find((entry) => entry.name === selectedName);
    return { query, tools: selected ? [selected] : [] };
  }
  const normalizedQuery = query.toLowerCase();
  const tokens = normalizedQuery.split(/[^a-z0-9_\-\u4e00-\u9fff]+/u).filter(Boolean);
  const tools = catalog
    .map((entry) => ({ entry, score: scoreEntry(entry, normalizedQuery, tokens) }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.entry.name.length - right.entry.name.length,
    )
    .slice(0, limit)
    .map((item) => item.entry);
  return { query, tools };
}

function scoreEntry(
  entry: ToolSearchCatalogEntry,
  query: string,
  tokens: readonly string[],
): number {
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  const capability = entry.capability.toLowerCase();
  if (name === query) return 1000;
  if (name.includes(query)) return 300;
  if (description.includes(query)) return 200;
  if (capability.includes(query)) return 150;
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 30;
    if (description.includes(token)) score += 8;
    if (capability.includes(token)) score += 5;
  }
  return score;
}
