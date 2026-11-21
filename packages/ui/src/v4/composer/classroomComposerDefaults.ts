import type { ModelSelectionView } from "@zcode/services";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

export const CLASSROOM_DEFAULT_PERMISSION_MODE = "yolo" as const;
export const CLASSROOM_DEFAULT_REASONING_LEVEL = "low" as const;

/** 课堂新任务只应用一次默认值；同草稿内后续用户修改必须保留。 */
export function applyClassroomComposerDefaults(
  draft: V4ComposerDraft,
  draftFocusVersion: number,
  view: ModelSelectionView,
): V4ComposerDraft {
  if (draft.classroomDefaultsFocusVersion === draftFocusVersion) return draft;

  const selection = draft.modelSelection;
  const model = selection
    ? view.providers
        .find((provider) => provider.providerId === selection.providerId)
        ?.models.find((candidate) => candidate.modelId === selection.modelId)
    : undefined;
  const reasoningValues = model?.config.optionSpecs.reasoningLevel?.values ?? [];
  const reasoningLevel = reasoningValues.includes(CLASSROOM_DEFAULT_REASONING_LEVEL)
    ? CLASSROOM_DEFAULT_REASONING_LEVEL
    : selection?.options?.reasoningLevel;

  return {
    ...draft,
    mode: CLASSROOM_DEFAULT_PERMISSION_MODE,
    ...(selection && reasoningLevel
      ? {
          modelSelection: {
            ...selection,
            options: {
              ...selection.options,
              reasoningLevel,
            },
          },
        }
      : {}),
    classroomDefaultsFocusVersion: draftFocusVersion,
  };
}
