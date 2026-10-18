import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPlatformWebSearchBody,
  classifyPlatformWebSearchError,
  parsePlatformWebSearchError,
  parsePlatformWebSearchResponse,
  platformWebSearchErrorMessage,
  resolvePlatformWebSearchUrl,
} from "@zcode/shared";

test("平台搜索 URL 从 gateway.baseUrl 派生", () => {
  assert.equal(
    resolvePlatformWebSearchUrl("https://aicyld.com/api/gateway/v1/"),
    "https://aicyld.com/api/gateway/v1/search/messages",
  );
  assert.equal(
    resolvePlatformWebSearchUrl("https://aicyld.com/api/gateway/v1/search/messages"),
    "https://aicyld.com/api/gateway/v1/search/messages",
  );
  assert.equal(resolvePlatformWebSearchUrl(""), undefined);
});

test("平台搜索请求不带 model，并夹紧 max_uses", () => {
  const body = buildPlatformWebSearchBody({
    query: "2026 React",
    maxUses: 99,
    allowedDomains: ["react.dev"],
  }) as Record<string, unknown>;
  assert.equal("model" in body, false);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "2026 React" }]);
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.type, "web_search_20260209");
  assert.equal(tools[0]?.max_uses, 10);
  assert.deepEqual(tools[0]?.allowed_domains, ["react.dev"]);
});

test("平台搜索响应归一化为 results/sources/summary/usage", () => {
  const parsed = parsePlatformWebSearchResponse({
    type: "message",
    content: [
      {
        type: "server_tool_use",
        id: "srv_1",
        name: "web_search",
        input: { query: "React 19" },
      },
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
          {
            type: "web_search_result",
            title: "React 19 duplicate",
            url: "https://react.dev/blog",
          },
        ],
      },
      {
        type: "text",
        text: "React 19 已发布。[官方说明](https://react.dev/blog)",
      },
    ],
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      server_tool_use: { web_search_requests: 1 },
    },
  });

  assert.equal(parsed.summary, "React 19 已发布。[官方说明](https://react.dev/blog)");
  assert.deepEqual(parsed.results, [
    {
      title: "React 19",
      url: "https://react.dev/blog",
      pageAge: "2 days ago",
    },
  ]);
  assert.deepEqual(parsed.sources, [{ url: "https://react.dev/blog", title: "React 19" }]);
  assert.equal(parsed.webSearchRequests, 1);
  assert.equal(parsed.inputTokens, 120);
  assert.equal(parsed.outputTokens, 30);
});

test("平台搜索错误体提取 Anthropic message", () => {
  assert.equal(
    platformWebSearchErrorMessage(
      { type: "error", error: { type: "authentication_error", message: "运行时密钥已过期" } },
      401,
    ),
    "运行时密钥已过期",
  );
  assert.equal(platformWebSearchErrorMessage({}, 500), "搜索网关返回 HTTP 500");
});

test("缺少 content 数组时明确失败", () => {
  assert.throws(() => parsePlatformWebSearchResponse({ type: "message" }), /content/);
});

test("page_age 为 null 且带 encrypted_content 时仍能归一化", () => {
  const parsed = parsePlatformWebSearchResponse({
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
            page_age: null,
            encrypted_content: "should-be-ignored",
          },
        ],
      },
      { type: "text", text: "React 19 已发布。" },
    ],
  });
  assert.deepEqual(parsed.results, [{ title: "React 19", url: "https://react.dev/blog" }]);
  assert.equal(parsed.results[0]?.pageAge, undefined);
});

test("平台错误按 error.code 分类", () => {
  const cases: Array<[string, number, string, string]> = [
    ["RUNTIME_KEY_EXPIRED", 401, "auth-refresh", "key"],
    ["RUNTIME_KEY_INVALID", 401, "auth-refresh", "key"],
    ["UPSTREAM_RATE_LIMITED", 429, "rate-limited", "backoff"],
    ["RUNTIME_SEARCH_TIMEOUT", 504, "unavailable", "none"],
    ["RUNTIME_SEARCH_UPSTREAM_UNREACHABLE", 502, "unavailable", "none"],
    ["UPSTREAM_UNAVAILABLE", 503, "unavailable", "none"],
    ["STUDENT_EXTERNAL_AI_BLOCKED", 403, "external-blocked", "none"],
    ["RUNTIME_CLASSROOM_INACTIVE", 403, "classroom-inactive", "none"],
    ["UPSTREAM_AUTH", 401, "upstream-auth", "none"],
    ["UPSTREAM_INVALID_REQUEST", 400, "invalid-request", "none"],
    ["UPSTREAM_NOT_FOUND", 404, "invalid-request", "none"],
  ];
  for (const [code, status, kind, retry] of cases) {
    const details = parsePlatformWebSearchError(
      { type: "error", error: { type: "api_error", message: `${code} happened`, code } },
      status,
    );
    const classification = classifyPlatformWebSearchError(details);
    assert.equal(classification.kind, kind, code);
    assert.equal(classification.retry, retry, code);
  }
});
