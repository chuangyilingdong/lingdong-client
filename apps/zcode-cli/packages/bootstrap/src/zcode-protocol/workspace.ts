import { posix, win32 } from "node:path";
import { parseRemoteWorkspaceIdentity, type ZCodeWorkspaceRef } from "@zcode/shared";

export function buildWorkspaceRef(input: {
  workspaceIdentity?: string;
  workspacePath: string;
}): ZCodeWorkspaceRef {
  const workspaceIdentity = input.workspaceIdentity?.trim() || undefined;
  return {
    workspaceIdentity,
    workspaceKey: workspaceIdentity ?? input.workspacePath,
    workspacePath: input.workspacePath,
  };
}

/**
 * 将 V4 workspaceId 的本地路径/远程 identity 双形态统一还原为 workspace ref。
 */
export function resolveWorkspaceRefFromId(
  workspaceId: string,
  options: { workspacePath?: string } = {},
): ZCodeWorkspaceRef {
  const explicitWorkspacePath = options.workspacePath?.trim() || undefined;
  const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
  if (parsedRemote) {
    return buildWorkspaceRef({
      workspaceIdentity: workspaceId,
      workspacePath: explicitWorkspacePath ?? parsedRemote.workspacePath,
    });
  }

  // 非法 remote identity 若继续按本地路径处理，会再次把 identity 写入
  // directory/path。remote 命名空间必须 fail-closed。
  if (workspaceId.startsWith("remote:")) {
    throw new Error(`Invalid remote workspace identity: ${workspaceId}`);
  }

  if (explicitWorkspacePath) {
    return buildWorkspaceRef({
      ...(workspaceId === explicitWorkspacePath ? {} : { workspaceIdentity: workspaceId }),
      workspacePath: explicitWorkspacePath,
    });
  }

  // 普通本地 workspaceId 就是绝对路径。课堂本地 identity 含冒号，不能用
  // workingDirectory 兜底；在创建 record 前明确失败，避免子进程启动报伪 ENOENT。
  if (win32.isAbsolute(workspaceId) || posix.isAbsolute(workspaceId)) {
    return buildWorkspaceRef({ workspacePath: workspaceId });
  }

  throw new Error(`workspacePath is required for non-path workspaceId: ${workspaceId}`);
}
