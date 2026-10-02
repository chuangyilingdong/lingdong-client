// 课堂结束 E2E：老师结束课堂后，客户端必须返回登录门并显示一次性提示。
// 前置：launch 脚本已启动应用与本地 mock，且 LINGDONG_CLASSROOM_POLL_MS=1000。
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const cdp = process.env.LINGDONG_E2E_CDP || "http://127.0.0.1:9229";
const mock = process.env.LINGDONG_E2E_MOCK || "http://127.0.0.1:19090";
for (const url of [cdp, mock]) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
    "E2E 只允许本地测试端点",
  );
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findGatePage() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const pages = await (await fetch(`${cdp}/json/list`)).json();
      if (
        Array.isArray(pages) &&
        pages.some((page) =>
          String(page?.url || "").startsWith("data:text/html") ||
          String(page?.url || "").includes("/gate/login.html") ||
          String(page?.url || "").includes("/resources/gate/login.html"),
        )
      ) {
        return true;
      }
    } catch {
      // 应用重启期间 CDP 会短暂断开，继续等。
    }
    await sleep(500);
  }
  return false;
}

const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context
    .pages()
    .find(
      (page) =>
        page.url().startsWith("data:text/html") ||
        page.url().includes("/gate/login.html") ||
        page.url().includes("/resources/gate/login.html"),
    );
  assert.ok(gate, "需要全新的隔离登录实例");
  await gate.locator("#login").fill("mock");
  await gate.locator("#password").fill("mock");
  await gate.locator("#submit").click();

  let main;
  for (let attempt = 0; attempt < 60; attempt++) {
    main = context.pages().find((page) => !/login\.html/.test(page.url()) && page !== gate);
    if (main) break;
    await sleep(500);
  }
  assert.ok(main, "登录后必须进入主窗口");

  const ended = await fetch(`${mock}/__test/classrooms`, {
    method: "POST",
    body: JSON.stringify({ mode: "none" }),
  });
  assert.equal(ended.status, 200, "模拟老师结束课堂失败");

  const gateSeen = await findGatePage();
  assert.equal(gateSeen, true, "课堂结束后必须重启到登录门");

  const relaunched = await chromium.connectOverCDP(cdp);
  try {
    const nextGate = relaunched
      .contexts()[0]
      .pages()
      .find(
        (page) =>
          page.url().startsWith("data:text/html") ||
          page.url().includes("/gate/login.html") ||
          page.url().includes("/resources/gate/login.html"),
      );
    assert.ok(nextGate, "重启后必须存在登录门");
    await nextGate
      .locator("#status")
      .filter({ hasText: "课堂已结束，请重新登录。" })
      .waitFor({ timeout: 20_000 });
    console.log(JSON.stringify({ pass: true, returnedToGate: true, noticeShown: true }));
  } finally {
    await relaunched.close().catch(() => {});
  }
} finally {
  await browser.close().catch(() => {});
}
