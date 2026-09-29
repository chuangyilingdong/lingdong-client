import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  LINGDONG_PREVIEW_APP_NAME,
  LINGDONG_PRODUCTION_APP_NAME,
  resolveDesktopApplicationName,
  resolveProductUserDataDir,
} from "../src/main/desktopProductDataPaths.js";

test("打包态使用灵动ai产品身份，Preview 与开发态独立", () => {
  assert.equal(
    resolveDesktopApplicationName({
      env: {},
      isPackaged: true,
      flavor: "production",
    }),
    LINGDONG_PRODUCTION_APP_NAME,
  );
  assert.equal(
    resolveDesktopApplicationName({
      env: {},
      isPackaged: true,
      flavor: "preview",
    }),
    LINGDONG_PREVIEW_APP_NAME,
  );
  assert.equal(
    resolveDesktopApplicationName({
      env: {},
      isPackaged: false,
      flavor: "production",
    }),
    "ZCode Dev",
  );
});

test("Windows 业务数据落灵动ai目录，不落官方 ZCode 目录", () => {
  const appData = "C:\\Users\\student\\AppData\\Roaming";
  assert.equal(
    resolveProductUserDataDir({
      env: { APPDATA: appData },
      platform: "win32",
      home: "C:\\Users\\student",
    }),
    join(appData, LINGDONG_PRODUCTION_APP_NAME),
  );
  assert.notEqual(
    resolveProductUserDataDir({
      env: { APPDATA: appData },
      platform: "win32",
      home: "C:\\Users\\student",
    }),
    join(appData, "ZCode"),
  );
});

test("显式用户数据目录覆盖产品默认路径", () => {
  assert.equal(
    resolveProductUserDataDir({
      env: { APPDATA: "C:\\Roaming", ZCODE_DESKTOP_USER_DATA_DIR: "D:\\ClassData" },
      platform: "win32",
      home: "C:\\Users\\student",
    }),
    "D:\\ClassData",
  );
});
