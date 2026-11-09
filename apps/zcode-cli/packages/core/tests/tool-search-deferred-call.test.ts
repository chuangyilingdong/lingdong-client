import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { toAiSdkMessages } from "../../adapters/src/model/transform.js";
import { createStreamTextOptions } from "../../adapters/src/model/runner-options.js";
import {
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
} from "../src/agent/message-history.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { ToolExecutorImpl } from "../src/tool/executor/impl.js";
import { executeToolBatch, executeToolSchedule } from "../src/tool/executor/batch-runner.js";
import type { ToolExecutionResult, ToolExecutorDeps } from "../src/tool/executor/types.js";
import { createDenyPermissionBroker } from "../src/permission/broker.js";
import { PermissionService } from "../src/permission/service.js";
import type { ToolEntry } from "../src/tool/types.js";
import type { ToolSearchRuntimeState } from "../src/tool/search/types.js";
import { resolveDeferredToolCall } from "../src/tool/search/deferred-resolution.js";
import { filterToolContractsForToolSearch } from "../src/tool/search/tool-search-state.js";

function createLocalSearchRegistry() {
  const registry = createToolRegistry();
  const state = registerBuiltInTools(registry, {
    includeAgent: true,
    includeAutomation: true,
    includeOffPeak: true,
    includeDynamicWorkflow: true,
    toolSearchConfig: { mode: "local", minDeferredTools: 1 },
  });
  return { registry, state };
}

test("local tool search exposes resident and control tools but hides deferred tools", () => {
  const { registry, state } = createLocalSearchRegistry();
  assert.ok(state?.enabled);
  assert.ok(registry.has("ToolSearch"));
  assert.ok(registry.has("DeferredToolCall"));
  assert.ok(state.getCatalog().some((entry) => entry.name === "CronCreate"));
  assert.ok(!state.getCatalog().some((entry) => entry.name === "Read"));
  for (const residentName of [
    "AskUserQuestion",
    "Skill",
    "EnterPlanMode",
    "ExitPlanMode",
    "WebSearch",
    "WebFetch",
  ]) {
    assert.ok(
      !state.getCatalog().some((entry) => entry.name === residentName),
      "resident tool must not enter deferred catalog: " + residentName,
    );
  }

  const allContracts = registry.toContracts();
  const visible = filterToolContractsForToolSearch(allContracts, state);
  assert.ok(JSON.stringify(visible).length < JSON.stringify(allContracts).length * 0.6);
  const names = new Set(visible.map((tool) => tool.name));
  assert.ok(names.has("Read"));
  assert.ok(names.has("Write"));
  assert.ok(names.has("ApplyPatch"));
  assert.ok(names.has("ToolSearch"));
  assert.ok(names.has("DeferredToolCall"));
  for (const residentName of [
    "AskUserQuestion",
    "Skill",
    "EnterPlanMode",
    "ExitPlanMode",
    "WebSearch",
    "WebFetch",
  ]) {
    assert.ok(names.has(residentName), "resident tool must be visible: " + residentName);
  }
  assert.ok(!names.has("CronCreate"));
});

test("provider request builder exposes only resident and control tool definitions", () => {
  const { registry, state } = createLocalSearchRegistry();
  const visible = filterToolContractsForToolSearch(registry.toContracts(), state);
  const options = createStreamTextOptions({
    includeModelIO: false,
    request: { messages: [], tools: visible },
    resolved: {
      model: {},
      modelId: "test-model",
      properties: {
        requiresMfjsToolSchema: false,
        supportsNativeWebSearch: false,
      },
      providerId: "test-provider",
      providerKind: "openai-compatible",
    } as never,
    statusContext: {
      modelRequestSessionType: "other",
      requestId: "request-tool-search-test",
      traceId: "trace-tool-search-test",
    } as never,
  });
  const names = Object.keys(options.tools ?? {}).sort();
  assert.deepEqual(
    names,
    [
      "ApplyPatch",
      "AskUserQuestion",
      "Bash",
      "DeferredToolCall",
      "Edit",
      "EnterPlanMode",
      "ExitPlanMode",
      "Glob",
      "Grep",
      "Read",
      "Skill",
      "WebFetch",
      "WebSearch",
      "TodoRead",
      "TodoWrite",
      "ToolSearch",
      "Write",
    ].sort(),
  );
  assert.doesNotMatch(JSON.stringify(options.tools), /CronCreate/u);
});

