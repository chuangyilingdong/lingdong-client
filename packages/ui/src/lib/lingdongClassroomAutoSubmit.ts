import type { ClassroomSubmitResult, ClassroomWorkspaceScan } from "@zcode/shared";
import type { ZCodeTaskMeta } from "@zcode/shared";

export type LingdongAutoSubmitTask = Pick<
  ZCodeTaskMeta,
  "taskId" | "title" | "createdAt" | "updatedAt"
>;

export type LingdongAutoSubmitRuntime = {
  readonly workspacePath: string;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly sessionId: string;
  readonly now: () => number;
  readonly listTasks: () => Promise<readonly LingdongAutoSubmitTask[]>;
  readonly readTaskEntryPaths: (
    taskId: string,
    options: { sinceMs?: number },
  ) => Promise<readonly string[]>;
  readonly scanWorkspaceFiles: (options: {
    taskId: string;
    taskFilePaths: readonly string[];
  }) => Promise<ClassroomWorkspaceScan>;
  readonly submitWork: (payload: {
    copyrightConfirmed: false;
    items: [{ path: string }];
    taskId: string;
    taskTitle: string;
    sessionId: string;
    autoSubmit: true;
  }) => Promise<ClassroomSubmitResult>;
};

export type LingdongAutoSubmitResult = {
  readonly submitted: number;
  readonly skipped: number;
  readonly failed: number;
  readonly stoppedReason?: "window-closed" | "wrong-classroom" | "session-required" | "deadline";
  readonly message?: string;
};

const STOP_CODES = new Map<string, NonNullable<LingdongAutoSubmitResult["stoppedReason"]>>([
  ["AUTO_SUBMIT_WINDOW_CLOSED", "window-closed"],
  ["AUTO_SUBMIT_WRONG_CLASSROOM", "wrong-classroom"],
  ["AUTO_SUBMIT_SESSION_REQUIRED", "session-required"],
]);

function isNetworkFailure(result: ClassroomSubmitResult): boolean {
  return result.code === "NETWORK_ERROR";
}

async function submitWithOneRetry(
  runtime: LingdongAutoSubmitRuntime,
  payload: Parameters<LingdongAutoSubmitRuntime["submitWork"]>[0],
): Promise<ClassroomSubmitResult> {
  try {
    const first = await runtime.submitWork(payload);
    if (!isNetworkFailure(first)) return first;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/network|fetch failed|无法连接灵动ai平台/iu.test(error.message)
    ) {
      throw error;
    }
  }
  return runtime.submitWork(payload);
}

/**
 * 课堂结束后按任务补交作品。
 *
 * 任务和 fileChanges 是 Renderer 的权威事实；Main 只接收最终提交请求并负责持久化/平台调用。
 * 任务顺序执行，避免多个大文件同时读取和上传挤占 10 分钟宽限期。
 */
export async function runLingdongClassroomAutoSubmit(
  runtime: LingdongAutoSubmitRuntime,
): Promise<LingdongAutoSubmitResult> {
  const state = {
    submitted: 0,
    skipped: 0,
    failed: 0,
  };
  let stoppedReason: LingdongAutoSubmitResult["stoppedReason"];
  let stopMessage: string | undefined;
  const tasks = [...(await runtime.listTasks())]
    .filter(
      (task) => task.createdAt >= runtime.startedAtMs || task.updatedAt >= runtime.startedAtMs,
    )
    .sort((left, right) => left.createdAt - right.createdAt);

  for (const task of tasks) {
    if (runtime.now() >= runtime.deadlineAtMs) {
      stoppedReason = "deadline";
      break;
    }

    let entryPaths: readonly string[];
    try {
      entryPaths = await runtime.readTaskEntryPaths(
        task.taskId,
        task.createdAt >= runtime.startedAtMs ? {} : { sinceMs: runtime.startedAtMs },
      );
    } catch (error) {
      state.failed += 1;
      stopMessage = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (entryPaths.length === 0) {
      state.skipped += 1;
      continue;
    }

    let scan: ClassroomWorkspaceScan;
    try {
      scan = await runtime.scanWorkspaceFiles({
        taskId: task.taskId,
        taskFilePaths: entryPaths,
      });
    } catch {
      state.failed += 1;
      continue;
    }
    const preview = scan.ok ? scan.preview : undefined;
    if (!preview) {
      state.skipped += 1;
      continue;
    }
    // 本地指纹和平台历史都通过 preview.lastSubmittedAt 投影；存在即说明该任务入口已交过。
    if (preview.lastSubmittedAt) {
      state.skipped += 1;
      continue;
    }

    let result: ClassroomSubmitResult;
    try {
      result = await submitWithOneRetry(runtime, {
        copyrightConfirmed: false,
        items: [{ path: preview.entry.path }],
        taskId: task.taskId,
        taskTitle: task.title.trim(),
        sessionId: runtime.sessionId,
        autoSubmit: true,
      });
    } catch (error) {
      state.failed += 1;
      stopMessage = error instanceof Error ? error.message : String(error);
      continue;
    }

    const stopReason = result.code ? STOP_CODES.get(result.code) : undefined;
    if (stopReason) {
      stoppedReason = stopReason;
      stopMessage = result.message;
      break;
    }
    if (result.autoSubmitSkipped) {
      state.skipped += 1;
      continue;
    }
    if (result.ok === false) {
      state.failed += 1;
      stopMessage = result.message;
      continue;
    }
    state.submitted += 1;
  }

  if (!stoppedReason && runtime.now() >= runtime.deadlineAtMs) {
    stoppedReason = "deadline";
  }
  return {
    ...state,
    ...(stoppedReason ? { stoppedReason } : {}),
    ...(stopMessage ? { message: stopMessage } : {}),
  };
}
