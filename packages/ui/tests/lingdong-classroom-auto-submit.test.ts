import assert from "node:assert/strict";
import test from "node:test";
import type { ClassroomWorkspaceScan } from "@zcode/shared";
import {
  runLingdongClassroomAutoSubmit,
  type LingdongAutoSubmitRuntime,
} from "../src/lib/lingdongClassroomAutoSubmit.js";

const task = (taskId: string, createdAt: number, updatedAt = createdAt) => ({
  taskId,
  title: `任务 ${taskId}`,
  createdAt,
  updatedAt,
  traceId: taskId,
  workspacePath: "C:\\课堂",
  mode: "agent" as const,
});

function preview(path: string, submittedAt?: string): ClassroomWorkspaceScan {
  return {
    ok: true,
    files: [],
    preview: {
      entry: {
        path: `C:\\课堂\\${path}`,
        relativePath: path,
        size: 10,
        updatedAt: 2_000,
      },
      files: [],
      totalBytes: 10,
      submitted: Boolean(submittedAt),
      hasNewOutput: !submittedAt,
      ...(submittedAt ? { lastSubmittedAt: submittedAt } : {}),
    },
  };
}

function runtime(overrides: Partial<LingdongAutoSubmitRuntime> = {}): {
  runtime: LingdongAutoSubmitRuntime;
  calls: {
    reads: Array<{ taskId: string; sinceMs?: number }>;
    scans: Array<{ taskId: string; taskFilePaths: readonly string[] }>;
    submits: string[];
  };
} {
  const calls = {
    reads: [] as Array<{ taskId: string; sinceMs?: number }>,
    scans: [] as Array<{ taskId: string; taskFilePaths: readonly string[] }>,
    submits: [] as string[],
  };
  const base: LingdongAutoSubmitRuntime = {
    workspacePath: "C:\\课堂",
    sessionId: "classroom-1",
    startedAtMs: 1_000,
    deadlineAtMs: 10_000,
    now: () => 1_500,
    listTasks: async () => [task("new", 1_100), task("old", 100, 1_200), task("before", 100)],
    readTaskEntryPaths: async (taskId, options) => {
      calls.reads.push({ taskId, ...(options.sinceMs ? { sinceMs: options.sinceMs } : {}) });
      if (taskId === "before") return [];
      return [`${taskId}.html`];
    },
    scanWorkspaceFiles: async (options) => {
      calls.scans.push(options);
      return options.taskId === "old"
        ? preview("old.html", "2026-11-03T00:00:00.000Z")
        : preview("new.html");
    },
    submitWork: async (payload) => {
      calls.submits.push(payload.taskId);
      return { ok: true, autoSubmitted: true };
    },
  };
  return { runtime: { ...base, ...overrides }, calls };
}

test("只处理本课任务，旧任务只取课堂开始后的 fileChanges，已提交任务跳过", async () => {
  const { runtime: input, calls } = runtime();

  const result = await runLingdongClassroomAutoSubmit(input);

  assert.deepEqual(result, { submitted: 1, skipped: 1, failed: 0 });
  assert.deepEqual(calls.reads, [{ taskId: "old", sinceMs: 1_000 }, { taskId: "new" }]);
  assert.deepEqual(calls.scans, [
    { taskId: "old", taskFilePaths: ["old.html"] },
    { taskId: "new", taskFilePaths: ["new.html"] },
  ]);
  assert.deepEqual(calls.submits, ["new"]);
});

test("网络失败重试一次后成功", async () => {
  const { runtime: base, calls } = runtime();
  let attempts = 0;
  const input: LingdongAutoSubmitRuntime = {
    ...base,
    listTasks: async () => [task("new", 1_100)],
    submitWork: async (payload) => {
      attempts += 1;
      calls.submits.push(payload.taskId);
      return attempts === 1
        ? { ok: false, code: "NETWORK_ERROR", message: "fetch failed" }
        : { ok: true, autoSubmitted: true };
    },
  };

  const result = await runLingdongClassroomAutoSubmit(input);

  assert.deepEqual(result, { submitted: 1, skipped: 0, failed: 0 });
  assert.equal(attempts, 2);
});

test("窗口关闭错误立即停止后续任务", async () => {
  const { runtime: base, calls } = runtime();
  const input: LingdongAutoSubmitRuntime = {
    ...base,
    listTasks: async () => [task("one", 1_100), task("two", 1_200)],
    scanWorkspaceFiles: async (options) => preview(`${options.taskId}.html`),
    submitWork: async (payload) => {
      calls.submits.push(payload.taskId);
      return { ok: false, code: "AUTO_SUBMIT_WINDOW_CLOSED", status: 403 };
    },
  };

  const result = await runLingdongClassroomAutoSubmit(input);

  assert.deepEqual(result, {
    submitted: 0,
    skipped: 0,
    failed: 0,
    stoppedReason: "window-closed",
  });
  assert.deepEqual(calls.submits, ["one"]);
});

test("达到截止时间后不再读取或提交任务", async () => {
  const { runtime: base, calls } = runtime();
  let listCalled = false;
  const input: LingdongAutoSubmitRuntime = {
    ...base,
    now: () => 10_000,
    listTasks: async () => {
      listCalled = true;
      return [task("late", 1_100)];
    },
  };

  const result = await runLingdongClassroomAutoSubmit(input);

  assert.deepEqual(result, {
    submitted: 0,
    skipped: 0,
    failed: 0,
    stoppedReason: "deadline",
  });
  assert.equal(listCalled, true);
  assert.deepEqual(calls.reads, []);
  assert.deepEqual(calls.submits, []);
});

test("autoSubmitSkipped 只跳过当前任务并继续", async () => {
  const { runtime: base, calls } = runtime();
  const input: LingdongAutoSubmitRuntime = {
    ...base,
    listTasks: async () => [task("one", 1_100), task("two", 1_200)],
    scanWorkspaceFiles: async (options) => preview(`${options.taskId}.html`),
    submitWork: async (payload) => {
      calls.submits.push(payload.taskId);
      return payload.taskId === "one"
        ? { ok: true, autoSubmitSkipped: true }
        : { ok: true, autoSubmitted: true };
    },
  };

  const result = await runLingdongClassroomAutoSubmit(input);

  assert.deepEqual(result, { submitted: 1, skipped: 1, failed: 0 });
  assert.deepEqual(calls.submits, ["one", "two"]);
});