test("subagent child runtime inherits the parent tool search config", async () => {
  const source = await readFile(
    new URL("../src/runtime/methods/subagent.ts", import.meta.url),
    "utf8",
  );
  const childRuntimeStart = source.indexOf("const childRuntime = new AgentRuntime(");
  assert.ok(childRuntimeStart >= 0);
  assert.match(
    source.slice(childRuntimeStart, childRuntimeStart + 5000),
    /toolSearch: this\.config\.toolSearch/u,
  );
});

test("ToolSearch supports exact selection and capability search", () => {
  const { state } = createLocalSearchRegistry();
  assert.equal(state?.search("select:CronCreate").tools[0]?.name, "CronCreate");
  assert.ok(state?.search("automation").tools.some((tool) => tool.name === "CronCreate"));
  assert.deepEqual(state?.search("select:Read").tools, []);
});

test("DeferredToolCall rewrites to the concrete tool and rejects resident targets", () => {
  const { registry, state } = createLocalSearchRegistry();
  const rewritten = resolveDeferredToolCall(
    {
      id: "tool-1",
      name: "DeferredToolCall",
      input: { name: "CronCreate", input: { cron: "0 9 * * *", prompt: "standup" } },
    },
    state,
    registry,
  );
  assert.equal(rewritten.call.name, "CronCreate");
  assert.equal(rewritten.call.modelCallWrapper, "DeferredToolCall");
  assert.deepEqual(rewritten.call.input, { cron: "0 9 * * *", prompt: "standup" });

  const resident = resolveDeferredToolCall(
    { id: "tool-2", name: "DeferredToolCall", input: { name: "Read", input: { file_path: "x" } } },
    state,
    registry,
  );
  assert.equal(resident.call.name, "DeferredToolCall");
  assert.equal(resident.call.modelCallWrapper, undefined);
});

test("provider projection restores the DeferredToolCall wrapper for calls and results", () => {
  const messages = [
    createRuntimeAssistantEntry("", [
      {
        id: "tool-1",
        name: "CronCreate",
        input: { cron: "0 9 * * *" },
        modelCallWrapper: "DeferredToolCall",
      },
    ]),
    createRuntimeToolResultEntry("tool-1", "CronCreate", "created", false, "DeferredToolCall"),
  ];
  const projected = toAiSdkMessages(messages.map((entry) => entry.message));
  const assistantContent = projected[0]?.content as Array<Record<string, unknown>>;
  const toolResultContent = projected[1]?.content as Array<Record<string, unknown>>;
  assert.equal(assistantContent[0]?.toolName, "DeferredToolCall");
  assert.deepEqual(assistantContent[0]?.input, {
    name: "CronCreate",
    input: { cron: "0 9 * * *" },
  });
  assert.equal(toolResultContent[0]?.toolName, "DeferredToolCall");
});

test("mode off keeps the existing full tool surface and removes stale controls", () => {
  const { registry } = createLocalSearchRegistry();
  assert.ok(registry.has("ToolSearch"));
  assert.ok(registry.has("DeferredToolCall"));
  const state = registerBuiltInTools(registry, {
    includeAgent: true,
    includeAutomation: true,
    includeOffPeak: true,
    includeDynamicWorkflow: true,
    toolSearchConfig: { mode: "off" },
    silentDuplicateWarnings: true,
  });
  assert.equal(state?.enabled, false);
  assert.ok(!registry.has("ToolSearch"));
  assert.ok(!registry.has("DeferredToolCall"));
  const names = new Set(registry.toContracts().map((tool) => tool.name));
  assert.ok(names.has("Read"));
  assert.ok(names.has("CronCreate"));
});

