import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLingdongSubmissionRecordKey,
  normalizeLingdongEntryPaths,
  selectLingdongEntryCandidate,
} from "@zcode/shared";

const workspacePath = "C:\\课堂\\任务工作区";

test("buildLingdongSubmissionRecordKey scopes task records and preserves legacy keys", () => {
  const taskKey = buildLingdongSubmissionRecordKey(" task-1 ", "index.html");
  assert.notEqual(taskKey, "index.html");
  assert.equal(taskKey, buildLingdongSubmissionRecordKey("task-1", "index.html"));
  assert.notEqual(taskKey, buildLingdongSubmissionRecordKey("task-2", "index.html"));
  assert.equal(buildLingdongSubmissionRecordKey("", "index.html"), "index.html");
  assert.equal(buildLingdongSubmissionRecordKey(undefined, "index.html"), "index.html");
});

test("normalizeLingdongEntryPaths keeps V4 submit entries and rejects outside paths", () => {
  assert.deepEqual(
    normalizeLingdongEntryPaths(
      [
        "C:\\课堂\\任务工作区\\index.html",
        "C:\\课堂\\任务工作区\\assets\\preview.png",
        "C:\\课堂\\任务工作区\\slides.PPTX",
        "D:\\其它工作区\\outside.html",
      ],
      workspacePath,
    ),
    ["index.html", "slides.PPTX"],
  );
});

test("normalizeLingdongEntryPaths can preserve external entries for Main allowlist checks", () => {
  assert.deepEqual(
    normalizeLingdongEntryPaths(
      [
        "C:\\课堂\\任务工作区\\index.html",
        "C:\\Users\\student\\AppData\\Roaming\\灵动ai创作客户端\\zcode\\workspace\\default\\index.html",
        "D:\\其它工作区\\outside.html",
      ],
      workspacePath,
      { allowExternalAbsolutePaths: true },
    ),
    [
      "index.html",
      "C:\\Users\\student\\AppData\\Roaming\\灵动ai创作客户端\\zcode\\workspace\\default\\index.html",
      "D:\\其它工作区\\outside.html",
    ],
  );
});

const entries = [
  { relativePath: "old.html", updatedAt: 900 },
  { relativePath: "current.html", updatedAt: 2_100 },
  { relativePath: "current-old.html", updatedAt: 1_500 },
];

test("selectLingdongEntryCandidate prefers task fileChanges over the time fallback", () => {
  assert.deepEqual(
    selectLingdongEntryCandidate(entries, {
      taskId: "task-1",
      taskFilePaths: new Set(["old.html"]),
      taskStartedAtMs: 1_000,
    }),
    { entry: entries[0], source: "taskChanges" },
  );
});

test("selectLingdongEntryCandidate falls back to entries modified during the task", () => {
  assert.deepEqual(
    selectLingdongEntryCandidate(entries, {
      taskId: "task-1",
      taskFilePaths: new Set(),
      taskStartedAtMs: 1_000,
    }),
    { entry: entries[1], source: "taskStartedAt" },
  );
});

test("selectLingdongEntryCandidate accepts filesystem mtime skew and rejects an invalid task start", () => {
  const nearStart = [{ relativePath: "index.html", updatedAt: 998 }];
  assert.deepEqual(
    selectLingdongEntryCandidate(nearStart, {
      taskId: "task-1",
      taskFilePaths: new Set(),
      taskStartedAtMs: 1_000,
    }),
    { entry: nearStart[0], source: "taskStartedAt" },
  );
  assert.equal(
    selectLingdongEntryCandidate(entries, {
      taskId: "task-1",
      taskFilePaths: new Set(),
      taskStartedAtMs: Number.NaN,
    }),
    null,
  );
});
