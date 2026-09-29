// 退出登录 / 换号 E2E：退出 → 通知平台注销 → 重启回到登录门 → 换账号再次进入。
//
// 注意：Playwright 的 connectOverCDP 一旦 browser.close() 会把 Electron 应用一起关掉，
// 所以本脚本只在最后关闭连接，轮询期间复用同一个连接。
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
const platformState = async () => (await fetch(`${mock}/__test/state`)).json();

/** 应用重启期间端口会短暂断开，这里重试连接；失败时没有需要清理的资源。 */
async function connect(attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await chromium.connectOverCDP(cdp);
    } catch {
      await sleep(500);
    }
  }
  assert.fail("无法连接 Electron 调试端口");
}

/**
 * 重启期间旧连接会失效：页面列表连续为空时重连，避免一直盯着已死连接。
 * 注意不能调 browser.close()——那会把 Electron 应用一起关掉。
 */
async function waitForPageAfterRestart(predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let browser = null;
  let emptyStreak = 0;
  while (Date.now() < deadline) {
    if (!browser) {
      try {
        browser = await chromium.connectOverCDP(cdp);
        emptyStreak = 0;
      } catch {
        await sleep(700);
        continue;
      }
    }
    let pages = [];
    try {
      pages = browser.contexts()[0]?.pages() ?? [];
    } catch {
      browser = null;
      await sleep(700);
      continue;
    }
    if (pages.length === 0) {
      emptyStreak += 1;
      // 连续多次拿不到任何页面 → 判定为旧连接，重连。
      if (emptyStreak >= 5) browser = null;
      await sleep(700);
      continue;
    }
    emptyStreak = 0;
    const page = pages.find(predicate);
    if (page) return { browser, page };
    await sleep(700);
  }
  assert.fail(`${label} 超时`);
}

async function waitForPage(browser, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser.contexts()[0]?.pages().find(predicate);
    if (page) return page;
    await sleep(500);
  }
  assert.fail(`${label} 超时`);
}

const isGateUrl = (page) => page.url().startsWith("data:text/html");
const isMainUrl = (page) => page.url().startsWith("file:");

const login = async (page, loginName) => {
  await page.locator("#login").fill(loginName);
  await page.locator("#password").fill(loginName);
  await page.locator("#submit").click();
};

const logoutBefore = (await platformState()).logoutCalls.length;

// 1) 登录进入课堂
const first = await connect();
const gate = await waitForPage(first, isGateUrl, "登录门");
await login(gate, "mock");
const main = await waitForPage(first, isMainUrl, "主窗口");
const modelButton = main.getByRole("button", { name: /灵动ai 平台网关\/mock-model/ });
const exitOnboarding = main.getByRole("button", { name: "退出引导", exact: true });
await modelButton.or(exitOnboarding).first().waitFor({ timeout: 30_000 });
if (await exitOnboarding.isVisible()) await exitOnboarding.click();

// 2) 退出登录（带确认弹窗）
await main.getByRole("button", { name: "退出登录", exact: true }).click();
const dialog = main.getByRole("dialog");
await dialog.waitFor({ timeout: 15_000 });
await dialog.getByRole("button", { name: "退出登录", exact: true }).click();

// 3) 平台必须收到注销请求
let loggedOut = false;
for (let attempt = 0; attempt < 60; attempt++) {
  const snapshot = await platformState();
  if (snapshot.logoutCalls.length > logoutBefore) {
    assert.ok(
      String(snapshot.logoutCalls.at(-1).authorization || "").startsWith("Bearer "),
      "注销请求必须带平台 token",
    );
    loggedOut = true;
    break;
  }
  await sleep(500);
}
assert.ok(loggedOut, "客户端未通知平台注销 token");

// 4) 重启后必须回到登录门（不能带着上一个学生的会话直接进课堂）
first.close().catch(() => {});
const restarted = await waitForPageAfterRestart(isGateUrl, "重启后的登录门");
const second = restarted.browser;
const gateAgain = restarted.page;

// 5) 换账号再次进入
await login(gateAgain, "mock-another");
const mainAgain = await waitForPage(second, isMainUrl, "换号后的主窗口");
await mainAgain
  .getByRole("button", { name: /灵动ai 平台网关\/mock-model/ })
  .or(mainAgain.getByRole("button", { name: "退出引导", exact: true }))
  .first()
  .waitFor({ timeout: 30_000 });
await second.close().catch(() => {});

console.log(
  JSON.stringify({
    pass: true,
    platformLogoutCalled: true,
    returnedToLoginGate: true,
    reloginSucceeded: true,
  }),
);
