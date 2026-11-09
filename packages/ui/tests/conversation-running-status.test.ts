import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { resolveTurnChatLoadingPhase } from "../src/v4/chatLoadingVisibility.js";

function row(value: Record<string, unknown>): ConversationRow {
  return value as unknown as ConversationRow;
}

function reasoning(text: string): ConversationRow {
  return row({ kind: "reasoning", state: "streaming", text });
}

function assistantText(text: string): ConversationRow {
  return row({ kind: "assistantText", state: "streaming", text });
}

test("首个非空输出前保持思考阶段", () => {
  assert.equal(resolveTurnChatLoadingPhase([]), "thinking");
  assert.equal(resolveTurnChatLoadingPhase([reasoning("")]), "thinking");
  assert.equal(resolveTurnChatLoadingPhase([assistantText("   ")]), "thinking");
  assert.equal(resolveTurnChatLoadingPhase([row({ kind: "timelineMarker" })]), "thinking");
});

test("首个非空 reasoning 或正文出现后切换为工作阶段", () => {
  assert.equal(resolveTurnChatLoadingPhase([reasoning("分析需求")]), "working");
  assert.equal(resolveTurnChatLoadingPhase([assistantText("开始实现")]), "working");
});

test("工具或子智能体输出出现后切换为工作阶段", () => {
  assert.equal(
    resolveTurnChatLoadingPhase([row({ kind: "toolCall", status: "inputStreaming" })]),
    "working",
  );
  assert.equal(
    resolveTurnChatLoadingPhase([row({ kind: "subagent", status: "running" })]),
    "working",
  );
});

test("一旦进入工作阶段，后续空行不会退回思考阶段", () => {
  assert.equal(
    resolveTurnChatLoadingPhase([reasoning("已完成分析"), reasoning(""), assistantText("")]),
    "working",
  );
});
