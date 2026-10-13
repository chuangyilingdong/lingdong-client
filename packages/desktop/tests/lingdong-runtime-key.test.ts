import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readRuntimeKeyExpiresAt,
  shouldRefreshRuntimeKey,
} from "../src/main/lingdongRuntimeKey.js";

function runtimeKey(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `rt1.${body}.signature`;
}

test("运行时密钥可解析 exp", () => {
  assert.equal(readRuntimeKeyExpiresAt(runtimeKey({ exp: 1_700_000_000_000 })), 1_700_000_000_000);
});

test("非法密钥不解析 exp", () => {
  assert.equal(readRuntimeKeyExpiresAt("not-a-runtime-key"), null);
  assert.equal(readRuntimeKeyExpiresAt(runtimeKey({})), null);
});

test("剩余时间进入续签窗口时必须刷新", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRefreshRuntimeKey({
      key: runtimeKey({ exp: now + 30 * 60 * 1000 }),
      now,
      lastRefreshAt: now - 60 * 60 * 1000,
      refreshMarginMs: 60 * 60 * 1000,
      fallbackIntervalMs: 30 * 60 * 1000,
    }),
    true,
  );
});

test("密钥仍远离过期时不刷新", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRefreshRuntimeKey({
      key: runtimeKey({ exp: now + 5 * 60 * 60 * 1000 }),
      now,
      lastRefreshAt: now,
      refreshMarginMs: 60 * 60 * 1000,
      fallbackIntervalMs: 30 * 60 * 1000,
    }),
    false,
  );
});

test("无法解析 exp 时按兜底周期刷新", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRefreshRuntimeKey({
      key: "legacy-key",
      now,
      lastRefreshAt: now - 31 * 60 * 1000,
      refreshMarginMs: 60 * 60 * 1000,
      fallbackIntervalMs: 30 * 60 * 1000,
    }),
    true,
  );
});
