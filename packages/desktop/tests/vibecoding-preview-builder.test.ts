import assert from "node:assert/strict";
import test from "node:test";
import { ASSET_FETCH_BRIDGE, LLM_BRIDGE, buildPreviewDocument } from "@zcode/shared";

const files = {
  "index.html": "<!doctype html><html><head></head><body><h1>demo</h1></body></html>",
};

test("作品预览注入 worksLlm，且平台授权优先于学生自己的 Key", () => {
  const html = buildPreviewDocument(files, "index.html", {
    worksLlm: { grant: "short-lived-grant", endpoint: "/platform/api/works-llm/chat" },
  });
  assert.match(html, /window\.__PLATFORM_WORK_LLM__=/u);
  assert.match(html, /short-lived-grant/u);
  assert.match(html, /\/platform\/api\/works-llm\/chat/u);
  assert.match(LLM_BRIDGE, /body\.usePlatform!==false/u);
  assert.match(ASSET_FETCH_BRIDGE, /__ZCODE_WORK_PREVIEW_NATIVE_ASSETS__/u);
});

test("没有 worksLlm 时不注入平台授权，旧行为保持", () => {
  const html = buildPreviewDocument(files, "index.html", { worksLlm: null });
  assert.doesNotMatch(html, /window\.__PLATFORM_WORK_LLM__=\{/u);
  assert.match(html, /还没有填写 API Key/u);
});