import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

function source(file: string): string {
  return readFileSync(resolve(repoRoot, file), "utf8");
}

test("macOS 构建 workflow 从 package.json 派生 artifact 版本", () => {
  for (const file of [
    ".github/workflows/build-mac-arm64.yml",
    ".github/workflows/build-mac-x64.yml",
  ]) {
    const workflow = source(file);
    assert.match(workflow, /id: package/u, `${file} 缺少读取版本步骤`);
    assert.match(
      workflow,
      /lingdong-client-\$\{\{ steps\.package\.outputs\.version \}\}-mac-(?:arm64|x64)/u,
      `${file} artifact 名称没有从 package.json 派生`,
    );
    assert.doesNotMatch(workflow, /lingdong-client-\d+\.\d+\.\d+-mac-/u, `${file} 仍有硬编码版本`);
  }
});

test("macOS 导出 workflow 从 package.json 派生目标版本和 artifact 名称", () => {
  for (const file of [
    ".github/workflows/export-current-mac.yml",
    ".github/workflows/export-current-mac-x64.yml",
  ]) {
    const workflow = source(file);
    assert.match(workflow, /target_version=\$\(jq -r '\.version' package\.json\)/u);
    assert.match(
      workflow,
      /source_artifact="lingdong-client-\$\{target_version\}-mac-(?:arm64|x64)"/u,
    );
    assert.doesNotMatch(workflow, /TARGET_VERSION: \d+\.\d+\.\d+/u, `${file} 仍有硬编码目标版本`);
  }
});
