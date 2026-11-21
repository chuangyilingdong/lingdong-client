import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreateSessionWorkspacePayload } from "../src/v4/commandFactory.js";

const workspacePath = "C:\\Users\\student\\Documents\\灵动ai创作\\课堂-csession_123";

test("课堂本地 identity 只作为隔离键，workspacePath 作为真实 cwd", () => {
  assert.deepEqual(
    buildCreateSessionWorkspacePayload({
      workspacePath,
      workspaceIdentity: "user_123:csession_123",
    }),
    {
      workspaceId: "user_123:csession_123",
      workspacePath,
    },
  );
});

test("普通本地 workspace 的 workspaceId 使用绝对路径", () => {
  assert.deepEqual(
    buildCreateSessionWorkspacePayload({
      workspacePath: ` ${workspacePath} `,
    }),
    {
      workspaceId: workspacePath,
      workspacePath,
    },
  );
});

test("空 workspacePath 在发出命令前失败", () => {
  assert.throws(
    () => buildCreateSessionWorkspacePayload({ workspacePath: "   " }),
    /workspacePath must not be empty/u,
  );
});
