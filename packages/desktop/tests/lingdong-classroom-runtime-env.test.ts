import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LINGDONG_CLASSROOM_MODEL_STREAM_IDLE_TIMEOUT_MS,
  MODEL_STREAM_IDLE_TIMEOUT_ENV,
  resolveLingdongClassroomRuntimeEnv,
} from "../src/main/lingdongClassroomRuntimeEnv.js";

test("课堂环境注入 20 分钟模型流 idle timeout", () => {
  assert.deepEqual(resolveLingdongClassroomRuntimeEnv({ classroom: { id: "classroom-1" } }), {
    [MODEL_STREAM_IDLE_TIMEOUT_ENV]: String(LINGDONG_CLASSROOM_MODEL_STREAM_IDLE_TIMEOUT_MS),
  });
  assert.equal(LINGDONG_CLASSROOM_MODEL_STREAM_IDLE_TIMEOUT_MS, 1_200_000);
});

test("备课和未开课不注入课堂 timeout", () => {
  assert.deepEqual(
    resolveLingdongClassroomRuntimeEnv({ classroom: { id: "classroom-1" }, prep: true }),
    {},
  );
  assert.deepEqual(resolveLingdongClassroomRuntimeEnv({ classroom: null }), {});
  assert.deepEqual(resolveLingdongClassroomRuntimeEnv({ classroom: undefined }), {});
});
