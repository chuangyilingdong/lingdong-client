// 已安装（NSIS 安装后）实例冒烟：启动 → 打开登录门 → 关闭。
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const exe = process.env.LINGDONG_INSTALLED_EXE || resolve(".tmp/install-test/灵动ai创作客户端.exe");
const root = resolve(".tmp/windows-installed-e2e");
await mkdir(root, { recursive: true });
const profile = await mkdtemp(join(root, "profile-"));
await mkdir(join(profile, "electron"), { recursive: true });
const env = {
  ...process.env,
  HOME: profile,
  ZCODE_DESKTOP_HOME_DIR: profile,
  ZCODE_DATA_BASE_DIR: profile,
  ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "electron"),
  LINGDONG_API_BASE: "http://127.0.0.1:19090",
};
delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
delete env.ELECTRON_RUN_AS_NODE;
const logFd = openSync(join(root, "app.log"), "a");
const app = spawn(exe, ["--remote-debugging-port=9229"], {
  cwd: process.cwd(),
  env,
  windowsHide: true,
  stdio: ["ignore", logFd, logFd],
});
app.on("error", (e) => console.error("SPAWN_ERROR", e));

let browser = null;
for (let attempt = 0; attempt < 80 && !browser; attempt++) {
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9229");
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!browser) throw new Error("已安装实例未开调试端口");
let gate = null;
for (let attempt = 0; attempt < 60 && !gate; attempt++) {
  gate = browser
    .contexts()[0]
    ?.pages()
    .find((p) => /login\.html/.test(p.url()) || p.url().startsWith("data:text/html"));
  if (!gate) await new Promise((r) => setTimeout(r, 500));
}
if (!gate) throw new Error("已安装实例未出现登录门");
const html = await gate.content();
if (!html.includes('id="login"') || !html.includes("密码")) throw new Error("登录门内容异常");
console.log(
  JSON.stringify({ pass: true, installedAppLaunches: true, loginGateShown: true, profile }),
);
await browser.close().catch(() => {});
await writeFile(join(root, "session.json"), JSON.stringify({ appPid: app.pid, profile }, null, 2));
