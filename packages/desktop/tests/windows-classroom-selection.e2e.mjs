// 课堂选择 E2E：覆盖「单课堂直接进入」主路径与「多课堂必须由学生选」兜底路径。
//
// 用法：node packages/desktop/tests/windows-classroom-selection.e2e.mjs [single|multiple]
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
// 平台口径：一个学生全局最多属于一个未终态课堂（加人时 IN_OTHER_SESSION 拒绝），
// 但线上存在绕过校验的历史数据，因此 >1 时必须让学生选，不能取「最近一场」。
const scenario = process.argv[2] || "multiple";
assert.ok(["single", "multiple"].includes(scenario), `未知场景: ${scenario}`);

for (const url of [cdp, mock]) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
    "E2E 只允许本地测试端点",
  );
}

const configured = await fetch(`${mock}/__test/classrooms`, {
  method: "POST",
  body: JSON.stringify({ mode: scenario === "multiple" ? "multiple" : "single" }),
});
assert.equal(configured.status, 200, "设置课堂模式失败");
const configuredBody = await configured.json();
assert.equal(configuredBody.multiClassroomMode, scenario === "multiple");

const browser = await chromium.connectOverCDP(cdp);
try {
  const context = browser.contexts()[0];
  const gate = context.pages().find((page) => page.url().startsWith("data:text/html"));
  assert.ok(gate, "需要全新的隔离登录实例");

  await gate.locator("#login").fill("mock");
  await gate.locator("#password").fill("mock");
  await gate.locator("#submit").click();

  const mainPageOf = () =>
    context.pages().find((candidate) => candidate.url().startsWith("file:"));

  if (scenario === "single") {
    // 主路径：只有一个可进课堂时直接进入，不得弹出选择。
    let page;
    for (let attempt = 0; attempt < 60; attempt++) {
      page = mainPageOf();
      if (page) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(page, "单课堂必须直接创建主窗口");
    const url = decodeURIComponent(page.url());
    assert.ok(url.includes("classroom"), `主窗口应指向该课堂工作区：${url.slice(0, 300)}`);
    assert.equal(await page.title(), "灵动ai创作客户端");
    const state = await (await fetch(`${mock}/__test/state`)).json();
    assert.equal(state.activeClassroomId, "classroom-e2e");
    console.log(
      JSON.stringify({ pass: true, scenario, directEntry: true, workspace: "classroom" }),
    );
  } else {
    // 兜底路径：多于一节时必须让学生选，选择前不得创建主窗口。
    const choiceA = gate.getByRole("button", { name: "联调测试课堂（点击进入）" });
    const choiceB = gate.getByRole("button", { name: "联调测试课堂 B（点击进入）" });
    await choiceA.waitFor({ timeout: 20_000 });
    await choiceB.waitFor({ timeout: 20_000 });
    assert.equal(mainPageOf() ?? null, null, "未选择课堂前不得创建主窗口");

    await choiceB.click();
    let page;
    for (let attempt = 0; attempt < 60; attempt++) {
      page = mainPageOf();
      if (page) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(page, "选择课堂后主窗口必须创建");

    const url = decodeURIComponent(page.url());
    assert.ok(url.includes("classroom-b"), `主窗口工作区应指向所选课堂：${url.slice(0, 300)}`);
    assert.equal(await page.title(), "灵动ai创作客户端");

    const state = await (await fetch(`${mock}/__test/state`)).json();
    assert.equal(state.activeClassroomId, "classroom-e2e-b", "平台侧应记录到所选课堂");

    // 额度桶按 workspace identity 隔离：只创建所选课堂的桶。
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    const directory = join(session.profile, ".zcode", "v2", "runtime", "lingdong-quota");
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const hashOf = (identity) => createHash("sha256").update(identity).digest("hex");
    const selected = `${hashOf("e2e-student:classroom-e2e-b")}.json`;
    const notEntered = `${hashOf("e2e-student:classroom-e2e")}.json`;
    assert.ok(files.includes(selected), `应创建所选课堂额度桶，实际：${files.join(",")}`);
    assert.ok(!files.includes(notEntered), "未进入的课堂不得创建额度桶");

    console.log(
      JSON.stringify({
        pass: true,
        scenario,
        choiceShownBeforeWorkspace: true,
        selectedClassroom: state.activeClassroomId,
        workspaceIsolated: true,
        quotaBucketIsolated: true,
      }),
    );
  }
} finally {
  await browser.close();
}
