import assert from "node:assert/strict";
import { test } from "node:test";
import { filterWorkspaceTabsForClassroom } from "../src/WorkspaceSidebar/classroomWorkspaceTabs.js";

const tabs = [
  { workspacePath: "/classroom/current", workspaceIdentity: "student:class-a" },
  { workspacePath: "/classroom/current", workspaceIdentity: "student:class-b" },
  { workspacePath: "/repo/other", workspaceIdentity: "student:class-a" },
];

test("普通 ZCode 模式保留全部工作区", () => {
  assert.deepEqual(
    filterWorkspaceTabsForClassroom({
      tabs,
      classroomMode: false,
      workspacePath: "/classroom/current",
      workspaceIdentity: "student:class-a",
    }),
    tabs,
  );
});

test("课堂模式只保留当前课堂工作区身份", () => {
  assert.deepEqual(
    filterWorkspaceTabsForClassroom({
      tabs,
      classroomMode: true,
      workspacePath: "/classroom/current",
      workspaceIdentity: "student:class-a",
    }),
    [tabs[0]],
  );
});

test("课堂模式缺少 identity 时按当前路径过滤", () => {
  assert.deepEqual(
    filterWorkspaceTabsForClassroom({
      tabs,
      classroomMode: true,
      workspacePath: "/repo/other",
    }),
    [tabs[2]],
  );
});
