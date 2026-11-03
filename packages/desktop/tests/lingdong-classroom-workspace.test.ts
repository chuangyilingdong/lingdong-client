import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLingdongClassroomWorkspaceName,
  sanitizeLingdongWorkspaceSegment,
} from "../src/main/lingdongClassroomWorkspace.js";

const base = {
  displayName: "刘学生",
  lessonTitle: "1-13 AI 编程入门：对话搭建网站",
};

test("同一学生同一课时的不同课堂必须生成不同工作区名称", () => {
  const first = buildLingdongClassroomWorkspaceName({
    ...base,
    classroomId: "csession_first",
  });
  const second = buildLingdongClassroomWorkspaceName({
    ...base,
    classroomId: "csession_second",
  });

  assert.notEqual(first, second);
  assert.match(first, /csession_first/u);
  assert.match(second, /csession_second/u);
});

test("同一课堂 id 重连时复用同一工作区名称", () => {
  assert.equal(
    buildLingdongClassroomWorkspaceName({ ...base, classroomId: "csession_same" }),
    buildLingdongClassroomWorkspaceName({ ...base, classroomId: "csession_same" }),
  );
});

test("工作区名称会清理 Windows 非法字符并保留可读标题", () => {
  const name = buildLingdongClassroomWorkspaceName({
    displayName: "刘/学生",
    lessonTitle: '课堂: "网页" 创作',
    classroomId: "csession:test",
  });

  assert.equal(name, "刘-学生-课堂- -网页- 创作-csession-test");
  assert.equal(sanitizeLingdongWorkspaceSegment("  ...  ", "fallback"), "fallback");
});
