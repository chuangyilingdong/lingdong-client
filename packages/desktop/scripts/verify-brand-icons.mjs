import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const { Icns } = require("@fiahfy/icns");

const desktopRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(desktopRoot, "resources/gate/app-icon-1024.png");
const configPath = resolve(desktopRoot, "electron-builder.config.js");
const expectedSourceSha256 = "c034ea62bde07adb07470cf1419a4276cde868c9d3d35fe1e68e732a7fd5787f";
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const expectedDmgBackgroundSha256 = new Map([
  ["dmg_background.png", "9d245e0803465ca72add7a61ba0bf2420f6697f48bb308b79027255d4bab7515"],
  ["dmg_background@2x.png", "8269ab3958a600b409a6c32a90fa2c447788da98f076506f7b283aa42a6e2a20"],
]);

function fail(message) {
  throw new Error(`[brand-icons] ${message}`);
}

function assertCanonicalSource() {
  if (!existsSync(sourcePath)) {
    fail(`缺少 macOS 品牌图标源: ${sourcePath}`);
  }

  const source = readFileSync(sourcePath);
  if (!source.subarray(0, pngSignature.length).equals(pngSignature)) {
    fail(`品牌图标源不是 PNG: ${sourcePath}`);
  }
  const width = source.readUInt32BE(16);
  const height = source.readUInt32BE(20);
  if (width !== 1024 || height !== 1024) {
    fail(`品牌图标源必须是 1024x1024，实际为 ${width}x${height}: ${sourcePath}`);
  }

  const actualSha256 = createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== expectedSourceSha256) {
    fail(
      `品牌图标源 SHA256 不匹配，防止 ZCode 图标回流。expected=${expectedSourceSha256} actual=${actualSha256}`,
    );
  }

  return source;
}

function assertDmgBackgrounds() {
  for (const [fileName, expectedSha256] of expectedDmgBackgroundSha256) {
    const filePath = resolve(desktopRoot, "build", fileName);
    if (!existsSync(filePath)) {
      fail(`缺少 DMG 背景图: ${filePath}`);
    }
    const actualSha256 = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    if (actualSha256 !== expectedSha256) {
      fail(`DMG 背景图品牌校验失败: ${filePath}`);
    }
  }
}

function assertPackagingConfig() {
  const config = readFileSync(configPath, "utf8");
  if (!config.includes('icon: "resources/gate/app-icon-1024.png"')) {
    fail(`mac.icon 必须显式指向 resources/gate/app-icon-1024.png: ${configPath}`);
  }
  if (config.includes("build/icon_installer.icns")) {
    fail(`打包配置仍引用旧 ZCode .icns: ${configPath}`);
  }
  for (const staleFile of ["icon.icns", "icon_installer.icns"]) {
    const stalePath = resolve(desktopRoot, "build", staleFile);
    if (existsSync(stalePath)) {
      fail(`build 目录不应保留未受控的 macOS 图标产物: ${stalePath}`);
    }
  }
}

function assertPackagedAppIcon(appPath, source) {
  const iconPath = resolve(appPath, "Contents", "Resources", "icon.icns");
  if (!existsSync(iconPath)) {
    fail(`打包应用缺少 icon.icns: ${iconPath}`);
  }

  const icns = Icns.from(readFileSync(iconPath));
  const image = icns.images.find((entry) => entry.osType === "ic10");
  if (!image) {
    fail(`打包应用的 icon.icns 缺少 ic10 1024x1024 表示: ${iconPath}`);
  }
  if (!image.image.equals(source)) {
    fail(`打包应用图标不是当前灵动 ai 品牌源: ${iconPath}`);
  }
}

function readAppArgument(argv) {
  const index = argv.indexOf("--app");
  if (index === -1) {
    return null;
  }
  const appPath = argv[index + 1];
  if (!appPath) {
    fail("--app 后必须提供 .app 路径");
  }
  return resolve(appPath);
}

const source = assertCanonicalSource();
assertPackagingConfig();
assertDmgBackgrounds();
const appPath = readAppArgument(process.argv.slice(2));
if (appPath) {
  assertPackagedAppIcon(appPath, source);
  console.log(`[brand-icons] macOS app icon OK: ${appPath}`);
} else {
  console.log("[brand-icons] source and packaging config OK");
}
