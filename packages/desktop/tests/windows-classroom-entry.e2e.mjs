// 课堂进入 E2E：验证"一个学生只有一个进行中课堂、客户端不存在选择"。
//
// 用法：node packages/desktop/tests/windows-classroom-entry.e2e.mjs <scenario>
//   single      只有一个进行中课堂 → 直接进入，无任何选择 UI
//   two-active  两场 ACTIVE（绕过校验的历史脏数据）→ 仍不得让学生选，直接用平台给出的那一节
//   not-started 老师还没开始上课 → 展示平台 message，不建主窗口
//   canvas      当前是画布课堂 → 展示平台 message，不建主窗口
//
// 前置：launch 脚本已启动应用与本地 mock（默认 CDP 9229 / mock 19090）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const cdp = process.env.LINGDONG_E2E_CDP || "http://127.0.0.1:9229";
const mock = process.env.LINGDONG_E2E_MOCK || "http://127.0.0.1:19090";
const sessionPath =
  process.env.LINGDONG_E2E_SESSION || ".tmp/windows-platform-e2e/session.json";
const scenario = process.argv[2] || "single";
assert.ok(
  ["single", "two-active", "not-started", "canvas"].includes(scenario),
  `未知场景: ${scenario}`,
);
for (const url of [cdp, mock]) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
    "E2E 只允许本地测试端点",
  );
}

const setup = await fetch(`${mock}/__test/classrooms`, {
  method: "POST",
  body: JSON.stringify({
    mode: scenario === "not-started" ? "none" : scenario === "canvas" ? "canvas" : "active",
    count: scenario === "two-active" ? 2 : 1,
  }),
});
assert.equal(setup.status, 200, "设置课堂形态失败");

const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context.pages().find((page) => page.url().startsWith("data:text/html"));
  assert.ok(gate, "需要全新的隔离登录实例");
  const mainPageOf = () =>
    context.pages().find((candidate) => candidate.url().startsWith("file:"));

  // 登录窗本身不得内置任何"选课堂"入口；登录成功后该窗口会被关闭，所以这里先断言。
  const gateHtml = await gate.content();
  assert.ok(!gateHtml.includes("点击进入"), "登录窗不得出现选课堂 UI");
  assert.ok(!gateHtml.includes("请选择要进入的课堂"), "登录窗不得出现选课堂提示");

  await gate.locator("#login").fill("mock");
  await gate.locator("#password").fill("mock");
  await gate.locator("#submit").click();

  if (scenario === "not-started" || scenario === "canvas") {
    const expected =
      scenario === "not-started"
        ? "老师还没有开始上课"
        : "当前是画布课堂，请在学生端进入画布课堂";
    await gate.locator("#status").filter({ hasText: expected }).waitFor({ timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(mainPageOf() ?? null, null, `${scenario} 不得创建主窗口`);
    const failureHtml = await gate.content();
    assert.ok(!failureHtml.includes("点击进入"), "失败态也不得出现选课堂 UI");
    console.log(
      JSON.stringify({ pass: true, scenario, messageShown: expected, workspaceBlocked: true }),
    );
  } else {
    let page;
    for (let attempt = 0; attempt < 60; attempt++) {
      page = mainPageOf();
      if (page) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(page, `${scenario} 应直接创建主窗口`);
    assert.equal(await page.title(), "灵动ai创作客户端");
    // 脏数据场景要求平台确实下发了两节，否则这条断言没有意义。
    const platformState = await (await fetch(`${mock}/__test/state`)).json();
    assert.equal(
      platformState.activeClassroomCount,
      scenario === "two-active" ? 2 : 1,
      "平台下发的进行中课堂数量与场景不符",
    );

    const url = decodeURIComponent(page.url());
    assert.ok(url.includes("classroom"), `主窗口应指向课堂工作区：${url.slice(0, 300)}`);
    if (scenario === "two-active") {
      assert.ok(
        !url.includes("classroom-b"),
        "脏数据下也必须用平台给出的那一节，不得由客户端改选",
      );
    }

    assert.equal(platformState.activeClassroomId, "classroom-e2e");

    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    const directory = join(session.profile, ".zcode", "v2", "runtime", "lingdong-quota");
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const hashOf = (identity) => createHash("sha256").update(identity).digest("hex");
    assert.ok(
      files.includes(`${hashOf("e2e-student:classroom-e2e")}.json`),
      `应创建进入课堂的额度桶，实际：${files.join(",")}`,
    );
    assert.ok(
      !files.includes(`${hashOf("e2e-student:classroom-e2e-b")}.json`),
      "未进入的课堂不得创建额度桶",
    );

    console.log(
      JSON.stringify({
        pass: true,
        scenario,
        directEntry: true,
        noSelectionUi: true,
        activeClassroomId: platformState.activeClassroomId,
        quotaBucketIsolated: true,
      }),
    );
  }
} finally {
  await browser.close();
}
