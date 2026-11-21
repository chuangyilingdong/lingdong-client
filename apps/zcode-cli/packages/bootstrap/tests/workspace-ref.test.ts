import assert from "node:assert/strict";
import { test } from "node:test";
import { commandPayloadSchemas } from "@zcode/shared/zcode-protocol-v4";
import { resolveWorkspaceRefFromId } from "../src/zcode-protocol/workspace.js";

const localIdentity = "user_123:csession_456";
const localPath = "C:\\Users\\student\\Documents\\灵动ai创作\\课堂-csession_456";

test("createSession schema 保留 workspacePath", () => {
  assert.deepEqual(
    commandPayloadSchemas.createSession.parse({
      workspaceId: localIdentity,
      workspacePath: localPath,
    }),
    {
      workspaceId: localIdentity,
      workspacePath: localPath,
    },
  );
});

test("本地课堂 identity 保持 workspaceKey，并使用显式真实路径", () => {
  assert.deepEqual(
    resolveWorkspaceRefFromId(localIdentity, {
      workspacePath: localPath,
    }),
    {
      workspaceIdentity: localIdentity,
      workspaceKey: localIdentity,
      workspacePath: localPath,
    },
  );
});

test("普通本地绝对路径不需要额外 identity", () => {
  assert.deepEqual(resolveWorkspaceRefFromId(localPath), {
    workspaceIdentity: undefined,
    workspaceKey: localPath,
    workspacePath: localPath,
  });
});

test("本地 identity 缺少真实路径时 fail-closed", () => {
  assert.throws(
    () => resolveWorkspaceRefFromId(localIdentity),
    /workspacePath is required for non-path workspaceId/u,
  );
});

test("远程 identity 仍还原远端路径，显式路径优先", () => {
  const identity = "remote:ssh:example.com:22:student:/home/student/class";
  assert.deepEqual(resolveWorkspaceRefFromId(identity), {
    workspaceIdentity: identity,
    workspaceKey: identity,
    workspacePath: "/home/student/class",
  });
  assert.deepEqual(
    resolveWorkspaceRefFromId(identity, {
      workspacePath: "/srv/classroom",
    }),
    {
      workspaceIdentity: identity,
      workspaceKey: identity,
      workspacePath: "/srv/classroom",
    },
  );
});
