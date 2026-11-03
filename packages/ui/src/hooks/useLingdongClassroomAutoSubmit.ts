import { useEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ClassroomAutoSubmitStopReason } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { readLingdongTaskEntryPaths } from "@/lib/lingdongTaskEntries.js";
import { runLingdongClassroomAutoSubmit } from "@/lib/lingdongClassroomAutoSubmit.js";

function sameWorkspace(
  request: { workspacePath: string; workspaceIdentity: string },
  workspacePath: string | undefined,
  workspaceIdentity: string | undefined,
): boolean {
  if (!workspacePath || request.workspacePath !== workspacePath) return false;
  const requestIdentity = request.workspaceIdentity.trim();
  const localIdentity = workspaceIdentity?.trim() || "";
  return !requestIdentity || !localIdentity || requestIdentity === localIdentity;
}

/**
 * Renderer 侧课堂结束自动补交协调器。
 *
 * Main 只发课堂结束请求；选择 task、读取 fileChanges、复用现有扫描与提交都由当前 workspace
 * 的 Renderer 完成，避免 Main 复制 task/session 业务状态。
 */
export function useLingdongClassroomAutoSubmit(input: {
  services: IServiceAccessor;
  workspacePath: string | undefined;
  workspaceIdentity?: string;
}): void {
  const classroom = usePlatform().classroom;
  const { services, workspaceIdentity, workspacePath } = input;

  useEffect(() => {
    if (!classroom?.onClassroomEnded) return;
    return classroom.onClassroomEnded((request) => {
      void (async () => {
        if (!sameWorkspace(request, workspacePath, workspaceIdentity)) {
          await classroom
            .claimClassroomEndedAutoSubmit(request.requestId, false)
            .catch(() => false);
          return;
        }
        const claimed = await classroom
          .claimClassroomEndedAutoSubmit(request.requestId, true)
          .catch(() => false);
        if (!claimed) return;

        let completion: {
          requestId: string;
          submitted: number;
          skipped: number;
          failed: number;
          stoppedReason?: ClassroomAutoSubmitStopReason;
          message?: string;
        };
        try {
          if (!workspacePath) throw new Error("课堂自动补交缺少工作区路径。");
          const transport = createAgentConversationTransport(services.zcodeAgentService, {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          });
          completion = {
            requestId: request.requestId,
            ...(await runLingdongClassroomAutoSubmit({
              workspacePath,
              sessionId: request.sessionId,
              startedAtMs: request.startedAtMs,
              deadlineAtMs: request.deadlineAtMs,
              now: Date.now,
              listTasks: () =>
                services.zcodeTaskService.listTasks({
                  workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                }),
              readTaskEntryPaths: (taskId, options) =>
                readLingdongTaskEntryPaths(transport, taskId, workspacePath, options),
              scanWorkspaceFiles: (options) => classroom.scanWorkspaceFiles(options),
              submitWork: (payload) => classroom.submitWork(payload),
            })),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("[classroom] 课后自动补交失败", { error });
          completion = {
            requestId: request.requestId,
            submitted: 0,
            skipped: 0,
            failed: 1,
            message,
          };
        }
        await classroom.completeClassroomEndedAutoSubmit(completion).catch((error) => {
          logger.warn("[classroom] 回报课后自动补交结果失败", { error });
        });
      })();
    });
  }, [classroom, services, workspaceIdentity, workspacePath]);
}
