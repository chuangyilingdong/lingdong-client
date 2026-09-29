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
// 课堂形态在本套件里必须显式重置：同一个 mock 进程会被多个 E2E 复用，
// 上一个场景留下的 none/canvas/两场 ACTIVE 会污染主流程断言。
const classroomSetup = await fetch(`${mock}/__test/classrooms`, {
  method: "POST",
  body: JSON.stringify({ mode: "active", count: 1 }),
});
assert.equal(classroomSetup.status, 200, "重置课堂形态失败");

const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context
    .pages()
    .find((page) => /login\.html/.test(page.url()) || page.url().startsWith("data:text/html"));
  if (gate) {
    await gate.locator("#login").fill("mock");
    await gate.locator("#password").fill("mock");
    const created = context.waitForEvent("page", { timeout: 30_000 });
    await gate.locator("#submit").click();
    const main = await created;
    await main.waitForURL("file:**", { timeout: 30_000 });
  }
  const page = context
    .pages()
    .find((p) => p.url().startsWith("file:") && !/login\.html/.test(p.url()));
  assert.ok(page, "主窗口必须创建");
  const exitOnboarding = page.getByRole("button", { name: "退出引导", exact: true });
  await page
    .getByRole("button", { name: "Mock Model", exact: true })
    .or(exitOnboarding)
    .first()
    .waitFor({ timeout: 30_000 });
  if (await exitOnboarding.isVisible()) await exitOnboarding.click();
  await page.getByRole("button", { name: "Mock Model", exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("0/10", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("联调学生", { exact: true }).first().waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText("oevdrnor", { exact: false }).count(), 0);
  assert.equal(await page.title(), "灵动ai创作客户端");
  await page
    .getByText("向小灵提问，小灵即可开启创造", { exact: true })
    .waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText("你的主要工作方向是？", { exact: true }).count(), 0);
  assert.ok((await page.locator('img[alt="灵动ai"]').count()) > 0);
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
  await page.getByText("2/10", { exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText("灵动ai 平台网关", { exact: false }).count(), 0);
  // 课堂预设弹窗走 IPlatformService.classroom.getPresets()，与交作品同一条平台边界。
  await page.getByRole("button", { name: "课堂提示词预设", exact: true }).click();
  const presetsDialog = page.getByRole("dialog");
  await presetsDialog.getByText("读取课堂文件", { exact: true }).waitFor({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await presetsDialog.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});

  await page.getByRole("button", { name: "提交课堂作品", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认并提交 1 个文件", exact: true }).click();
  await dialog.getByText("作品已提交", { exact: false }).waitFor({ timeout: 20_000 });
  const result = await (await fetch(`${mock}/__test/state`)).json();
  assert.ok(result.requests.length > 0 && result.requests.every((r) => r.keyMatches));
  assert.ok(result.requests.some((r) => r.stream && r.toolReplies === 1));
  assert.ok(result.requests.some((r) => r.stream && r.toolReplies === 2));
  assert.ok(result.works.some((w) => w.name === "index.html" && w.cover === true));
  const directory = resolve(".tmp/windows-platform-e2e");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, "e2e-pass.png") });
  // 收尾用 Escape 关闭弹窗：此处只做清理，不把易受挂载时序影响的按钮点击当作断言。
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  console.log(
    JSON.stringify({
      pass: true,
      stream: true,
      twoToolRounds: true,
      submitWithCover: true,
      presetsFromPlatformService: true,
    }),
  );
} finally {
  await browser.close();
}
