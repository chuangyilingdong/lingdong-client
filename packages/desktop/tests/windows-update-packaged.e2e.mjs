// 打包态更新联动：生产路径（无 dev 开关），清单 → 下载 → sha256 校验。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { openSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const APP_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
/** 末位数字 +1，例如 0.2.0-zcode.2 → 0.2.0-zcode.3 */
const NEXT_VERSION = APP_VERSION.replace(/(\d+)(?!.*\d)/, (n) => String(Number(n) + 1));
const mock = "http://127.0.0.1:19090";
const root = resolve(".tmp/windows-packaged-e2e");
await mkdir(root, { recursive: true });

const artifactName = `lingdong-client-${NEXT_VERSION}-win-x64.exe`;
const bytes = randomBytes(2 * 1024 * 1024);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const manifest = {
  version: NEXT_VERSION,
  enabled: true,
  mandatory: false,
  minVersion: "",
  publishedAt: new Date().toISOString(),
  note: "打包态更新验证",
  files: {
    "win-x64": { version: NEXT_VERSION, name: artifactName, size: bytes.byteLength, sha256 },
  },
};
const configured = await fetch(`${mock}/__test/update`, {
  method: "POST",
  body: JSON.stringify({ manifest, bytes: bytes.toString("base64") }),
});
assert.equal(configured.status, 200, "mock 更新注入失败");

const profile = await mkdtemp(join(root, "update-"));
await mkdir(join(profile, ".zcode", "v2"), { recursive: true });
await mkdir(join(profile, "electron"), { recursive: true });
await writeFile(
  join(profile, ".zcode", "v2", "setting.json"),
  JSON.stringify({ autoDownloadAndInstallUpdates: true }, null, 2),
);

const env = {
  ...process.env,
  HOME: profile,
  ZCODE_DESKTOP_HOME_DIR: profile,
  ZCODE_DATA_BASE_DIR: profile,
  ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "electron"),
  LINGDONG_API_BASE: mock,
};
delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
delete env.ELECTRON_RUN_AS_NODE;
delete env.ZCODE_AUTO_UPDATE_DEV;
delete env.ZCODE_AUTO_UPDATE_DEV_VERSION;

const logPath = join(profile, "app.log");
const logFd = openSync(logPath, "a");
const exe = resolve(".tmp/verify-win/win-unpacked/灵动ai创作客户端.exe");
const child = spawn(exe, ["--remote-debugging-port=9229"], {
  cwd: process.cwd(),
  env,
  windowsHide: true,
  stdio: ["ignore", logFd, logFd],
});
child.on("error", (error) => console.error("SPAWN_ERROR", error));

const { chromium } = await import("playwright-core");
let browser;
for (let attempt = 0; attempt < 60 && !browser; attempt++) {
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
assert.ok(browser, "无法连接打包态调试端口");
try {
  const context = browser.contexts()[0];
  let gate;
  for (let i = 0; i < 60; i++) {
    gate = context.pages().find((p) => p.url().startsWith("data:text/html"));
    if (gate) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(gate, "登录窗未出现（打包态可能被强更门拦截）");
  await gate.locator("#login").fill("mock");
  await gate.locator("#password").fill("mock");
  await gate.locator("#submit").click();
} finally {
  await browser.close().catch(() => {});
}

const deadline = Date.now() + 150_000;
let log = "";
while (Date.now() < deadline) {
  log = await readFile(logPath, "utf8").catch(() => "");
  if (log.includes(`[auto-update] downloaded: ${NEXT_VERSION}`)) break;
  await new Promise((r) => setTimeout(r, 750));
}
spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });

assert.ok(log.includes(`[auto-update] downloaded: ${NEXT_VERSION}`), `打包态未完成更新下载；日志尾部：\n${log.slice(-1500)}`);
assert.ok(log.includes(`[auto-update] initializing, current version: ${APP_VERSION}`));
assert.ok(log.includes(`[auto-update] new version available: ${NEXT_VERSION}`));
const state = await (await fetch(`${mock}/__test/state`)).json();
assert.ok(state.updateDownloads.length >= 1, "mock 未收到安装包下载请求");
console.log(
  JSON.stringify({
    pass: true,
    packaged: true,
    forceUpdateGateNotBlocking: true,
    downloadedAndVerified: true,
  }),
);
