import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOpenWorkspaceStartupBootstrap,
  resolveStartupWindowBootstrap,
} from "../src/main/startupWorkspace.js";

test("显式课堂 workspace 同时保留 identity 与 project purpose", () => {
  assert.deepEqual(
    createOpenWorkspaceStartupBootstrap(
      "C:\\Users\\student\\Documents\\灵动ai创作\\课堂",
      "student-1:csession_1",
    ),
    {
      initialWorkspacePath: "C:\\Users\\student\\Documents\\灵动ai创作\\课堂",
      initialWorkspaceIdentity: "student-1:csession_1",
      initialWorkspacePurpose: "project",
      agentWarmupTargets: [
        {
          workspacePath: "C:\\Users\\student\\Documents\\灵动ai创作\\课堂",
          workspaceIdentity: "student-1:csession_1",
        },
      ],
    },
  );
});

test("课堂环境变量强制启动课堂项目，不回退默认会话工作区", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-startup-workspace-"));
  const previousPath = process.env.ZCODE_LINGDONG_WORKSPACE_PATH;
  const previousIdentity = process.env.ZCODE_LINGDONG_WORKSPACE_IDENTITY;
  try {
    process.env.ZCODE_LINGDONG_WORKSPACE_PATH = join(root, "classroom");
    process.env.ZCODE_LINGDONG_WORKSPACE_IDENTITY = "student-1:csession_1";

    const result = await resolveStartupWindowBootstrap({
      settingsFile: join(root, "missing-settings.json"),
      conversationWorkspaceDir: join(root, "conversation-default"),
    });

    assert.deepEqual(result, {
      initialWorkspacePath: join(root, "classroom"),
      initialWorkspaceIdentity: "student-1:csession_1",
      initialWorkspacePurpose: "project",
      agentWarmupTargets: [
        {
          workspacePath: join(root, "classroom"),
          workspaceIdentity: "student-1:csession_1",
        },
      ],
    });
  } finally {
    if (previousPath === undefined) delete process.env.ZCODE_LINGDONG_WORKSPACE_PATH;
    else process.env.ZCODE_LINGDONG_WORKSPACE_PATH = previousPath;
    if (previousIdentity === undefined) delete process.env.ZCODE_LINGDONG_WORKSPACE_IDENTITY;
    else process.env.ZCODE_LINGDONG_WORKSPACE_IDENTITY = previousIdentity;
    await rm(root, { recursive: true, force: true });
  }
});
