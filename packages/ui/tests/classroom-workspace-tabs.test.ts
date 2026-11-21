import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterClassroomPurposeSections,
  filterWorkspaceTabsForClassroom,
} from "../src/WorkspaceSidebar/classroomWorkspaceTabs.js";

const tabs = [
  {
    workspacePath: "/classroom/current",
    workspaceIdentity: "student:class-a",
    workspacePurpose: "conversation" as const,
  },
  {
    workspacePath: "/classroom/current",
    workspaceIdentity: "student:class-b",
    workspacePurpose: "project" as const,
  },
  {
    workspacePath: "/repo/other",
    workspaceIdentity: "student:class-a",
    workspacePurpose: "project" as const,
  },
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
    [{ ...tabs[0], workspacePurpose: "project" }],
  );
});

test("课堂模式缺少 identity 时按当前路径过滤", () => {
  assert.deepEqual(
    filterWorkspaceTabsForClassroom({
      tabs,
      classroomMode: true,
      workspacePath: "/repo/other",
    }),
    [{ ...tabs[2], workspacePurpose: "project" }],
  );
});

test("课堂模式隐藏默认会话任务区，只保留项目区", () => {
  assert.deepEqual(filterClassroomPurposeSections(["conversations", "projects"], true), [
    "projects",
  ]);
  assert.deepEqual(filterClassroomPurposeSections(["conversations", "projects"], false), [
    "conversations",
    "projects",
  ]);
});
