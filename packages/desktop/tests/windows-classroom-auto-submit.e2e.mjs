// 课堂结束自动补交 E2E：
// 前置：已用独立测试数据根启动 Electron、启动 mock-platform，并设置 LINGDONG_CLASSROOM_POLL_MS=1000。
// 场景：课堂内任务生成 index.html -> 不手动提交 -> 老师结束课堂 -> 客户端自动补交 -> 返回登录门。
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const cdp = process.env.LINGDONG_E2E_CDP || "http://127.0.0.1:9229";
const mock = process.env.LINGDONG_E2E_MOCK || "http://127.0.0.1:19090";
const scenario = process.argv[2] || "auto-submit";
assert.ok(
  ["auto-submit", "manual-skip"].includes(scenario),
  "场景只能是 auto-submit 或 manual-skip",
);
const manualSkip = scenario === "manual-skip";
for (const url of [cdp, mock]) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
    "E2E 只允许本地测试端点",
  );
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findGatePage(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`${cdp}/json/list`)).json();
      const gate = Array.isArray(pages)
        ? pages.find(
            (page) =>
              String(page?.url || "").startsWith("data:text/html") ||
              String(page?.url || "").includes("/gate/login.html") ||
              String(page?.url || "").includes("/resources/gate/login.html"),
          )
        : null;
      if (gate) return gate;
    } catch {
      // 应用重启期间 CDP 会短暂断开。
    }
    await sleep(500);
  }
  return null;
}

const classroomSetup = await fetch(`${mock}/__test/classrooms`, {
  method: "POST",
  body: JSON.stringify({ mode: "active", count: 1 }),
});
assert.equal(classroomSetup.status, 200, "重置课堂形态失败");
await fetch(`${mock}/__test/mode`, { method: "POST", body: JSON.stringify({ mode: "tools" }) });

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
    await main.waitForURL((url) => url.protocol === "file:" || url.hostname === "localhost", {
      timeout: 30_000,
    });
  }
  const page = context
    .pages()
    .find(
      (item) =>
        (item.url().startsWith("file:") || item.url().startsWith("http://localhost:5174")) &&
        !/login\.html/.test(item.url()),
    );
  assert.ok(page, "主窗口必须创建");

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
    .fill("请读取并更新 index.html，然后总结。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const allowProjectWrites = page.locator('button[aria-label="始终允许本项目"]');
  await allowProjectWrites
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => allowProjectWrites.click())
    .catch(() => {});
  await page
    .getByText("MOCK_TWO_TOOL_ROUNDS_OK", { exact: false })
    .last()
    .waitFor({ timeout: 30_000 });

  let worksBeforeEnd = 0;
  if (manualSkip) {
    await page.getByRole("button", { name: "提交课堂作品", exact: true }).click();
    const submitDialog = page.getByRole("dialog");
    await submitDialog.getByText("index.html", { exact: true }).waitFor({ timeout: 10_000 });
    await submitDialog.getByRole("button", { name: "确认并提交主作品", exact: true }).click();
    await submitDialog.getByText("作品已提交", { exact: false }).waitFor({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await submitDialog.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    const stateBeforeEnd = await (await fetch(`${mock}/__test/state`)).json();
    worksBeforeEnd = stateBeforeEnd.works.length;
    assert.ok(worksBeforeEnd > 0, "手动提交后平台必须已有作品");
  }

  const ended = await fetch(`${mock}/__test/classrooms`, {
    method: "POST",
    body: JSON.stringify({ mode: "none" }),
  });
  assert.equal(ended.status, 200, "模拟老师结束课堂失败");

  const endedGate = await findGatePage();
  assert.ok(endedGate, "自动提交完成后必须返回登录门");
  await sleep(500);

  const state = await (await fetch(`${mock}/__test/state`)).json();
  const autoSubmissions = state.workSubmissions.filter(
    (item) => item.autoSubmit === true && item.sessionId === "classroom-e2e",
  );
  let submission;
  if (manualSkip) {
    assert.equal(
      autoSubmissions.length,
      0,
      `手动已提交后不得再发自动补交请求：${JSON.stringify(
        state.workSubmissions.map((item) => ({
          autoSubmit: item.autoSubmit,
          taskId: item.taskId,
          name: item.name,
          copyrightConfirmed: item.copyrightConfirmed,
        })),
      )}`,
    );
    assert.equal(state.works.length, worksBeforeEnd, "自动流程不得覆盖或新增作品");
    submission = state.works.find(
      (item) => item.autoSubmitted === false && item.copyrightConfirmed === true,
    );
    assert.ok(submission, "手动作品必须保持版权已确认状态");
    assert.equal(submission.name, "index.html");
  } else {
    assert.equal(autoSubmissions.length, 1, "每个本课任务应自动补交一次");
    submission = autoSubmissions[0];
    assert.equal(submission.autoSubmit, true, "必须带 autoSubmit=true");
    assert.equal(submission.sessionId, "classroom-e2e", "必须带刚结束的课堂 id");
    assert.equal(submission.copyrightConfirmed, false, "自动提交必须保留未确认版权");
    assert.ok(submission.taskId, "自动提交必须带 taskId");
    assert.equal(submission.name, "index.html");
    const files = new Map(submission.files.map((file) => [file.name, file]));
    for (const required of [
      "index.html",
      "style.css",
      "assets/hero.png",
      "assets/clip.mp4",
      "app.js",
    ]) {
      assert.ok(files.has(required), `自动提交缺少素材：${required}`);
    }
    const autoWorks = state.works.filter(
      (item) => item.autoSubmitted === true && item.taskId === submission.taskId,
    );
    assert.equal(autoWorks.length, 1);
    assert.equal(autoWorks[0].taskId, submission.taskId);
    assert.equal(autoWorks[0].copyrightConfirmed, false);
  }

  const relaunched = await chromium.connectOverCDP(cdp);
  try {
    const nextGate = relaunched
      .contexts()[0]
      .pages()
      .find(
        (item) =>
          item.url().startsWith("data:text/html") ||
          item.url().includes("/gate/login.html") ||
          item.url().includes("/resources/gate/login.html"),
      );
    assert.ok(nextGate, "重启后必须存在登录门");
    await nextGate
      .locator("#status")
      .filter({ hasText: "课堂已结束，请重新登录。" })
      .waitFor({ timeout: 20_000 });
    console.log(
      JSON.stringify({
        pass: true,
        scenario,
        autoSubmitted: !manualSkip,
        manualSubmissionPreserved: manualSkip,
        returnedToGate: true,
        taskId: submission.taskId,
        fileCount: manualSkip ? undefined : submission.files.length,
      }),
    );
  } finally {
    await relaunched.close().catch(() => {});
  }
} finally {
  await browser.close().catch(() => {});
}
