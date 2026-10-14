import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderBusinessErrorFetch } from "../../../apps/zcode-cli/packages/adapters/src/model/model-execution.js";

function request(input: RequestInfo | URL): Request {
  return input instanceof Request ? input : new Request(input);
}

test("401 时刷新一次 key 并用新 key 重试一次", async () => {
  let currentKey = "old-key";
  const seen: string[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    const auth = request(input).headers.get("authorization") ?? "";
    seen.push(auth);
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { code: "RUNTIME_KEY_EXPIRED" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const wrapped = createProviderBusinessErrorFetch({
    providerId: "lingdong-platform-gateway",
    providerKind: "openai-compatible",
    fetch: fetchImpl,
    resolveApiKey: () => currentKey,
    refreshApiKey: async () => {
      currentKey = "new-key";
    },
  });

  const response = await wrapped(
    new Request("https://example.com/v1/chat/completions", { method: "POST", body: "{}" }),
  );

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(seen[0], "Bearer old-key");
  assert.equal(seen[1], "Bearer new-key");
});

test("非 401 不触发刷新重试", async () => {
  let refreshes = 0;
  let calls = 0;
  const wrapped = createProviderBusinessErrorFetch({
    providerId: "lingdong-platform-gateway",
    providerKind: "openai-compatible",
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    },
    resolveApiKey: () => "key",
    refreshApiKey: async () => {
      refreshes += 1;
    },
  });

  await wrapped(
    new Request("https://example.com/v1/chat/completions", { method: "POST", body: "{}" }),
  );
  assert.equal(calls, 1);
  assert.equal(refreshes, 0);
});
