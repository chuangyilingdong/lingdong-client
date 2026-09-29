// 平台契约 E2E：覆盖平台侧本次回复里"会直接影响客户端"的三条事实。
//
// 用法：node packages/desktop/tests/windows-platform-contract.e2e.mjs <scenario>
//   no-workspace-path  平台不下发 workspacePath（生产事实）→ 客户端用本机回退目录
//   session-superseded 账号在别处登录 → 401 SESSION_SUPERSEDED → 展示平台 message
//   submit-includes-works 提交响应直接带 works（未发版的新形状）→ 客户端用响应里的 works
//
// 前置：launch 脚本已启动应用与本地 mock（默认 CDP 9229 / mock 19090）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const cdp = process.env.LINGDONG_E2E_CDP || "http://127.0.0.1:9229";
const mock = process.env.LINGDONG_E2E_MOCK || "http://127.0.0.1:19090";
const scenario = process.argv[2] || "no-workspace-path";
assert.ok(
  ["no-workspace-path", "session-superseded", "submit-includes-works"].includes(scenario),
  `未知场景: ${scenario}`,
);
for (const url of [cdp, mock]) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
    "E2E 只允许本地测试端点",
  );
}

const platformSetup = await fetch(`${mock}/__test/platform`, {
  method: "POST",
  body: JSON.stringify({
    omitWorkspacePath: scenario === "no-workspace-path",
    sessionSuperseded: scenario === "session-superseded",
    submitIncludesWorks: scenario === "submit-includes-works",
  }),
});
assert.equal(platformSetup.status, 200, "设置平台行为失败");

// 平台不下发 workspacePath 时客户端会落到本机 Documents 下的课堂目录；
// 先记录它是否已存在——已存在说明可能是真实学生作业，本次一律不删。
const fallbackWorkspaceDir = join(
  process.env.USERPROFILE || "",
  "Documents",
  "灵动ai创作",
  "联调学生-联调测试课堂",
);
const fallbackPreexisting = await stat(fallbackWorkspaceDir).catch(() => null);

let cleanupPath = null;
const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context.pages().find((page) => page.url().startsWith("data:text/html"));
  assert.ok(gate, "需要全新的隔离登录实例");
  const mainPageOf = () =>
    context.pages().find((candidate) => candidate.url().startsWith("file:"));

  await gate.locator("#login").fill("mock");
  await gate.locator("#password").fill("mock");
  await gate.locator("#submit").click();

  if (scenario === "session-superseded") {
    const expected = "当前账号已在其他设备登录";
    await gate.locator("#status").filter({ hasText: expected }).waitFor({ timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(mainPageOf() ?? null, null, "被顶号时不得进入工作区");
    console.log(JSON.stringify({ pass: true, scenario, sessionSuperseded: true, message: expected }));
  } else {
    let page;
    for (let attempt = 0; attempt < 60; attempt++) {
      page = mainPageOf();
      if (page) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(page, `${scenario} 应直接创建主窗口`);
    // 首次启动会先弹引导页，与其它 E2E 一样先退出引导再断言平台数据。
    const exitOnboarding = page.getByRole("button", { name: "退出引导", exact: true });
    const modelButton = page.getByRole("button", {
      name: /灵动ai 平台网关\/mock-model/,
    });
    await modelButton.or(exitOnboarding).first().waitFor({ timeout: 30_000 });
    if (await exitOnboarding.isVisible()) await exitOnboarding.click();
    // 包络 {success,ok,data} 必须被客户端正确解包：课堂/模型能正常显示。
    await modelButton.waitFor({ timeout: 30_000 });

    if (scenario === "no-workspace-path") {
      const url = decodeURIComponent(page.url());
      // 运行前先记录：目录已存在就绝不删除（真实学生作业可能就在这里）。
      assert.ok(
        url.includes("灵动ai创作"),
        `平台没给 workspacePath 时应落到本机回退目录：${url.slice(0, 300)}`,
      );
      // 回退目录用学生+课时命名，这里核对确实创建出来了，随后清理本次测试产生的目录。
      const info = await stat(fallbackWorkspaceDir).catch(() => null);
      assert.ok(info?.isDirectory(), `回退工作区未创建：${fallbackWorkspaceDir}`);
      // 只有本次运行前不存在、由本场景新建的目录才清理。
      cleanupPath = fallbackPreexisting ? null : fallbackWorkspaceDir;
      console.log(
        JSON.stringify({
          pass: true,
          scenario,
          fallbackWorkspace: true,
          createdPath: fallbackWorkspaceDir,
          cleanedAfterRun: !fallbackPreexisting,
        }),
      );
    } else {
      const dialog = page.getByRole("dialog");
      await page.getByRole("button", { name: "提交课堂作品", exact: true }).click();
      await dialog.getByRole("button", { name: /确认并提交 1 个文件/ }).click();
      // mock 在 submitIncludesWorks 下故意让 GET /student/works 返回 0 条；
      // 若客户端显示 1 条，说明它用的是提交响应里的 works。
      await dialog.getByText("平台当前返回 1 条作品记录", { exact: false }).waitFor({
        timeout: 20_000,
      });
      console.log(
        JSON.stringify({ pass: true, scenario, usedSubmitResponseWorks: true, count: 1 }),
      );
    }
  }
} finally {
  await browser.close().catch(() => {});
  if (cleanupPath) {
    // 目录被 agent cwd 占用，必须先结束本次测试实例再删。
    try {
      const session = JSON.parse(
        await readFile(resolve(".tmp/windows-platform-e2e/session.json"), "utf8"),
      );
      spawnSync("taskkill", ["/PID", String(session.appPid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // session 文件缺失时直接尝试删除
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    // 关掉实例后目录锁会释放，重试几次即可删净本次测试产生的回退工作区。
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(cleanupPath, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const leftover = await stat(cleanupPath).catch(() => null);
    if (leftover) console.error("cleanup left behind:", cleanupPath);
  }
}
