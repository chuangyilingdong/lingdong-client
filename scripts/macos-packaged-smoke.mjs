// macOS 打包态烟测：必须在 macOS runner 上运行。
// 目标不是跑完整业务，而是证明产物能启动、签名结构有效、主进程/渲染进程/平台登录链路可用。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const repoRoot = resolve(import.meta.dirname, "..");
const appPath = resolve(process.argv[2] || process.env.ZCODE_MACOS_APP_PATH || "");
assert(process.platform === "darwin", "macOS 打包态烟测只允许在 macOS 运行");
assert(appPath && appPath.endsWith(".app"), `缺少 .app 路径：${appPath || "<empty>"}`);

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stdout || ""}\n${result.stderr || ""}`,
  );
  return `${result.stdout || ""}${result.stderr || ""}`;
}

const plistPath = join(appPath, "Contents", "Info.plist");
const executableName = runChecked("plutil", ["-extract", "CFBundleExecutable", "raw", plistPath]).trim();
assert.ok(executableName, "Info.plist 缺少 CFBundleExecutable");
const executablePath = join(appPath, "Contents", "MacOS", executableName);
runChecked("codesign", ["--verify", "--deep", "--strict", appPath]);
const fileOutput = runChecked("file", [executablePath]);
assert.match(fileOutput, /Mach-O 64-bit executable arm64/u, `主程序不是 arm64 Mach-O：${fileOutput}`);

async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 进程启动期间连接会被拒绝，继续等。
    }
    await sleep(300);
  }
  throw new Error(`等待服务超时：${url}`);
}

async function waitForPage(context, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = context.pages().find(predicate);
    if (page) return page;
    await sleep(300);
  }
  throw new Error("等待 Electron 页面超时");
}

const profile = await mkdtemp(join(tmpdir(), "lingdong-macos-smoke-"));
let mock;
let app;
let browser;
try {
  mock = spawn(process.execPath, [join(repoRoot, "packages/desktop/tests/mock-platform.mjs")], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHttp("http://127.0.0.1:19090/__test/state");

  app = spawn(executablePath, ["--remote-debugging-port=9229"], {
    env: {
      ...process.env,
      HOME: profile,
      ZCODE_DESKTOP_HOME_DIR: profile,
      ZCODE_DATA_BASE_DIR: profile,
      ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "electron"),
      LINGDONG_API_BASE: "http://127.0.0.1:19090",
      ZCODE_E2E_RUN_ID: `mac-smoke-${process.pid}`,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHttp("http://127.0.0.1:9229/json/version");

  browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
  const context = browser.contexts()[0];
  const gate = await waitForPage(
    context,
    (page) =>
      page.url().startsWith("data:text/html") ||
      page.url().includes("/gate/login.html") ||
      page.url().includes("/resources/gate/login.html"),
  );
  await gate.locator("#login").fill("mock");
  await gate.locator("#password").fill("mock");
  const created = context.waitForEvent("page", { timeout: 90_000 });
  await gate.locator("#submit").click();
  const main = await created;
  await main.waitForURL((url) => url.protocol === "file:" || url.hostname === "localhost", {
    timeout: 90_000,
  });
  await main.waitForLoadState("domcontentloaded", { timeout: 90_000 });
  assert.equal(await main.title(), "灵动ai创作客户端");

  console.log(
    JSON.stringify({
      pass: true,
      platform: process.platform,
      app: basename(appPath),
      executable: executableName,
      signed: "ad-hoc or release",
      launched: true,
      mainWindow: true,
    }),
  );
} finally {
  await browser?.close().catch(() => {});
  if (app?.pid) {
    try {
      process.kill(-app.pid, "SIGTERM");
    } catch {
      app.kill("SIGTERM");
    }
    await sleep(1_000);
    try {
      process.kill(-app.pid, "SIGKILL");
    } catch {
      // 已退出。
    }
  }
  mock?.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
