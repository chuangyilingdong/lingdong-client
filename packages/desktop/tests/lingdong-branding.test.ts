import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { desktopMenuMessages } from "../../shared/src/desktopMenu.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const literalPattern = /("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(`(?:\\.|[^`\\])*`)/g;

function source(file: string): string {
  return readFileSync(resolve(repoRoot, file), "utf8");
}

function stringLiterals(file: string): string[] {
  return [...source(file).matchAll(literalPattern)].map((match) => match[0]);
}

const userVisibleFiles = [
  "packages/ui/src/i18n/locales/zh-CN.ts",
  "packages/ui/src/i18n/locales/en-US.ts",
  "apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts",
  "apps/zcode-cli/packages/i18n/src/locales/en-US.ts",
  "packages/ui/src/lib/builtinSkillI18n.ts",
  "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
  "packages/desktop/src/main/about.ts",
  "packages/desktop/src/renderer/cuaPermissionPanelMessages.ts",
  "packages/ui/src/feedback/feedbackSubmitDescription.ts",
  "packages/ui/src/feedback/feedbackSubmitSubmission.ts",
  "packages/shared/src/feedback.ts",
  "packages/shared/src/plugin-display-name.ts",
  "packages/shared/src/zcode-agent-policy.ts",
  "packages/ui/src/WorkspaceSidebarFooter.tsx",
  "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
  "apps/zcode-cli/packages/tui/src/app-sidebar.tsx",
  "apps/zcode-cli/packages/debug/src/App.tsx",
  "apps/zcode-cli/packages/node-repl-host/src/runtime-bridge.ts",
  "apps/zcode-cli/packages/core/src/subagent/explore.ts",
  "apps/zcode-cli/packages/core/src/workflow/scheduler/prompts.ts",
  "apps/zcode-cli/packages/core/src/workflow/expert/prompts.ts",
  "apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts",
];

test("用户可见文案不再包含 ZCode 品牌", () => {
  for (const file of userVisibleFiles) {
    const hits = stringLiterals(file).filter((literal) => literal.includes("ZCode"));
    assert.deepEqual(hits, [], `${file} 仍有用户可见 ZCode 文案`);
  }
});

test("桌面菜单文案不再包含 ZCode 品牌", () => {
  for (const [locale, messages] of Object.entries(desktopMenuMessages)) {
    for (const [id, value] of Object.entries(messages)) {
      assert.equal(value.includes("ZCode"), false, `${locale} ${id} 仍有 ZCode 文案`);
    }
  }
});

test("对话空态所有时段统一为小灵陪您一起 VibeCoding", () => {
  const zh = source("packages/ui/src/i18n/locales/zh-CN.ts");
  for (const key of [
    "office",
    "morningEarly",
    "morning",
    "noon",
    "afternoon",
    "evening",
    "lateNight",
  ]) {
    assert.match(
      zh,
      new RegExp(`"chat\\.empty\\.greeting\\.${key}": "小灵陪您一起VibeCoding"`),
      `${key} 问候文案不正确`,
    );
  }
  assert.equal(zh.includes("晚上好呀"), false);
  assert.equal(zh.includes("早上好呀"), false);
});

test("Agent 身份提示词明确是小灵且禁止自称 ZCode", () => {
  const prompt = source("apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts");
  assert.match(prompt, /Xiaoling \(小灵\)/);
  assert.match(prompt, /Never identify yourself as ZCode/);
  assert.equal(/You are ZCode/.test(prompt), false);
});
