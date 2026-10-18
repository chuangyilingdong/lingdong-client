import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLingdongWebSearchSettings } from "../src/main/lingdongWebSearchSettings.js";

const classroom = { id: "classroom-1" };

test("优先使用平台下发的 searchUrl", () => {
  const settings = resolveLingdongWebSearchSettings({
    classroom,
    gateway: {
      baseUrl: "https://aicyld.com/api/gateway/v1",
      key: "runtime-key",
      searchUrl: "https://aicyld.com/api/gateway/v1/search/messages",
    },
    features: { webSearch: true },
  });
  assert.deepEqual(settings, {
    url: "https://aicyld.com/api/gateway/v1/search/messages",
    enabled: true,
  });
});

test("没有 searchUrl 时从 baseUrl 派生且不产生双斜杠", () => {
  const settings = resolveLingdongWebSearchSettings({
    classroom,
    gateway: { baseUrl: "https://aicyld.com/api/gateway/v1/", key: "runtime-key" },
  });
  assert.deepEqual(settings, {
    url: "https://aicyld.com/api/gateway/v1/search/messages",
    enabled: true,
  });
});

test("features.webSearch=false 时备课/画布/未开课都隐藏 WebSearch", () => {
  const settings = resolveLingdongWebSearchSettings({
    classroom,
    gateway: {
      baseUrl: "https://aicyld.com/api/gateway/v1",
      key: "runtime-key",
      searchUrl: "https://aicyld.com/api/gateway/v1/search/messages",
    },
    features: { webSearch: false },
  });
  assert.equal(settings.enabled, false);
});

test("没有课堂或没有运行时 key 时不启用", () => {
  assert.equal(
    resolveLingdongWebSearchSettings({
      classroom: null,
      gateway: { baseUrl: "https://aicyld.com/api/gateway/v1" },
    }).enabled,
    false,
  );
  assert.equal(
    resolveLingdongWebSearchSettings({
      classroom,
      gateway: { baseUrl: "https://aicyld.com/api/gateway/v1" },
      features: { webSearch: true },
    }).enabled,
    false,
  );
});
