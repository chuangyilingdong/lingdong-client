import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldOpenProviderLoginEntry } from "../src/lib/modelProviderAvailability.js";

test("平台或个人 Provider 可用时不要求选择厂商 family/重复 OAuth 登录", () => {
  for (const hasUser of [false, true]) {
    for (const hasProviderFamilyDomain of [false, true]) {
      assert.equal(
        shouldOpenProviderLoginEntry({ hasUsableProvider: true, hasUser, hasProviderFamilyDomain }),
        false,
      );
    }
  }
});

test("没有可用模型且没有完整登录状态时仍保留连接引导", () => {
  assert.equal(
    shouldOpenProviderLoginEntry({
      hasUsableProvider: false,
      hasUser: false,
      hasProviderFamilyDomain: false,
    }),
    true,
  );
  assert.equal(
    shouldOpenProviderLoginEntry({
      hasUsableProvider: false,
      hasUser: false,
      hasProviderFamilyDomain: true,
    }),
    true,
  );
  assert.equal(
    shouldOpenProviderLoginEntry({
      hasUsableProvider: false,
      hasUser: true,
      hasProviderFamilyDomain: false,
    }),
    true,
  );
});

test("完整 OAuth 登录状态仍复用现有启动语义", () => {
  assert.equal(
    shouldOpenProviderLoginEntry({
      hasUsableProvider: false,
      hasUser: true,
      hasProviderFamilyDomain: true,
    }),
    false,
  );
});
