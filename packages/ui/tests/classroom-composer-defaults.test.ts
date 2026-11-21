import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@zcode/services";
import {
  applyClassroomComposerDefaults,
  CLASSROOM_DEFAULT_REASONING_LEVEL,
} from "../src/v4/composer/classroomComposerDefaults.js";

const view = {
  providers: [
    {
      providerId: "lingdong-platform-gateway",
      models: [
        {
          modelId: "classroom-model",
          config: {
            optionSpecs: {
              reasoningLevel: {
                values: ["disabled", "low", "high", "max"],
                defaultLevel: "max",
              },
            },
          },
        },
      ],
    },
  ],
} as ModelSelectionView;

const draft = {
  text: "做一个网页",
  mode: "build" as const,
  planEnabled: false,
  modelSelection: {
    providerId: "lingdong-platform-gateway",
    modelId: "classroom-model",
    options: { reasoningLevel: "max" },
  },
  updatedAt: 1,
};

test("课堂新任务默认完全访问与低思考强度", () => {
  assert.deepEqual(applyClassroomComposerDefaults(draft, 1, view), {
    ...draft,
    mode: "yolo",
    modelSelection: {
      ...draft.modelSelection,
      options: { reasoningLevel: CLASSROOM_DEFAULT_REASONING_LEVEL },
    },
    classroomDefaultsFocusVersion: 1,
  });
});

test("同一条课堂草稿保留用户之后的显式选择", () => {
  const applied = applyClassroomComposerDefaults(draft, 1, view);
  const userChanged = {
    ...applied,
    planEnabled: true,
    modelSelection: {
      ...applied.modelSelection,
      options: { reasoningLevel: "high" },
    },
  };
  assert.equal(applyClassroomComposerDefaults(userChanged, 1, view), userChanged);
});

test("再次新建任务会重新应用课堂默认值", () => {
  const userChanged = {
    ...draft,
    mode: "edit" as const,
    modelSelection: {
      ...draft.modelSelection,
      options: { reasoningLevel: "high" },
    },
    classroomDefaultsFocusVersion: 1,
  };
  const next = applyClassroomComposerDefaults(userChanged, 2, view);
  assert.equal(next.mode, "yolo");
  assert.equal(next.modelSelection?.options?.reasoningLevel, "low");
  assert.equal(next.classroomDefaultsFocusVersion, 2);
});

test("模型不支持低档位时不伪造非法值", () => {
  const unsupportedView = {
    providers: [
      {
        providerId: "lingdong-platform-gateway",
        models: [
          {
            modelId: "classroom-model",
            config: {
              optionSpecs: {
                reasoningLevel: {
                  values: ["disabled", "high", "max"],
                  defaultLevel: "max",
                },
              },
            },
          },
        ],
      },
    ],
  } as ModelSelectionView;
  const next = applyClassroomComposerDefaults(draft, 1, unsupportedView);
  assert.equal(next.mode, "yolo");
  assert.equal(next.modelSelection?.options?.reasoningLevel, "max");
});
