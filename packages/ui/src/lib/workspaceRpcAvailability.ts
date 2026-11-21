import { isRemoteWorkspaceIdentity } from "@zcode/shared";

interface WorkspaceRpcAvailabilityTarget {
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

function isRemoteWorkspaceRpcTarget(target: WorkspaceRpcAvailabilityTarget): boolean {
  const workspaceIdentity = target.workspaceIdentity?.trim();
  return Boolean(
    target.remoteSessionId?.trim() ||
      target.remoteTarget ||
      (workspaceIdentity && isRemoteWorkspaceIdentity(workspaceIdentity)),
  );
}

export function shouldEnableWorkspaceRpc(target: WorkspaceRpcAvailabilityTarget): boolean {
  return !isRemoteWorkspaceRpcTarget(target) || Boolean(target.remoteSessionId?.trim());
}
