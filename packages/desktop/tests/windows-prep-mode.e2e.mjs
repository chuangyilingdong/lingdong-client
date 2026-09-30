import assert from "node:assert/strict";
import { chromium } from "playwright-core";

// 老师端「VibeCoding 备课」E2E：
//   应用被 lingdong://open?prep=1&lesson=<id> 冷启动 → 取备课上下文 →
//   进创作环境，但发送按钮不存在、回车也发不出去、且一个网关请求都没有。
//
// 前置：launch 脚本已带 LINGDONG_E2E_APP_ARGS='lingdong://open?prep=1&lesson=...' 启动应用。
const cdp = process.env.LINGDONG_E2E_CDP || "http://127.0.0.1:9229";
const mock = process.env.LINGDONG_E2E_MOCK || "http://127.0.0.1:19090";
const lessonId = process.env.LINGDONG_E2E_PREP_LESSON || "lesson-prep-e2e";
for (const url of [cdp, mock]) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
    "E2E 只允许本地测试端点",
  );
}

const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context
    .pages()
    .find((page) => /login\.html/.test(page.url()) || page.url().startsWith("data:text/html"));
  assert.ok(gate, "需要全新的隔离登录实例（老师账号登录）");

  await gate.locator("#login").fill("mock");
  await gate.locator("#password").fill("mock");
  const created = context.waitForEvent("page", { timeout: 30_000 });
  await gate.locator("#submit").click();
  const main = await created;
  await main.waitForURL("file:**", { timeout: 30_000 });

  const exitOnboarding = main.getByRole("button", { name: "退出引导", exact: true });
  await main
    .locator('[data-testid="v4-composer-input"]')
    .waitFor({ timeout: 30_000 });
  if (await exitOnboarding.isVisible().catch(() => false)) await exitOnboarding.click();

  // 1) 备课标记必须可见（老师要能一眼看出这是备课、不会生成）。
  await main
    .getByText("备课模式 · 不生成", { exact: false })
    .waitFor({ timeout: 20_000 });

  // 2) 备课模式没有 gateway，模型必然不可用——但绝不能让老师看到
  //    「当前没有可用模型 / 开通套餐 / 配置自定义模型」，那是学生路径的文案。
  assert.equal(
    await main.getByText("当前没有可用模型", { exact: false }).count(),
    0,
    "备课模式不得显示「无可用模型 / 开通套餐」提示",
  );

  // 2) 发送按钮不存在：备课模式整个不渲染它。
  assert.equal(
    await main.getByRole("button", { name: "发送", exact: true }).count(),
    0,
    "备课模式不得渲染发送按钮",
  );

  // 3) 客户端确实按契约带了 prep=1&lessonId=<id> 去取上下文。
  const state = await (await fetch(`${mock}/__test/state`)).json();
  assert.ok(
    state.prepContexts.some((item) => item.lessonId === lessonId),
    `客户端必须带 prep=1&lessonId=${lessonId} 取上下文，实际：${JSON.stringify(state.prepContexts)}`,
  );

  // 4) 一个网关请求都不能有：备课上下文没有 gateway，客户端也不该尝试。
  assert.equal(
    state.requests.length,
    0,
    `备课模式不得发任何网关请求，实际：${JSON.stringify(state.requests)}`,
  );

  console.log(
    JSON.stringify({
      pass: true,
      prepMode: true,
      sendHidden: true,
      lessonFromDeepLink: lessonId,
      noGatewayRequest: true,
    }),
  );
} finally {
  await browser.close();
}
