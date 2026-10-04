import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePrimaryWindowCreationDecision } from "../src/main/primaryWindowCoordinator.js";

test("登录门等待时阻止主窗口创建", () => {
  assert.equal(
    resolvePrimaryWindowCreationDecision({
      forceUpdateBlocked: false,
      lingdongGateLoginPending: true,
    }),
    "block-lingdong-gate",
  );
});

test("登录门完成后允许创建主窗口", () => {
  assert.equal(
    resolvePrimaryWindowCreationDecision({
      forceUpdateBlocked: false,
      lingdongGateLoginPending: false,
    }),
    "allow",
  );
});

test("强制升级优先于登录门阻止主窗口", () => {
  assert.equal(
    resolvePrimaryWindowCreationDecision({
      forceUpdateBlocked: true,
      lingdongGateLoginPending: true,
    }),
    "block-force-update",
  );
});
