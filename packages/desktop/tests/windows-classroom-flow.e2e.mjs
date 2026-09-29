// 前提：已构建 Windows 源码并用独立测试数据根启动 Electron；mock 只使用本地虚构账号。
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const cdp = process.env.LINGDONG_E2E_CDP || "http://127.0.0.1:9229";
const mock = process.env.LINGDONG_E2E_MOCK || "http://127.0.0.1:19090";
for (const url of [cdp, mock]) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
    "E2E 只允许本地测试端点",
  );
}
const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context.pages().find((page) => page.url().startsWith("data:text/html"));
  if (gate) {
    await gate.locator("#login").fill("mock");
    await gate.locator("#password").fill("mock");
    const created = context.waitForEvent("page", { timeout: 30_000 });
    await gate.locator("#submit").click();
    const main = await created;
    await main.waitForURL("file:**", { timeout: 30_000 });
  }
  const page = context.pages().find((p) => p.url().startsWith("file:"));
  assert.ok(page, "主窗口必须创建");
  const exitOnboarding = page.getByRole("button", { name: "退出引导", exact: true });
  await page
    .getByRole("button", { name: "灵动ai 平台网关/mock-model", exact: true })
    .or(exitOnboarding)
    .first()
    .waitFor({ timeout: 30_000 });
  if (await exitOnboarding.isVisible()) await exitOnboarding.click();
  await page
    .getByRole("button", { name: "灵动ai 平台网关/mock-model", exact: true })
    .waitFor({ timeout: 15_000 });
  assert.equal(await page.title(), "灵动ai创作客户端");
  await fetch(`${mock}/__test/mode`, { method: "POST", body: JSON.stringify({ mode: "text" }) });
  await page.locator('[data-testid="v4-composer-input"]').fill("请回复：课堂联调成功。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page
    .getByText("MOCK_GATEWAY_RESPONSE", { exact: false })
    .last()
    .waitFor({ timeout: 30_000 });
  await fetch(`${mock}/__test/mode`, { method: "POST", body: JSON.stringify({ mode: "tools" }) });
  await page
    .locator('[data-testid="v4-composer-input"]')
    .fill("请读取课堂目录中的 notes.txt 和 index.html，然后总结。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page
    .getByText("MOCK_TWO_TOOL_ROUNDS_OK", { exact: false })
    .last()
    .waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "提交课堂作品", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "提交 1 个文件", exact: true }).click();
  await dialog.getByText("作品已提交", { exact: false }).waitFor({ timeout: 20_000 });
  const result = await (await fetch(`${mock}/__test/state`)).json();
  assert.ok(result.requests.length > 0 && result.requests.every((r) => r.keyMatches));
  assert.ok(result.requests.some((r) => r.stream && r.toolReplies === 1));
  assert.ok(result.requests.some((r) => r.stream && r.toolReplies === 2));
  assert.ok(result.works.some((w) => w.name === "index.html" && w.cover === true));
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const directory = resolve(".tmp/windows-platform-e2e");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, "e2e-pass.png") });
  console.log(
    JSON.stringify({ pass: true, stream: true, twoToolRounds: true, submitWithCover: true }),
  );
} finally {
  await browser.close();
}
