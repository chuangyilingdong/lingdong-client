import { normalizeLingdongEntryPaths } from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "@/v4/transport.js";

const MAX_TASK_ROW_PAGES = 50;

/** 只有 turn 与课堂时间窗相交的 fileChanges 才属于本节课产出。 */
function turnTouchesSince(row: { startedAt: number; endedAt?: number }, sinceMs?: number): boolean {
  if (sinceMs === undefined) return true;
  const startedAtMs = row.startedAt;
  const endedAtMs = row.endedAt ?? Number.NaN;
  return (
    (Number.isFinite(startedAtMs) && startedAtMs >= sinceMs) ||
    (Number.isFinite(endedAtMs) && endedAtMs >= sinceMs)
  );
}

/**
 * 读取任务当前分支里可提交的入口文件。
 *
 * V4 任务的 ZCodeTaskSnapshot.fileChanges 为空；作品入口必须从 conversation 的
 * turnHeader + fileChanges 读取，否则会把“已写文件”的任务误判成没有可提交作品。
 * sinceMs 用于课后自动补交：只保留课堂开始后发生变化（或结束时间跨过课堂开始）的轮次。
 */
export async function readLingdongTaskEntryPaths(
  transport: ConversationTransport,
  taskId: string,
  workspacePath: string,
  options: { sinceMs?: number } = {},
): Promise<string[]> {
  const rows = new Map<
    number,
    Awaited<ReturnType<ConversationTransport["rowsRange"]>>["rows"][number]
  >();
  let beforeRowId: number | undefined;
  let authority: { revision: number; logEpoch: string } | null = null;
  for (let page = 0; page < MAX_TASK_ROW_PAGES; page += 1) {
    const result = await transport.rowsRange({
      sessionId: taskId,
      limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
      ...(beforeRowId !== undefined ? { beforeRowId } : {}),
    });
    if (
      authority &&
      (authority.revision !== result.atRevision || authority.logEpoch !== result.atLogEpoch)
    ) {
      throw new Error("当前任务仍在更新，请稍后重新打开作品提交。");
    }
    authority ??= { revision: result.atRevision, logEpoch: result.atLogEpoch };
    for (const row of result.rows) rows.set(row.rowId, row);
    if (!result.hasMore || result.rows.length === 0) break;
    const nextBeforeRowId = result.rows[0]?.rowId;
    if (nextBeforeRowId === undefined || nextBeforeRowId === beforeRowId) break;
    beforeRowId = nextBeforeRowId;
  }

  if (!authority) throw new Error("无法读取当前任务的对话投影。");
  const filePaths: string[] = [];
  for (const row of rows.values()) {
    if (row.kind !== "turnHeader" || row.fileChanges?.state === "reverted") continue;
    if (!row.fileChanges || row.fileChanges.files <= 0) continue;
    if (!row.entityId || !turnTouchesSince(row, options.sinceMs)) continue;
    const result = await transport.fileChanges({
      sessionId: taskId,
      target: { rowId: row.rowId, entityId: row.entityId },
      baseRevision: authority.revision,
      baseLogEpoch: authority.logEpoch,
    });
    if (result.state === "reverted") continue;
    for (const item of result.items) filePaths.push(item.path);
  }
  return normalizeLingdongEntryPaths(filePaths, workspacePath);
}
