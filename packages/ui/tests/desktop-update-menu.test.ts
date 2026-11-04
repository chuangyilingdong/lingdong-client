import assert from "node:assert/strict";
import { test } from "node:test";
import { getUpdateMenuLabelId } from "../src/lib/desktopUpdateMenu.js";

test("启动更新门结束后更新入口显示仅启动检查", () => {
  assert.equal(
    getUpdateMenuLabelId({ kind: "idle", enabled: false }),
    "titleBar.menu.help.checkForUpdatesOnStartup",
  );
});

test("启动阶段仍显示检查更新", () => {
  assert.equal(
    getUpdateMenuLabelId({ kind: "idle", enabled: true }),
    "titleBar.menu.help.checkForUpdates",
  );
});
