export const LINGDONG_MAX_TASK_ID_LENGTH = 200;
export const LINGDONG_TASK_ENTRY_MTIME_SKEW_MS = 2_000;

export const LINGDONG_SUBMITTABLE_ENTRY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".htm",
  ".html",
  ".docx",
  ".xlsx",
  ".pptx",
]);

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/u, "");
}

function getPathLeaf(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** 把任务文件快照路径转成 workspace 相对路径；工作区外或包含越界段时返回 null。 */
export function toLingdongWorkspaceRelativePath(
  workspacePath: string,
  filePath: string,
): string | null {
  const normalizedWorkspace = trimTrailingSeparators(workspacePath.replaceAll("\\", "/"));
  const normalizedFile = filePath.trim().replaceAll("\\", "/");
  if (!normalizedWorkspace || !normalizedFile) return null;

  let relativePath: string;
  if (normalizedFile === normalizedWorkspace) {
    relativePath = getPathLeaf(normalizedFile);
  } else {
    const prefix = `${normalizedWorkspace}/`;
    if (normalizedFile.startsWith(prefix)) {
      relativePath = normalizedFile.slice(prefix.length);
    } else if (normalizedFile.toLowerCase().startsWith(prefix.toLowerCase())) {
      relativePath = normalizedFile.slice(prefix.length);
    } else if (/^(?:[a-z]:|\/)/iu.test(normalizedFile)) {
      return null;
    } else {
      relativePath = normalizedFile;
    }
  }

  relativePath = relativePath.replace(/^\.\/+/u, "").replace(/\/+/gu, "/");
  const segments = relativePath.split("/");
  if (
    !relativePath ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return relativePath;
}

/** 把 V4 turn fileChanges 返回的文件路径归一成可提交的工作区相对入口。 */
export function normalizeLingdongEntryPaths(
  filePaths: readonly string[],
  workspacePath: string,
  options: { readonly allowExternalAbsolutePaths?: boolean } = {},
): string[] {
  const paths = new Map<string, string>();
  for (const filePath of filePaths) {
    const trimmedPath = filePath.trim();
    const relativePath = toLingdongWorkspaceRelativePath(workspacePath, trimmedPath);
    const entryPath =
      relativePath ??
      (options.allowExternalAbsolutePaths && /^(?:[a-z]:[\\/]|\/)/iu.test(trimmedPath)
        ? trimmedPath
        : null);
    if (!entryPath) continue;
    const extensionIndex = entryPath.lastIndexOf(".");
    if (extensionIndex < 0) continue;
    const extension = entryPath.slice(extensionIndex).toLowerCase();
    if (!LINGDONG_SUBMITTABLE_ENTRY_EXTENSIONS.has(extension)) continue;
    paths.set(entryPath.toLowerCase(), entryPath);
  }
  return [...paths.values()];
}

export type LingdongEntrySelectionSource = "taskChanges" | "taskStartedAt" | "workspaceLatest";

export interface LingdongEntrySelection<T> {
  readonly entry: T;
  readonly source: LingdongEntrySelectionSource;
}

function newestEntry<T extends { readonly updatedAt: number }>(candidates: readonly T[]): T | null {
  let newest: T | null = null;
  for (const candidate of candidates) {
    if (!newest || candidate.updatedAt > newest.updatedAt) newest = candidate;
  }
  return newest;
}

/**
 * 任务作品入口的唯一裁决：
 * 1. 任务 fileChanges 命中时以记录为准；
 * 2. 记录缺失时，只接受任务开始后创建/修改的入口；
 * 3. 无有效任务开始时间时不做时间兜底，避免把上一任务的旧作品交上去。
 */
export function selectLingdongEntryCandidate<
  T extends {
    readonly relativePath: string;
    readonly updatedAt: number;
  },
>(
  candidates: readonly T[],
  input: {
    readonly taskId: string | null;
    readonly taskFilePaths: ReadonlySet<string> | null;
    readonly taskStartedAtMs?: number | null;
  },
): LingdongEntrySelection<T> | null {
  if (!input.taskId) {
    const entry = newestEntry(candidates);
    return entry ? { entry, source: "workspaceLatest" } : null;
  }

  if (input.taskFilePaths) {
    const taskEntry = newestEntry(
      candidates.filter((candidate) =>
        input.taskFilePaths?.has(candidate.relativePath.toLowerCase()),
      ),
    );
    if (taskEntry) return { entry: taskEntry, source: "taskChanges" };

    const startedAtMs = input.taskStartedAtMs;
    if (!Number.isSafeInteger(startedAtMs) || (startedAtMs ?? 0) <= 0) return null;
    const earliestMtimeMs = (startedAtMs as number) - LINGDONG_TASK_ENTRY_MTIME_SKEW_MS;
    const taskWindowEntry = newestEntry(
      candidates.filter((candidate) => candidate.updatedAt >= earliestMtimeMs),
    );
    return taskWindowEntry ? { entry: taskWindowEntry, source: "taskStartedAt" } : null;
  }

  const entry = newestEntry(candidates);
  return entry ? { entry, source: "workspaceLatest" } : null;
}

/** 有 taskId 时使用任务与入口的复合键；无 taskId 保留旧版按入口去重的记录格式。 */
export function buildLingdongSubmissionRecordKey(
  taskId: string | null | undefined,
  entryRelativePath: string,
): string {
  const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
  return normalizedTaskId
    ? JSON.stringify(["task", normalizedTaskId, entryRelativePath])
    : entryRelativePath;
}
