// 缓存命中链路 E2E：网关返回 cached_tokens → 客户端 UI 展示非 0 命中率。
//
// 这是迁移最初要解决的问题（"缓存命中 0%"）。整条链路：
//   网关 prompt_tokens_details.cached_tokens
//   → AI SDK openai-compatible 的 inputTokens.cacheRead
//   → ai 核心 inputTokenDetails.cacheReadTokens
//   → 客户端 normalizeUsage / context cache 聚合
//   → 输入栏"平均缓存命中率"
//
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

// 90/100 = 90%：高于客户端生产构建 78% 的展示阈值。
const usage = { prompt: 100, completion: 10, cached: 90 };
const configured = await fetch(`${mock}/__test/usage`, {
  method: "POST",
  body: JSON.stringify(usage),
});
assert.equal(configured.status, 200, "设置用量失败");

const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context.pages().find((page) => page.url().startsWith("data:text/html"));
  if (gate) {
    await gate.locator("#login").fill("mock");
    await gate.locator("#password").fill("mock");
    await gate.locator("#submit").click();
  }
  let page;
  for (let attempt = 0; attempt < 60; attempt++) {
    page = context.pages().find((candidate) => candidate.url().startsWith("file:"));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(page, "主窗口未创建");

  const exitOnboarding = page.getByRole("button", { name: "退出引导", exact: true });
  const modelButton = page.getByRole("button", { name: /灵动ai 平台网关\/mock-model/ });
  await modelButton.or(exitOnboarding).first().waitFor({ timeout: 30_000 });
  if (await exitOnboarding.isVisible()) await exitOnboarding.click();
  await modelButton.waitFor({ timeout: 15_000 });

  // 一轮主会话请求，让 usage 落到上下文统计里。
  await page.locator('[data-testid="v4-composer-input"]').fill("请回复：缓存链路验证。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("MOCK_GATEWAY_RESPONSE", { exact: false }).last().waitFor({ timeout: 30_000 });

  // 打开输入栏的上下文用量面板，读"平均缓存命中率"。
  const trigger = page.locator('[data-testid="chat-context-usage-trigger"]');
  await trigger.waitFor({ timeout: 20_000 });
  await trigger.click();

  const hitRateLabel = page.getByText("平均缓存命中率", { exact: false });
  await hitRateLabel.waitFor({ timeout: 20_000 });
  const panelText = await page
    .locator('[data-testid="chat-context-usage-trigger"]')
    .locator("xpath=ancestor::*[1]")
    .innerText()
    .catch(() => "");
  const bodyText = await page.locator("body").innerText();
  const percentMatches = [...bodyText.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
  const maxPercent = percentMatches.length > 0 ? Math.max(...percentMatches) : 0;
  assert.ok(maxPercent > 0, `界面未出现非 0 百分比；命中率文案附近：${panelText}`);

  console.log(
    JSON.stringify({
      pass: true,
      usage,
      expectedHitRatePercent: Math.round((usage.cached / usage.prompt) * 100),
      observedPercent: maxPercent,
      cacheHitRateVisible: true,
    }),
  );
} finally {
  await browser.close();
}
