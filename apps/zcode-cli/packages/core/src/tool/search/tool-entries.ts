import { CoreErrorType, createCoreError, type JsonSchema } from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import { parseDeferredToolCallInput } from "./deferred-resolution.js";
import type { ToolSearchResult, ToolSearchRuntimeState } from "./types.js";
import { DEFERRED_TOOL_CALL_TOOL_NAME, TOOL_SEARCH_TOOL_NAME } from "./types.js";

const TOOL_SEARCH_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description:
        'Search deferred tools by name, capability, or description. Use "select:<tool_name>" for an exact tool.',
    },
    limit: { type: "integer", minimum: 1, maximum: 20 },
  },
};

const DEFERRED_TOOL_CALL_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "input"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
    input: {
      type: "object",
      description:
        "Input object for the deferred tool, matching the schema returned by ToolSearch.",
    },
  },
};

export function createToolSearchToolEntry(state: ToolSearchRuntimeState): ToolEntry {
  return {
    capability: "Search deferred tools and return their complete model-visible definitions",
    metadata: {
      name: TOOL_SEARCH_TOOL_NAME,
      description:
        `Search tools that are not resident in this request. Use a broad capability query or select:<tool_name>. ` +
        `After finding the tool, call it through ${DEFERRED_TOOL_CALL_TOOL_NAME} with {name, input}.`,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: 30000,
      maxOutputBytes: 200000,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: async (input) => {
      const parsed = parseSearchInput(input);
      if (!parsed) {
        throw createCoreError(CoreErrorType.ToolExecutionFailed, "ToolSearch input is invalid", {
          recoverable: true,
        });
      }
      return state.search(parsed.query, parsed.limit) satisfies ToolSearchResult;
    },
    formatModelContent: (output) => formatSearchResult(output as ToolSearchResult),
    inputSchema: TOOL_SEARCH_INPUT_SCHEMA,
    outputSchema: {},
    permission: {
      permission: "tool.search",
      reason: "ToolSearch only reads the local deferred tool catalog",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 200000,
      maxModelBytes: 200000,
      strategy: "truncate",
      preview: { maxBytes: 200000, direction: "head" },
    },
    timeout: { kind: "none" },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Tool search was cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

export function createDeferredToolCallToolEntry(state: ToolSearchRuntimeState): ToolEntry {
  return {
    capability: "Call a deferred tool after its definition has been discovered",
    metadata: {
      name: DEFERRED_TOOL_CALL_TOOL_NAME,
      description:
        "Call exactly one deferred tool using {name, input}. Use ToolSearch first to load the tool schema. " +
        "Resident tools must be called directly with their normal tool call.",
      readOnly: false,
      destructive: false,
      concurrentSafe: false,
      timeoutMs: 300000,
      sideEffectScope: "system",
      riskLevel: "high",
      needsApproval: false,
    },
    handler: async (input, context) => {
      const parsed = parseDeferredToolCallInput(input);
      const validTarget = parsed !== undefined && state.enabled && state.isDeferred(parsed.name);
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        validTarget
          ? "DeferredToolCall must be resolved before tool execution."
          : "DeferredToolCall target is unavailable or is not a deferred tool.",
        {
          context: {
            toolCallId: context.toolCallId,
            toolName: DEFERRED_TOOL_CALL_TOOL_NAME,
          },
          recoverable: true,
        },
      );
    },
    inputSchema: DEFERRED_TOOL_CALL_INPUT_SCHEMA,
    outputSchema: {},
    permission: {
      permission: "tool.deferred_call",
      reason: "Call a deferred tool using its discovered definition",
      riskLevel: "high",
      sideEffectScope: "system",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 100000,
      maxModelBytes: 100000,
      strategy: "truncate",
      preview: { maxBytes: 100000, direction: "head" },
    },
    timeout: { kind: "none" },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "Deferred tool call was cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

function parseSearchInput(input: unknown): { query: string; limit?: number } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.query !== "string" || record.query.trim().length === 0) return undefined;
  if (
    record.limit !== undefined &&
    (!Number.isInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > 20)
  ) {
    return undefined;
  }
  return {
    query: record.query.trim(),
    ...(record.limit === undefined ? {} : { limit: Number(record.limit) }),
  };
}

function formatSearchResult(result: ToolSearchResult): string {
  if (result.tools.length === 0) {
    return [
      "<tool_search_result>",
      `No deferred tools matched "${result.query}".`,
      "Try a broader capability query or select:<exact_tool_name>.",
      "</tool_search_result>",
    ].join("\n");
  }
  return [
    "<tool_search_result>",
    ...result.tools.map((tool) =>
      [
        `Tool: ${tool.name}`,
        `Description: ${tool.description}`,
        `Capability: ${tool.capability}`,
        `Read only: ${tool.readOnly}`,
        `Needs approval: ${tool.needsApproval}`,
        `Input schema: ${JSON.stringify(tool.inputSchema)}`,
      ].join("\n"),
    ),
    `Call a selected tool through ${DEFERRED_TOOL_CALL_TOOL_NAME} with {"name":"<tool name>","input":{...}}.`,
    "</tool_search_result>",
  ].join("\n\n");
}