test("executor rewrites DeferredToolCall before permission and handler execution", async () => {
  const registry = createToolRegistry();
  const echoTool: ToolEntry = {
    capability: "Echo a test input",
    metadata: {
      name: "Echo",
      description: "Echo a test input",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: async (input) => ({ echoed: input }),
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: {},
    permission: {
      permission: "test.echo",
      reason: "Echo only reads its input",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 1024, maxModelBytes: 1024, strategy: "truncate" },
    timeout: { kind: "none" },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: "cancelled" },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
  registry.register(echoTool);
  const state: ToolSearchRuntimeState = {
    mode: "local",
    enabled: true,
    maxResults: 5,
    getCatalog: () => [
      {
        name: "Echo",
        description: "Echo a test input",
        capability: "Echo a test input",
        inputSchema: echoTool.inputSchema,
        readOnly: true,
        destructive: false,
        needsApproval: false,
      },
    ],
    isDeferred: (name) => name === "Echo",
    search: (query) => ({ query, tools: [] }),
  };
  const executor = new ToolExecutorImpl({
    registry,
    permissionService: new PermissionService(),
    permissionBroker: createDenyPermissionBroker(),
    emitEvent: async () => {},
    sessionId: "session-tool-search-test" as never,
    defaultTimeoutMs: 1000,
    readFileState: new Map(),
    getWorkingDirectory: () => ".",
    getWorkspaceRoot: () => ".",
    runtimeScope: "main",
    getMode: () => "build",
    maxConcurrency: 1,
  });
  const result = await executor.execute(
    {
      id: "deferred-1",
      name: "DeferredToolCall",
      input: { name: "Echo", input: { value: 1 } },
    },
    { toolSearch: state },
  );
  assert.equal(result.success, true);
  assert.equal(result.toolName, "Echo");
  assert.equal(result.modelCallWrapper, "DeferredToolCall");
  assert.deepEqual(result.output, { echoed: { value: 1 } });
});


test("executeToolSchedule forwards toolSearch into scheduled batches", async () => {
  const state: ToolSearchRuntimeState = {
    mode: "local",
    enabled: true,
    maxResults: 5,
    getCatalog: () => [],
    isDeferred: (name) => name === "Echo",
    search: (query) => ({ query, tools: [] }),
  };
  const call = {
    id: "schedule-deferred-1",
    name: "DeferredToolCall",
    input: { name: "Echo", input: { value: 1 } },
  };
  const schedule = {
    items: [{ toolCallId: call.id as never, dependencies: [], canRunParallel: true }],
    parallelGroups: [[call.id as never]],
    executionOrder: [call.id as never],
  };
  let captured: ToolSearchRuntimeState | undefined;
  const iterator = executeToolSchedule(
    { maxConcurrency: 1 } as ToolExecutorDeps,
    async (_calls, options): Promise<ToolExecutionResult[]> => {
      captured = options?.toolSearch;
      return [];
    },
    [call],
    schedule,
    { toolSearch: state, maxConcurrency: 1 },
  );
  for await (const _event of iterator) {
    // Drain the generator so the scheduled batch actually executes.
  }
  assert.equal(captured, state);
});

test("executeToolBatch preserves toolSearch when splitting over concurrency", async () => {
  const state: ToolSearchRuntimeState = {
    mode: "local",
    enabled: true,
    maxResults: 5,
    getCatalog: () => [],
    isDeferred: (name) => name === "Echo",
    search: (query) => ({ query, tools: [] }),
  };
  const calls = [
    { id: "batch-deferred-1", name: "DeferredToolCall", input: { name: "Echo", input: { value: 1 } } },
    { id: "batch-deferred-2", name: "DeferredToolCall", input: { name: "Echo", input: { value: 2 } } },
  ];
  const captured: Array<ToolSearchRuntimeState | undefined> = [];
  const results = await executeToolBatch(
    { maxConcurrency: 1 } as ToolExecutorDeps,
    async (_call, options): Promise<ToolExecutionResult> => {
      captured.push(options?.toolSearch);
      return { success: true } as ToolExecutionResult;
    },
    calls,
    { toolSearch: state, maxConcurrency: 1 },
  );
  assert.equal(results.length, 2);
  assert.deepEqual(captured, [state, state]);
});
