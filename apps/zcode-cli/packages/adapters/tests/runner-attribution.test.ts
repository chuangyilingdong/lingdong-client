import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRequestSessionType } from "@zcode/contracts";
import { createModelRequestAttributionHeaders } from "../src/model/runner-attribution.js";
import type { ModelStatusContext } from "../src/model/runner-status.js";

function context(overrides: Partial<ModelStatusContext> = {}): ModelStatusContext {
  return {
    traceId: "trace-1",
    queryId: "query_1",
    sessionId: "sess_1",
    turnId: "turn_1",
    requestId: "request-1",
    providerId: "lingdong-platform-gateway",
    modelId: "classroom-model",
    modelRequestSessionType: ModelRequestSessionType.Main,
    baseURL: "https://aicyld.com/api/gateway/v1",
    providerKind: "openai-compatible",
    transport: "sse",
    maxAttempts: 1,
    modelCall: {} as ModelStatusContext["modelCall"],
    ...overrides,
  };
}

test("同一次发送的模型请求携带稳定 x-zcode-send-id", () => {
  const first = createModelRequestAttributionHeaders(context());
  const retry = createModelRequestAttributionHeaders(context({ requestId: "request-2" }));
  assert.equal(first["x-zcode-send-id"], "turn_1");
  assert.equal(retry["x-zcode-send-id"], first["x-zcode-send-id"]);
  assert.notEqual(retry["x-request-id"], first["x-request-id"]);
});

test("没有 turnId 的内部请求不伪造发送次数", () => {
  const headers = createModelRequestAttributionHeaders(context({ turnId: undefined }));
  assert.equal("x-zcode-send-id" in headers, false);
});
