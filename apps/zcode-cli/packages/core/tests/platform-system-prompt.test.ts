import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextBuilder } from "../src/context/builder.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";

const envInfo = {
  cwd: "/workspace",
  platform: "linux",
  shell: "bash",
  osVersion: "test",
  nodeVersion: "24.0.0",
};

test("平台全局提示词作为独立 system section 追加", () => {
  const result = new ContextBuilder({
    workingDirectory: "/workspace",
    envInfo,
    platformSystemPrompt: "必须使用简体中文，并遵守课堂规则。",
  }).build();
  const section = result.sections.find((item) => item.source === "platform_system_prompt");
  assert.ok(section);
  assert.match(section.content, /<platform_system_instructions>/);
  assert.match(section.content, /必须使用简体中文/);
  assert.ok(
    result.systemMessages.some((message) => JSON.stringify(message).includes("必须使用简体中文")),
  );
});

test("平台提示词不会替换自定义 Agent 身份且子代理同样生效", () => {
  const main = new ContextBuilder({
    workingDirectory: "/workspace",
    envInfo,
    customSystemPrompt: "自定义 Agent 身份",
    platformSystemPrompt: "平台约束",
  }).build();
  assert.ok(main.sections.some((item) => item.source === "custom_system_prompt"));
  assert.ok(main.sections.some((item) => item.source === "platform_system_prompt"));

  const child = createSubagentContextBuilder({
    agentPrompt: "子代理身份",
    envInfo,
    platformSystemPrompt: "平台约束",
  }).build();
  assert.ok(child.sections.some((item) => item.source === "platform_system_prompt"));
});
