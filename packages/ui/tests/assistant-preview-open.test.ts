import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldOpenAssistantHtmlInBrowser } from "../src/lib/assistantPreviewCards.js";

const htmlPath = "C:\\Users\\student\\Documents\\灵动ai创作\\课堂\\index.html";

test("本地课堂 identity 的 HTML 进入内嵌浏览器", () => {
  assert.equal(
    shouldOpenAssistantHtmlInBrowser({
      path: htmlPath,
      workspaceIdentity: "user_123:csession_456",
    }),
    true,
  );
});

test("普通本地 HTML 进入内嵌浏览器", () => {
  assert.equal(shouldOpenAssistantHtmlInBrowser({ path: htmlPath }), true);
});

test("远程 identity 或 remoteSessionId 不进入本地内嵌浏览器", () => {
  assert.equal(
    shouldOpenAssistantHtmlInBrowser({
      path: "/home/student/class/index.html",
      workspaceIdentity: "remote:ssh:example.com:22:student:/home/student/class",
    }),
    false,
  );
  assert.equal(
    shouldOpenAssistantHtmlInBrowser({
      path: htmlPath,
      workspaceRemoteSessionId: "remote-session-1",
    }),
    false,
  );
});

test("非 HTML 文件不进入浏览器", () => {
  assert.equal(
    shouldOpenAssistantHtmlInBrowser({
      path: "C:\\Users\\student\\Documents\\课堂\\notes.md",
      workspaceIdentity: "user_123:csession_456",
    }),
    false,
  );
});
