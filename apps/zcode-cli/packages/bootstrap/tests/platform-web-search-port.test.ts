import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import { createPlatformWebSearchPort } from "../src/app/platform-web-search-port.js";

const model = {
  providerId: "lingdong-platform-gateway",
  modelId: "classroom-model",
} as never;

const request = {
  input: { query: "React 19" },
  model,
  sessionId: "session-1" as never,
  abortSignal: new AbortController().signal,
};

function response(status: number, value: unknown): HttpClientResponse {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    url: "https://aicyld.com/api/gateway/v1/search/messages",
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" },
    body,
    bytes: body.byteLength,
    durationMs: 1,
  };
}

function successBody() {
  return {
    type: "message",
    content: [
      {
        type: "web_search_tool_result",
        tool_use_id: "srv_1",
        content: [
          {
            type: "web_search_result",
            title: "React 19",
            url: "https://react.dev/blog",
            page_age: "2 days ago",
          },
        ],
      },
      { type: "text", text: "React 19 已发布。" },
    ],
    usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
  };
}

test("平台搜索端口发送 Anthropic 请求并归一化结果", async () => {
  const calls: HttpClientRequest[] = [];
  const httpClientPort: HttpClientPort = {
    request: async (input) => {
      calls.push(input);
      return response(200, successBody());
    },
  };
  const port = createPlatformWebSearchPort({
    searchUrl: "https://aicyld.com/api/gateway/v1/search/messages",
    baseUrl: "https://ignored.example",
    httpClientPort,
    getRuntimeKey: () => "key-1",
  });
  assert.ok(port);
  assert.equal(port.supportsModel(model), true);
  assert.equal(port.supportsModel({ providerId: "personal" } as never), false);

  const result = await port.search(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://aicyld.com/api/gateway/v1/search/messages");
  assert.equal(calls[0]?.headers?.["x-api-key"], "key-1");
  assert.equal(calls[0]?.headers?.authorization, "Bearer key-1");
  const body = JSON.parse(new TextDecoder().decode(calls[0]?.body));
  assert.equal(body.tools[0].type, "web_search_20260209");
  assert.equal(body.tools[0].max_uses, 8);
  assert.deepEqual(result.results, [
    { title: "React 19", url: "https://react.dev/blog", pageAge: "2 days ago" },
  ]);
  assert.equal(result.summary, "React 19 已发布。");
  assert.equal(result.webSearchRequests, 1);
  assert.deepEqual(result.modelUsage, {
    inputTokens: 10,
    outputTokens: 5,
    serverToolUse: { webSearchRequests: 1 },
  });
});

test("401 后刷新 Registry 并用新 key 重试一次", async () => {
  let key = "old-key";
  let call = 0;
  let refreshed = 0;
  const httpClientPort: HttpClientPort = {
    request: async (input) => {
      call += 1;
      if (call === 1) {
        assert.equal(input.headers?.["x-api-key"], "old-key");
        return response(401, {
          type: "error",
          error: {
            type: "authentication_error",
            message: "runtime key expired",
            code: "RUNTIME_KEY_EXPIRED",
          },
        });
      }
      assert.equal(input.headers?.["x-api-key"], "new-key");
      return response(200, successBody());
    },
  };
  const port = createPlatformWebSearchPort({
    baseUrl: "https://aicyld.com/api/gateway/v1",
    httpClientPort,
    getRuntimeKey: () => key,
    refreshRuntimeKey: async () => {
      refreshed += 1;
      key = "new-key";
    },
  });
  assert.ok(port);

  const result = await port.search(request);
  assert.equal(call, 2);
  assert.equal(refreshed, 1);
  assert.equal(result.webSearchRequests, 1);
});

test("features.webSearch=false 时不创建搜索端口", () => {
  const port = createPlatformWebSearchPort({
    searchUrl: "https://aicyld.com/api/gateway/v1/search/messages",
    enabled: false,
    httpClientPort: { request: async () => response(200, successBody()) },
    getRuntimeKey: () => "key-1",
  });
  assert.equal(port, undefined);
});

test("UPSTREAM_AUTH 不触发 key 重试", async () => {
  let call = 0;
  const port = createPlatformWebSearchPort({
    searchUrl: "https://aicyld.com/api/gateway/v1/search/messages",
    httpClientPort: {
      request: async () => {
        call += 1;
        return response(401, {
          type: "error",
          error: { type: "authentication_error", message: "渠道密钥无效", code: "UPSTREAM_AUTH" },
        });
      },
    },
    getRuntimeKey: () => "key-1",
  });
  assert.ok(port);
  await assert.rejects(() => port.search(request), /搜索服务配置异常/);
  assert.equal(call, 1);
});

test("UPSTREAM_RATE_LIMITED 退避一次后重试", async () => {
  let call = 0;
  const port = createPlatformWebSearchPort({
    searchUrl: "https://aicyld.com/api/gateway/v1/search/messages",
    httpClientPort: {
      request: async () => {
        call += 1;
        if (call === 1) {
          return response(429, {
            type: "error",
            error: { type: "rate_limit_error", message: "上游限流", code: "UPSTREAM_RATE_LIMITED" },
          });
        }
        return response(200, successBody());
      },
    },
    getRuntimeKey: () => "key-1",
  });
  assert.ok(port);
  const result = await port.search(request);
  assert.equal(call, 2);
  assert.equal(result.webSearchRequests, 1);
});

