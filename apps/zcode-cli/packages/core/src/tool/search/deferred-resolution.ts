import type { ToolRegistry } from "../registry.js";
import type { ToolSearchRuntimeState } from "./types.js";
import { DEFERRED_TOOL_CALL_TOOL_NAME, TOOL_SEARCH_TOOL_NAME } from "./types.js";

export interface DeferredToolCallInput {
  name: string;
  input: Record<string, unknown>;
}

export interface ResolveDeferredToolCallResult<
  T extends { id: string; name: string; input: unknown },
> {
  call: T & { modelCallWrapper?: string };
}

export function parseDeferredToolCallInput(input: unknown): DeferredToolCallInput | undefined {
  if (!isPlainRecord(input)) return undefined;
  if (typeof input.name !== "string" || input.name.trim().length === 0) return undefined;
  if (!isPlainRecord(input.input)) return undefined;
  return { name: input.name.trim(), input: input.input };
}

export function resolveDeferredToolCall<T extends { id: string; name: string; input: unknown }>(
  call: T,
  state: ToolSearchRuntimeState | undefined,
  registry: ToolRegistry,
): ResolveDeferredToolCallResult<T> {
  if (call.name !== DEFERRED_TOOL_CALL_TOOL_NAME) return { call };
  const input = parseDeferredToolCallInput(call.input);
  if (!input || !state?.enabled || !state.isDeferred(input.name)) return { call };
  const target = registry.get(input.name);
  if (
    !target ||
    target.providerNative !== undefined ||
    target.metadata.name === TOOL_SEARCH_TOOL_NAME ||
    target.metadata.name === DEFERRED_TOOL_CALL_TOOL_NAME
  ) {
    return { call };
  }
  return {
    call: {
      ...call,
      name: target.metadata.name,
      input: input.input,
      modelCallWrapper: DEFERRED_TOOL_CALL_TOOL_NAME,
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
