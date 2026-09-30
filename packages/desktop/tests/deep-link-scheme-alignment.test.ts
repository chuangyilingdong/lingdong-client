import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isOAuthCallbackUrl,
  isPaymentCallbackUrl,
  isShareImportUrl,
  isWorkspaceOpenUrl,
  extractDeepLinkUrlFromArgs,
  extractWorkspaceOpenPath,
} from "../src/main/desktopDeepLinkUrl.js";

const desktopRoot = resolve(import.meta.dirname, "..");

function quotedStrings(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
}

async function readSchemeList(file: string, pattern: RegExp): Promise<string[]> {
  const source = await readFile(resolve(desktopRoot, file), "utf8");
  const match = source.match(pattern);
  assert.ok(match, `未能从 ${file} 中解析出 scheme 列表`);
  return quotedStrings(match[1]!);
}

test("安装期与运行时注册的 scheme 列表必须一致", async () => {
  const installerSchemes = await readSchemeList(
    "electron-builder.config.js",
    /\bschemes:\s*\[([^\]]*)\]/u,
  );
  const runtimeSchemes = await readSchemeList(
    "src/main/desktopOAuthDeepLink.ts",
    /DEEP_LINK_SCHEMES\s*=\s*\[([^\]]*)\]\s*as const/u,
  );

  // 平台网页「进入 VibeCoding 课堂」按钮发的是 lingdong://open（DSH 时代定的 scheme）。
  // 只注册 zcode 会让按钮点了没反应；只注册 lingdong 会让 OAuth/支付/工作区深链失效。
  assert.deepEqual(
    [...installerSchemes].sort(),
    [...runtimeSchemes].sort(),
    "electron-builder.config.js 的 protocols[].schemes 与 DEEP_LINK_SCHEMES 不一致",
  );
  assert.deepEqual([...installerSchemes].sort(), ["lingdong", "zcode"]);
});

test("lingdong://open 是入口链接，不得触发任何已有深链动作", () => {
  const entryLink = new URL("lingdong://open");

  // 平台按钮只要求「拉起客户端 / 把窗口带到前台」；它不该顺带打开工作区、走 OAuth、支付或分享。
  assert.equal(isWorkspaceOpenUrl(entryLink), false);
  assert.equal(isOAuthCallbackUrl(entryLink), false);
  assert.equal(isPaymentCallbackUrl(entryLink), false);
  assert.equal(isShareImportUrl(entryLink), false);
});

test("zcode 深链语义不变（工作区打开仍可解析）", () => {
  const url = "zcode://workspace/open?path=%2Ftmp%2Fclassroom";
  const extracted = extractDeepLinkUrlFromArgs([url]);
  assert.equal(extracted, url);
  assert.equal(extractWorkspaceOpenPath(new URL(url)), "/tmp/classroom");

  assert.equal(isWorkspaceOpenUrl(new URL("lingdong://open")), false);
});
