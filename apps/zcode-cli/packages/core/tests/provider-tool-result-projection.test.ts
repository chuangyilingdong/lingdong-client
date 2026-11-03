import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
  createRuntimeUserEntry,
} from "../src/agent/message-history.js";
import { moveLegacySystemRemindersAfterToolResultRun } from "../src/runtime/helpers/provider-mid-conversation-system.js";

test("provider projection keeps a tool result run contiguous", () => {
  const entries = [
    createRuntimeAssistantEntry("", [
      { id: "tool-a", name: "Read", input: {} },
      { id: "tool-b", name: "Read", input: {} },
    ]),
    createRuntimeToolResultEntry("tool-a", "Read", "first", false),
    createRuntimeUserEntry("legacy reminder", { source: "legacy_synthetic" }),
    createRuntimeToolResultEntry("tool-b", "Read", "second", false),
  ];

  const projected = moveLegacySystemRemindersAfterToolResultRun(entries as never);
  assert.deepEqual(
    projected.map((entry) =>
      entry.kind === "attachment"
        ? "attachment"
        : entry.message.role === "tool"
          ? `tool:${entry.message.toolCallId}`
          : `${entry.message.role}:${String(entry.message.content)}`,
    ),
    ["assistant:", "tool:tool-a", "tool:tool-b", "user:legacy reminder"],
  );
});