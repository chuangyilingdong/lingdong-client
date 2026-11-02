import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getElectronReleasePlatform,
  parseLingdongDownloadManifest,
  resolveLingdongManifestTarget,
} from "../src/main/manifestUpdateProvider.js";

const manifestUrl = new URL("https://aicyld.com/downloads/manifest.json");
const manifest = JSON.stringify({
  version: "0.2.12",
  publishedAt: "2026-11-02T00:00:00.000Z",
  note: "三平台发布",
  files: {
    "win-x64": {
      name: "lingdong-client-0.2.12-win-x64.exe",
      sha256: "a".repeat(64),
    },
    "mac-arm64": {
      name: "lingdong-client-0.2.12-mac-arm64.dmg",
      sha256: "b".repeat(64),
    },
    "mac-x64": {
      name: "lingdong-client-0.2.12-mac-x64.dmg",
      sha256: "c".repeat(64),
    },
  },
});

function selectedPath(releasePlatform: string): string | undefined {
  return parseLingdongDownloadManifest(manifest, manifestUrl, releasePlatform)?.path;
}

test("更新器按运行平台和 CPU 架构生成 release platform", () => {
  assert.equal(getElectronReleasePlatform("win32", "x64"), "windows-x86_64");
  assert.equal(getElectronReleasePlatform("darwin", "arm64"), "darwin-aarch64");
  assert.equal(getElectronReleasePlatform("darwin", "x64"), "darwin-x86_64");
});

test("更新目标精确映射三个平台", () => {
  assert.equal(resolveLingdongManifestTarget("windows-x86_64"), "win-x64");
  assert.equal(resolveLingdongManifestTarget("darwin-aarch64"), "mac-arm64");
  assert.equal(resolveLingdongManifestTarget("darwin-x86_64"), "mac-x64");
  assert.equal(resolveLingdongManifestTarget("linux-x86_64"), null);
});

test("Intel Mac 只选择 mac-x64", () => {
  assert.equal(selectedPath("darwin-x86_64"), "lingdong-client-0.2.12-mac-x64.dmg");
});

test("Apple Silicon 只选择 mac-arm64", () => {
  assert.equal(selectedPath("darwin-aarch64"), "lingdong-client-0.2.12-mac-arm64.dmg");
});

test("Windows 继续只选择 win-x64", () => {
  assert.equal(selectedPath("windows-x86_64"), "lingdong-client-0.2.12-win-x64.exe");
});

test("两种 Mac 缺少自身目标时不会交叉下载", () => {
  const onlyArm64 = JSON.stringify({
    version: "0.2.12",
    files: {
      "mac-arm64": manifestJsonFile("mac-arm64"),
    },
  });
  const onlyX64 = JSON.stringify({
    version: "0.2.12",
    files: {
      "mac-x64": manifestJsonFile("mac-x64"),
    },
  });

  assert.equal(parseLingdongDownloadManifest(onlyArm64, manifestUrl, "darwin-x86_64"), null);
  assert.equal(parseLingdongDownloadManifest(onlyX64, manifestUrl, "darwin-aarch64"), null);
});

function manifestJsonFile(target: "mac-arm64" | "mac-x64") {
  return {
    name: `lingdong-client-0.2.12-${target}.dmg`,
    sha256: "d".repeat(64),
  };
}
