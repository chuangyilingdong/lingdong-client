import assert from "node:assert/strict";
import { test } from "node:test";
import { isRemoteWorkspaceTarget } from "../src/lib/workspaceRemoteTarget.js";

const remoteIdentity = "remote:ssh:example.internal:22:student:/workspace/classroom";

test("本地课堂 identity 只用于隔离，不触发远端 waiting", () => {
  const target = {
    workspaceIdentity: "user_student:csession_classroom",
  };

  assert.equal(isRemoteWorkspaceTarget(target), false);
});

test("canonical remote identity 在没有 attachment 时保持 remote waiting", () => {
  const target = {
    workspaceIdentity: remoteIdentity,
  };

  assert.equal(isRemoteWorkspaceTarget(target), true);
});

test("本地课堂 identity 有 remoteSessionId 时仍按远端目标解析", () => {
  const target = {
    workspaceIdentity: "user_student:csession_classroom",
    remoteSessionId: "remote-session-1",
  };

  assert.equal(isRemoteWorkspaceTarget(target), true);
});
