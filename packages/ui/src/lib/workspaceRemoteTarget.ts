import { isRemoteWorkspaceIdentity } from "@zcode/shared";

export interface WorkspaceRemoteTargetLike {
  workspacePath?: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

/** workspaceIdentity 也用于本地隔离；远端身份必须由共享 canonical parser 判定。 */
export function isRemoteWorkspaceTarget(
  target: WorkspaceRemoteTargetLike,
  resolvedRemoteSessionId?: string | null,
): boolean {
  const workspaceIdentity = target.workspaceIdentity?.trim();
  return Boolean(
    target.remoteSessionId?.trim() ||
      target.remoteTarget ||
      resolvedRemoteSessionId?.trim() ||
      (workspaceIdentity && isRemoteWorkspaceIdentity(workspaceIdentity)),
  );
}
