import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const cdp = process.env.LINGDONG_E2E_CDP || "http://127.0.0.1:9229";
const mock = process.env.LINGDONG_E2E_MOCK || "http://127.0.0.1:19090";
// 场景由命令行参数传入（不引入 cross-env 依赖）：limit-1 / limit-0 / unlimited。
const scenario = process.argv[2] || process.env.LINGDONG_E2E_QUOTA_SCENARIO || "limit-1";
for (const url of [cdp, mock]) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
    "E2E 只允许本地测试端点",
  );
}
const QUOTA_MESSAGE = "本节课发送次数已用完，请先保存当前想法或联系老师。";
const scenarioLimit = scenario === "unlimited" ? null : Number(scenario.replace("limit-", ""));
assert.ok(scenarioLimit === null || Number.isInteger(scenarioLimit), `未知额度场景: ${scenario}`);

const streamCount = async () => {
  const state = await (await fetch(`${mock}/__test/state`)).json();
  return state.requests.filter((request) => request.stream).length;
};

const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context.pages().find((page) => page.url().startsWith("data:text/html"));
  assert.ok(gate, "额度 E2E 需要新的隔离登录实例");
  await fetch(`${mock}/__test/quota`, {
    method: "POST",
    body: JSON.stringify({ limit: scenarioLimit, used: 0 }),
  });
  await gate.locator("#login").fill("mock");
  await gate.locator("#password").fill("mock");
  await gate.locator("#submit").click();
  let page;
  for (let attempt = 0; attempt < 60; attempt++) {
    page = context.pages().find((candidate) => candidate.url().startsWith("file:"));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(page, "主窗口必须创建");
  const exitOnboarding = page.getByRole("button", { name: "退出引导", exact: true });
  await page
    .getByRole("button", { name: "灵动ai 平台网关/mock-model", exact: true })
    .or(exitOnboarding)
    .first()
    .waitFor({ timeout: 30_000 });
  if (await exitOnboarding.isVisible()) await exitOnboarding.click();
  const input = page.locator('[data-testid="v4-composer-input"]');
  const send = page.getByRole("button", { name: "发送", exact: true });
  const quotaBanner = page.getByText(QUOTA_MESSAGE, { exact: true });

  const sendAndWaitForGateway = async (text, expectedTotal) => {
    await input.fill(text);
    await send.click();
    for (let attempt = 0; attempt < 120; attempt++) {
      if ((await streamCount()) >= expectedTotal) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail(`网关未观察到第 ${expectedTotal} 次流式请求`);
  };

  if (scenarioLimit === null) {
    // 无限额度：limit 为 null 不能被当成 0（历史回归是 Number("") === 0）。
    for (const index of [1, 2, 3]) {
      await sendAndWaitForGateway(`无限额度第 ${index} 条`, index);
    }
    await page.waitForTimeout(1_000);
    assert.equal(await quotaBanner.count(), 0, "无限额度不得出现用尽提示");
    assert.equal(await streamCount(), 3);
  } else if (scenarioLimit === 0) {
    await input.fill("额度为零的消息");
    await send.click();
    await quotaBanner.waitFor({ timeout: 15_000 });
    assert.equal(await streamCount(), 0, "limit=0 不得抵达平台网关");
  } else {
    await sendAndWaitForGateway("第一条课堂消息", 1);
    const before = await streamCount();
    assert.equal(before, 1, "首次发送必须恰好抵达平台网关一次");
    await input.fill("第二条课堂消息");
    await send.click();
    await quotaBanner.waitFor({ timeout: 15_000 });
    assert.equal(await streamCount(), before, "超限命令不得抵达平台网关");
  }

  // 允许把同一套断言跑在打包态实例上（用 LINGDONG_E2E_SESSION 指向对应 session.json）。
  const session = JSON.parse(
    await readFile(
      process.env.LINGDONG_E2E_SESSION || ".tmp/windows-platform-e2e/session.json",
      "utf8",
    ),
  );
  const directory = join(session.profile, ".zcode", "v2", "runtime", "lingdong-quota");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  if (scenarioLimit === 0) {
    assert.equal(files.length, 1);
  } else {
    const data = JSON.parse(await readFile(join(directory, files[0]), "utf8"));
    assert.equal(data.used, scenarioLimit === null ? 3 : 1);
  }
  console.log(
    JSON.stringify({
      pass: true,
      scenario,
      gatewayStreamRequests: await streamCount(),
      quotaMessageVisible: scenarioLimit === null ? false : true,
    }),
  );
} finally {
  await browser.close();
}
