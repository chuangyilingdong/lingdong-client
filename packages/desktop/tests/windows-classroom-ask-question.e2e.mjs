// 课堂 AskUserQuestion E2E：验证交互式选项卡没有被 ToolSearch 收进 deferred catalog。
// 前置：launch 脚本已启动应用与本地 mock（默认 CDP 9229 / mock 19090）。
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

const setup = await fetch(`${mock}/__test/classrooms`, {
  method: "POST",
  body: JSON.stringify({ mode: "active", count: 1 }),
});
assert.equal(setup.status, 200, "设置课堂形态失败");
await fetch(`${mock}/__test/mode`, { method: "POST", body: JSON.stringify({ mode: "ask" }) });
await fetch(`${mock}/__test/delay`, { method: "POST", body: JSON.stringify({ delayMs: 1200 }) });

const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context
    .pages()
    .find((page) => /login\.html/.test(page.url()) || page.url().startsWith("data:text/html"));
  assert.ok(gate, "需要全新的隔离登录实例");
  await gate.locator("#login").fill("mock");
  await gate.locator("#password").fill("mock");
  const created = context.waitForEvent("page", { timeout: 30_000 });
  await gate.locator("#submit").click();
  const page = await created;
  await page.waitForURL((url) => url.protocol === "file:" || url.hostname === "localhost", {
    timeout: 30_000,
  });

  const exitOnboarding = page.getByRole("button", { name: "退出引导", exact: true });
  await page
    .getByRole("button", { name: "Mock Model", exact: true })
    .or(exitOnboarding)
    .first()
    .waitFor({ timeout: 30_000 });
  if (await exitOnboarding.isVisible()) await exitOnboarding.click();
  await page.getByRole("button", { name: "Mock Model", exact: true }).waitFor({ timeout: 15_000 });

  await page
    .locator('[data-testid="v4-composer-input"]')
    .fill("请用选项卡帮我设置 AI 伙伴的人格。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const runningStatus = page.getByRole("status").filter({ hasText: "工作中" });
  await runningStatus.waitFor({ timeout: 5_000 });
  assert.match(await runningStatus.innerText(), /工作中\s+\d+\.\d+\s+秒/u);

  await page
    .getByText("你希望 AI 伙伴偏向哪种性格？", { exact: true })
    .waitFor({ timeout: 30_000 });
  assert.equal(await page.getByText("1 / 2", { exact: true }).count(), 1);
  await page.getByRole("option", { name: /温柔坚定/ }).click();

  await page.getByText("你希望 AI 伙伴怎么说话？", { exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText("2 / 2", { exact: true }).count(), 1);
  await page.getByRole("option", { name: /简洁直接/ }).click();

  await page.getByText("MOCK_ASK_USER_QUESTION_OK", { exact: false }).waitFor({ timeout: 30_000 });

  const state = await (await fetch(`${mock}/__test/state`)).json();
  assert.ok(state.requests.length >= 2, "AskUserQuestion 提交后 Agent 应继续下一轮请求");
  const askRequest = state.requests.find((request) =>
    request.tools?.some((tool) => tool.name === "AskUserQuestion"),
  );
  assert.ok(askRequest, "课堂 Provider 请求体必须直接包含 AskUserQuestion");

  console.log(
    JSON.stringify({
      pass: true,
      askUserQuestionResident: true,
      multiQuestionTabs: true,
      answersContinuedTurn: true,
    }),
  );
} finally {
  await browser.close().catch(() => {});
}
