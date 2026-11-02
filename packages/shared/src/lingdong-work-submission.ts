export const LINGDONG_MAX_TASK_ID_LENGTH = 200;

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
): string[] {
  const paths = new Map<string, string>();
  for (const filePath of filePaths) {
    const relativePath = toLingdongWorkspaceRelativePath(workspacePath, filePath);
    if (!relativePath) continue;
    const extensionIndex = relativePath.lastIndexOf(".");
    if (extensionIndex < 0) continue;
    const extension = relativePath.slice(extensionIndex).toLowerCase();
    if (!LINGDONG_SUBMITTABLE_ENTRY_EXTENSIONS.has(extension)) continue;
    paths.set(relativePath.toLowerCase(), relativePath);
  }
  return [...paths.values()];
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
