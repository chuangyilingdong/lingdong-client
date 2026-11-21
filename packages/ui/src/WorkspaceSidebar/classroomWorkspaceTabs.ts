/** 课堂模式只保留当前课堂工作区；普通 ZCode 模式保持原顺序和全部工作区。 */
export function filterWorkspaceTabsForClassroom<
  T extends {
    readonly workspacePath: string;
    readonly workspaceIdentity?: string;
    readonly workspacePurpose?: "project" | "conversation";
  },
>(options: {
  readonly tabs: readonly T[];
  readonly classroomMode: boolean;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
}): T[] {
  if (!options.classroomMode) return [...options.tabs];
  return options.tabs
    .filter(
      (tab) =>
        tab.workspacePath === options.workspacePath &&
        (!options.workspaceIdentity || tab.workspaceIdentity === options.workspaceIdentity),
    )
    .map((tab) => ({ ...tab, workspacePurpose: "project" as const }) as T);
}

/** 课堂模式没有默认会话工作区入口，任务区只保留项目区。 */
export function filterClassroomPurposeSections<T extends string>(
  sections: readonly T[],
  classroomMode: boolean,
): T[] {
  return classroomMode ? sections.filter((section) => section !== "conversations") : [...sections];
}
