import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("tool results enter model history as one batch before async persistence", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../src/runtime/methods/turn-tools.ts", import.meta.url)),
    "utf8",
  );
  const batchStart = source.indexOf("const batchToolResultEntries = results.map");
  const batchCommit = source.indexOf(
    "commitTurnRequestEntries(this, state.turnRequestState, batchToolResultEntries)",
  );
  const firstAsyncPersistence = source.indexOf("await recordToolUsageFromResult");

  assert.ok(batchStart >= 0, "batch history entries must be prepared");
  assert.ok(batchCommit > batchStart, "batch history entries must be committed");
  assert.ok(
    firstAsyncPersistence > batchCommit,
    "batch history commit must happen before async tool-result persistence",
  );
  assert.doesNotMatch(
    source,
    /commitTurnRequestEntries\(this, state\.turnRequestState, \[\s*createRuntimeToolResultEntry/,
    "per-result commits would reintroduce missing sibling results on persistence failure",
  );
});