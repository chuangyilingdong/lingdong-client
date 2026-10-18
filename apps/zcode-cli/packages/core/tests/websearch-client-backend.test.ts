import assert from "node:assert/strict";
import { test } from "node:test";
import { webSearchToolEntry } from "../src/tool/handlers/websearch.js";
import { builtInTools } from "../src/tool/handlers/index.js";

const model = {
  providerId: "lingdong-platform-gateway",
  modelId: "classroom-model",
  properties: { supportsNativeWebSearch: false },
  optionSpecs: { maxOutputTokens: { max: 4096 } },
  options: {},
} as never;

function context(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: "tool-1",
    sessionId: "session-1",
    traceId: "trace-1",
    abortSignal: new AbortController().signal,
    workingDirectory: ".",
    workspaceRoot: ".",
    model,
    ...overrides,
  } as never;
}

test("没有原生搜索且没有客户端端口时明确报配置错误", async () => {
  await assert.rejects(
    () => webSearchToolEntry.handler!({ query: "React 19" }, context()),
    /no client search backend/,
  );
});

test("客户端端口存在时走平台搜索并返回归一化结果", async () => {
  const calls: unknown[] = [];
  const output = await webSearchToolEntry.handler!(
    { query: "React 19" },
    context({
      webSearchPort: {
        supportsModel: () => true,
        search: async (request: unknown) => {
          calls.push(request);
          return {
            results: [{ title: "React 19", url: "https://react.dev/blog" }],
            sources: [{ title: "React 19", url: "https://react.dev/blog" }],
            summary: "React 19 已发布。",
            webSearchRequests: 1,
          };
        },
      },
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal((output as { query: string }).query, "React 19");
  assert.deepEqual((output as { results: unknown[] }).results, [
    { title: "React 19", url: "https://react.dev/blog" },
  ]);
  assert.equal((output as { summary?: string }).summary, "React 19 已发布。");
  assert.equal((output as { webSearchRequests?: number }).webSearchRequests, 1);
});

test("端口只支持课堂 Provider 时不接管其他 Provider", async () => {
  await assert.rejects(
    () =>
      webSearchToolEntry.handler!(
        { query: "React 19" },
        context({
          model: { ...model, providerId: "personal-provider" },
          webSearchPort: {
            supportsModel: () => false,
            search: async () => {
              throw new Error("should not be called");
            },
          },
        }),
      ),
    /no client search backend/,
  );
});

test("WebFetch 与 WebSearch 都是内置工具", () => {
  const names = builtInTools.map((tool) => tool.metadata.name);
  assert.ok(names.includes("WebFetch"));
  assert.ok(names.includes("WebSearch"));
});
