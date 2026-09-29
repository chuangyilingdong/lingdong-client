// 更新联动 E2E：真实清单 → 下载 → sha256 校验，正/负两个场景。
// 前提：已启动 packages/desktop/tests/mock-platform.mjs（默认 19090）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Electron 主进程固定用自己的调试端口（--remote-debugging-port 传入值不生效）。
const APP_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
/** 末位数字 +1，例如 0.2.0-zcode.2 → 0.2.0-zcode.3 */
const NEXT_VERSION = APP_VERSION.replace(/(\d+)(?!.*\d)/, (n) => String(Number(n) + 1));
const cdpPort = Number(process.env.LINGDONG_E2E_CDP_PORT || 9229);
const mockPort = 19090;
const mock = `http://127.0.0.1:${mockPort}`;
const root = resolve(".tmp/windows-update-e2e");
await mkdir(root, { recursive: true });

const artifactName = `lingdong-client-${NEXT_VERSION}-win-x64.exe`;
const bytes = randomBytes(2 * 1024 * 1024);
const sha256 = createHash("sha256").update(bytes).digest("hex");

const session = {
  appPid: null,
  profile: null,
  logPath: null,
};

async function launchApp({ profileName, digest, withAuth = true, omitPlatformEntry = false }) {
  const profile = await mkdtemp(join(root, profileName + "-"));
  await mkdir(join(profile, ".zcode", "v2"), { recursive: true });
  await mkdir(join(profile, "electron"), { recursive: true });
  if (withAuth) {
    await writeFile(
      join(profile, ".zcode", "v2", "setting.json"),
      JSON.stringify({ autoDownloadAndInstallUpdates: true }, null, 2),
    );
  }
  const manifest = {
    version: NEXT_VERSION,
    enabled: true,
    mandatory: false,
    minVersion: "",
    publishedAt: new Date().toISOString(),
    note: "更新联动 E2E",
    files: omitPlatformEntry
      ? {}
      : {
          "win-x64": { version: NEXT_VERSION, name: artifactName, size: bytes.byteLength, sha256: digest },
        },
  };
  const configured = await fetch(`${mock}/__test/update`, {
    method: "POST",
    body: JSON.stringify({ manifest, bytes: bytes.toString("base64") }),
  });
  assert.equal(configured.status, 200, "mock 更新注入失败");

  const logPath = join(profile, "app.log");
  // 用 openSync 并保持打开：FileHandle.close() 会提前失效被继承的句柄，导致子进程立即退出。
  const logFd = openSync(logPath, "a");
  const env = {
    ...process.env,
    HOME: profile,
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "electron"),
    LINGDONG_API_BASE: mock,
    ZCODE_AUTO_UPDATE_DEV: "1",
    ZCODE_AUTO_UPDATE_DEV_VERSION: APP_VERSION,
  };
  delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolve(".tmp/electron-local-41/electron.exe"),
    [resolve("packages/desktop"), `--remote-debugging-port=${cdpPort}`],
    { cwd: process.cwd(), env, windowsHide: true, stdio: ["ignore", logFd, logFd] });
  child.on("error", (error) => console.error("APP_SPAWN_ERROR", error));
  session.appPid = child.pid;
  session.profile = profile;
  session.logPath = logPath;
  return { child, profile, logPath };
}

async function waitForLog(logPath, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await readFile(logPath, "utf8").catch(() => "");
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.fail(`${label} 超时；日志尾部：\n${last.slice(-1200)}`);
}

function stopApp() {
  if (session.appPid) {
    spawnSync("taskkill", ["/PID", String(session.appPid), "/T", "/F"], { stdio: "ignore" });
    session.appPid = null;
  }
}

async function loginThroughGate() {
  const { chromium } = await import("playwright-core");
  // 应用刚 spawn，调试端口需要时间；连接必须重试而不是一次性失败。
  let browser;
  for (let attempt = 0; attempt < 60 && !browser; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(browser, "无法连接 Electron 调试端口");
  try {
    const context = browser.contexts()[0];
    let gate;
    for (let i = 0; i < 40; i++) {
      gate = context.pages().find((p) => p.url().startsWith("data:text/html"));
      if (gate) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(gate, "登录窗未出现");
    await gate.locator("#login").fill("mock");
    await gate.locator("#password").fill("mock");
    await gate.locator("#submit").click();
    for (let i = 0; i < 60; i++) {
      if (context.pages().some((p) => p.url().startsWith("file:"))) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.fail("主窗口未创建");
  } finally {
    await browser.close().catch(() => {});
  }
}

try {
  // 正例：清单 sha256 与安装包一致 → 必须下载完成。
  const good = await launchApp({ profileName: "positive", digest: sha256 });
  await loginThroughGate();
  const goodLog = await waitForLog(
    good.logPath,
    (text) => text.includes(`[auto-update] downloaded: ${NEXT_VERSION}`),
    120_000,
    "正向更新下载",
  );
  assert.ok(goodLog.includes(`[auto-update] initializing, current version: ${APP_VERSION}`));
  assert.ok(goodLog.includes(`[auto-update] new version available: ${NEXT_VERSION}`));
  assert.ok(/download progress: [\d.]+%/.test(goodLog), "缺少下载进度日志");
  const goodState = await (await fetch(`${mock}/__test/state`)).json();
  assert.ok(goodState.updateDownloads.length >= 1, "mock 未收到安装包下载请求");
  stopApp();

  // 反例：清单 sha256 与安装包不一致 → 必须失败且不得进入已下载状态。
  const wrongDigest = sha256.replace(/^./, sha256[0] === "0" ? "1" : "0");
  const bad = await launchApp({ profileName: "negative", digest: wrongDigest });
  await loginThroughGate();
  const badLog = await waitForLog(
    bad.logPath,
    (text) => text.includes(`[auto-update] downloaded: ${NEXT_VERSION}`) || /\[auto-update\] error:/.test(text),
    120_000,
    "反向更新校验",
  );
  assert.ok(
    /\[auto-update\] error:/.test(badLog),
    "sha256 不匹配时必须报错",
  );
  assert.ok(
    !badLog.includes(`[auto-update] downloaded: ${NEXT_VERSION}`),
    "sha256 不匹配时不得进入已下载状态",
  );
  stopApp();

  // 第三场景：清单里没有本平台条目（例如单平台发布时移除了另一平台）→
  // 客户端必须判定"本平台暂无更新"，不得落到 YAML 回退分支后抛错。
  const missing = await launchApp({
    profileName: "no-entry",
    digest: sha256,
    omitPlatformEntry: true,
  });
  await loginThroughGate();
  const missingLog = await waitForLog(
    missing.logPath,
    (text) => text.includes("[auto-update] already up to date") || /\[auto-update\] error:/.test(text),
    120_000,
    "缺少本平台条目",
  );
  assert.ok(
    missingLog.includes("[auto-update] already up to date"),
    "缺少本平台条目时应判定为暂无更新",
  );
  assert.ok(
    !/\[auto-update\] error:/.test(missingLog),
    "缺少本平台条目不得记成更新失败",
  );
  stopApp();

  console.log(
    JSON.stringify({
      pass: true,
      manifestApplied: true,
      downloadedAndVerified: true,
      tamperedArtifactRejected: true,
      missingPlatformEntryTreatedAsNoUpdate: true,
    }),
  );
} finally {
  stopApp();
}
