// 启动打包态（app.isPackaged=true）测试实例：隔离数据根 + 本地 mock 平台。
//
// 用法：
//   node packages/desktop/tests/launch-packaged-e2e.mjs [--exe <path>] [--keep-mock]
//
// 默认读取 dist 目录下的 win-unpacked 产物；调用方需保证 mock 已启动或允许本脚本启动。
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const root = resolve(process.env.LINGDONG_E2E_ROOT || ".tmp/windows-packaged-e2e");
const exe = resolve(
  readArg("--exe", ".tmp/verify-win/win-unpacked/灵动ai创作客户端.exe"),
);
const mockPort = Number(process.env.LINGDONG_E2E_MOCK_PORT || 19090);
const cdpPort = Number(process.env.LINGDONG_E2E_CDP_PORT || 9229);

await mkdir(root, { recursive: true });
const profile = await mkdtemp(join(root, "profile-"));
await mkdir(join(profile, "electron"), { recursive: true });
await mkdir(join(profile, ".zcode", "v2"), { recursive: true });

const env = {
  ...process.env,
  HOME: profile,
  ZCODE_DESKTOP_HOME_DIR: profile,
  ZCODE_DATA_BASE_DIR: profile,
  ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "electron"),
  LINGDONG_API_BASE: `http://127.0.0.1:${mockPort}`,
};
delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
delete env.ELECTRON_RUN_AS_NODE;

const mockLog = openSync(join(root, "mock.log"), "a");
const mock = spawn(process.execPath, [resolve("packages/desktop/tests/mock-platform.mjs")], {
  cwd: process.cwd(),
  detached: true,
  windowsHide: true,
  stdio: ["ignore", mockLog, mockLog],
});
mock.unref();

const appLog = openSync(join(root, "app.log"), "a");
// 额外 argv：老师端备课深链这类场景需要让应用是「被深链冷启动」的。
const extraAppArgs = (process.env.LINGDONG_E2E_APP_ARGS || "")
  .split(" ")
  .map((item) => item.trim())
  .filter(Boolean);
const app = spawn(exe, [`--remote-debugging-port=${cdpPort}`, ...extraAppArgs], {
  cwd: process.cwd(),
  env,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", appLog, appLog],
});
app.unref();

const state = {
  mockPid: mock.pid,
  appPid: app.pid,
  profile,
  root,
  exe,
  cdp: `http://127.0.0.1:${cdpPort}`,
  mock: `http://127.0.0.1:${mockPort}`,
};
await writeFile(join(root, "session.json"), JSON.stringify(state, null, 2));
console.log(JSON.stringify(state));
