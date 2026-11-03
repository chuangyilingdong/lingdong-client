import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  completeNewModelSelection,
  normalizeModelSelection,
} from "../src/model-selection-config.js";

test("VibeCoding DeepSeek defaults to low while keeping max explicit", async () => {
  const release = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../../config/provider/zcode-builtin.json", import.meta.url)),
      "utf8",
    ),
  );
  const rule = release.config.modelConfigRules.modelRules.find(
    (candidate: { modelMatch: string }) =>
      candidate.modelMatch === ".*deepseek-flash(?:[.\\-:/\\[].*)?",
  );
  assert.ok(rule);
  assert.deepEqual(rule.config.optionSpecs.reasoningLevel.values, [
    "disabled",
    "low",
    "high",
    "max",
  ]);
  assert.equal(rule.config.optionSpecs.reasoningLevel.defaultLevel, "low");

  const registry = {
    providers: [
      {
        providerId: "lingdong-platform-gateway",
        models: [
          {
            modelId: "deepseek-flash",
            config: {
              optionSpecs: {
                reasoningLevel: {
                  values: ["disabled", "low", "high", "max"],
                  defaultLevel: "low",
                },
              },
            },
          },
        ],
      },
    ],
  };
  const selection = completeNewModelSelection(registry as never, {
    providerId: "lingdong-platform-gateway",
    modelId: "deepseek-flash",
  });
  assert.deepEqual(selection?.options, { reasoningLevel: "low" });

  const explicitMax = {
    providerId: "lingdong-platform-gateway",
    modelId: "deepseek-flash",
    options: { reasoningLevel: "max" },
  };
  assert.deepEqual(normalizeModelSelection(registry as never, explicitMax), explicitMax);
});
