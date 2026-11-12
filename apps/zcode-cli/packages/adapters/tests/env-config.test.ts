import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "@zcode/contracts";
import { createConfig, parseEnvConfig } from "../src/config/index.js";

test("模型流 idle timeout 从环境变量映射到运行时配置", () => {
  assert.deepEqual(
    parseEnvConfig({
      ZCODE_MODEL_STREAM_IDLE_TIMEOUT_MS: "1200000",
    }),
    {
      modelStream: { idleTimeoutMs: 1_200_000 },
    },
  );
});

test("非法模型流 idle timeout 环境变量不覆盖默认值", () => {
  for (const value of ["", "not-a-number", "0", "-1", "Infinity"]) {
    assert.deepEqual(
      parseEnvConfig({
        ZCODE_MODEL_STREAM_IDLE_TIMEOUT_MS: value,
      }),
      {},
    );
  }
});

test("未配置课堂环境时仍使用 10 分钟默认值", () => {
  const result = createConfig({ env: {}, skipUserConfig: true });
  assert.equal(result.config.modelStream.idleTimeoutMs, DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS);
  assert.equal(result.config.modelStream.idleTimeoutMs, 600_000);
});

test("环境变量值进入最终合并配置", () => {
  const result = createConfig({
    env: { ZCODE_MODEL_STREAM_IDLE_TIMEOUT_MS: "1200000" },
    skipUserConfig: true,
  });
  assert.equal(result.config.modelStream.idleTimeoutMs, 1_200_000);
});
