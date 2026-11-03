import assert from "node:assert/strict";
import test from "node:test";
import { readLingdongTaskEntryPaths } from "../src/lib/lingdongTaskEntries.js";
import type { ConversationTransport } from "../src/v4/transport.js";

const workspacePath = "C:\\课堂";

function transportFor(rows: readonly Record<string, unknown>[]) {
  const requested: number[] = [];
  const transport = {
    rowsRange: async () => ({
      rows,
      hasMore: false,
      atRevision: 1,
      atLogEpoch: "epoch-1",
    }),
    fileChanges: async (params: { target: { rowId: number } }) => {
      requested.push(params.target.rowId);
      return {
        state: "active",
        items: [{ path: `${workspacePath}\\turn-${params.target.rowId}.html` }],
      };
    },
  } as unknown as ConversationTransport;
  return { transport, requested };
}

test("自动补交只读取课堂开始后相交轮次的 fileChanges", async () => {
  const { transport, requested } = transportFor([
    {
      rowId: 1,
      kind: "turnHeader",
      entityId: "old",
      startedAt: 500,
      endedAt: 900,
      fileChanges: { files: 1 },
    },
    {
      rowId: 2,
      kind: "turnHeader",
      entityId: "current",
      startedAt: 1_000,
      endedAt: 1_100,
      fileChanges: { files: 1 },
    },
    {
      rowId: 3,
      kind: "turnHeader",
      entityId: "crossing",
      startedAt: 700,
      endedAt: 1_050,
      fileChanges: { files: 1 },
    },
    {
      rowId: 4,
      kind: "turnHeader",
      entityId: "reverted",
      startedAt: 1_200,
      fileChanges: { files: 1, state: "reverted" },
    },
  ]);

  const paths = await readLingdongTaskEntryPaths(transport, "task-1", workspacePath, {
    sinceMs: 1_000,
  });

  assert.deepEqual(requested, [2, 3]);
  assert.deepEqual(paths, ["turn-2.html", "turn-3.html"]);
});

test("课堂内新任务不传 sinceMs 时读取全部有效轮次", async () => {
  const { transport, requested } = transportFor([
    {
      rowId: 1,
      kind: "turnHeader",
      entityId: "first",
      startedAt: 500,
      fileChanges: { files: 1 },
    },
    {
      rowId: 2,
      kind: "turnHeader",
      entityId: "second",
      startedAt: 800,
      fileChanges: { files: 1 },
    },
  ]);

  const paths = await readLingdongTaskEntryPaths(transport, "task-1", workspacePath);

  assert.deepEqual(requested, [1, 2]);
  assert.deepEqual(paths, ["turn-1.html", "turn-2.html"]);
});
