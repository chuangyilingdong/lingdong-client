import assert from "node:assert/strict";
import test from "node:test";
import { buildLingdongSubmissionRecordKey, normalizeLingdongEntryPaths } from "@zcode/shared";

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
