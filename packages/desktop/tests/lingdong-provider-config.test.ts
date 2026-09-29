import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { decodeProviderConfigFile } from "@zcode/provider-node";
import {
  createLingdongProviderBinding,
  LINGDONG_PROVIDER_ID,
} from "../src/main/lingdongProviderConfig.js";

const directories: string[] = [];
const selection = { providerId: "user-provider", modelId: "user-model" };
const external = {
  schemaVersion: 1,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: selection.providerId,
          providerName: "User Provider",
          config: {
            group: "standard-personal",
            personalModelIds: [selection.modelId],
            access: { type: "api-key", apiKey: "test-user-key" },
            api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:19190/user" },
          },
        },
      ],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    providerOrder: [selection.providerId],
    defaultModelSelection: selection,
  },
};
const context = (key = "test-gateway-key", modelId = "classroom-model") => ({
  gateway: { baseUrl: "http://127.0.0.1:19190/gateway", key },
  models: [{ id: modelId, displayName: "Classroom Model" }],
  defaultModel: modelId,
});
async function fileWith(content: unknown = external) {
  const dir = await mkdtemp(join(tmpdir(), "lingdong-provider-test-"));
  directories.push(dir);
  const file = join(dir, "provider_config.json");
  await writeFile(file, JSON.stringify(content));
  return file;
}
async function decoded(file: string) {
  return decodeProviderConfigFile(JSON.parse(await readFile(file, "utf8")));
}
after(async () => {
  for (const dir of directories) {
    const rel = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`));
    await rm(dir, { recursive: true, force: true });
  }
});

test("课堂 Provider 经真实 Personal schema 校验且保留自配 Provider", async () => {
  const file = await fileWith();
  const binding = createLingdongProviderBinding(file);
  await binding.apply(context());
  const config = await decoded(file);
  assert.equal(
    config.providers.get(LINGDONG_PROVIDER_ID)?.access?.toJSON().apiKey,
    "test-gateway-key",
  );
  assert.deepEqual(
    config.providers.get(selection.providerId)?.toJSON(),
    external.config.providerConfigRules.providerRules[0].config,
  );
  assert.deepEqual(config.defaultModelSelection, {
    providerId: LINGDONG_PROVIDER_ID,
    modelId: "classroom-model",
  });
  await binding.dispose();
  const restored = await decoded(file);
  assert.equal(restored.providers.has(LINGDONG_PROVIDER_ID), false);
  assert.deepEqual(restored.defaultModelSelection, selection);
  assert.ok(restored.providers.has(selection.providerId));
});

test("刷新替换平台模型与 key，不覆盖用户后来选择的外部默认模型", async () => {
  const file = await fileWith();
  const binding = createLingdongProviderBinding(file);
  await binding.apply(context());
  const raw = JSON.parse(await readFile(file, "utf8"));
  raw.config.defaultModelSelection = selection;
  await writeFile(file, JSON.stringify(raw));
  await binding.apply(context("test-rotated-key", "next-model"));
  const config = await decoded(file);
  assert.deepEqual(config.defaultModelSelection, selection);
  assert.deepEqual(config.providers.get(LINGDONG_PROVIDER_ID)?.personalModelIds, ["next-model"]);
  assert.equal(config.models.getExact(LINGDONG_PROVIDER_ID, "classroom-model"), undefined);
  await binding.dispose();
});

test("旧会话清理不能删除较新会话平台 Provider", async () => {
  const file = await fileWith();
  const oldBinding = createLingdongProviderBinding(file);
  const newBinding = createLingdongProviderBinding(file);
  await oldBinding.apply(context("test-old-key"));
  await newBinding.apply(context("test-new-key"));
  await oldBinding.dispose();
  assert.equal(
    (await decoded(file)).providers.get(LINGDONG_PROVIDER_ID)?.access?.toJSON().apiKey,
    "test-new-key",
  );
  await newBinding.dispose();
});

test("坏配置保留原样，禁止注入时覆盖", async () => {
  const file = await fileWith({ schemaVersion: 99, config: {} });
  const before = await readFile(file, "utf8");
  const binding = createLingdongProviderBinding(file);
  await assert.rejects(binding.apply(context()));
  assert.equal(await readFile(file, "utf8"), before);
  await binding.dispose();
});

test("缺失网关 key 或模型列表不写文件", async () => {
  const file = await fileWith();
  const before = await readFile(file, "utf8");
  const binding = createLingdongProviderBinding(file);
  await assert.rejects(
    binding.apply({ ...context(), gateway: { baseUrl: "http://127.0.0.1:19190/gateway" } }),
  );
  await assert.rejects(binding.apply({ ...context(), models: [], defaultModel: undefined }));
  assert.equal(await readFile(file, "utf8"), before);
  await binding.dispose();
});

test("实际 Built-in + Personal Runtime 读取到平台模型（不再伪造 Built-in release）", async () => {
  const file = await fileWith();
  const binding = createLingdongProviderBinding(file);
  await binding.apply(context());
  const { NodeProviderConfigRuntime } = await import("@zcode/provider-node");
  const runtime = new NodeProviderConfigRuntime({
    zcodeBuiltinFilePath: resolve("config/provider/zcode-builtin.json"),
    personalFilePath: file,
    watch: false,
    personalPollingIntervalMs: false,
  });
  try {
    await runtime.start();
    const view = await runtime.configService.read();
    assert.ok(view.personalProviders.has(LINGDONG_PROVIDER_ID));
    assert.ok(view.personalProviders.has(selection.providerId));
    assert.equal(
      view.personalModels.getExact(LINGDONG_PROVIDER_ID, "classroom-model")?.enabled,
      true,
    );
    assert.deepEqual((await runtime.personalRepository.read()).defaultModelSelection, {
      providerId: LINGDONG_PROVIDER_ID,
      modelId: "classroom-model",
    });
  } finally {
    runtime.dispose();
    await binding.dispose();
  }
});
