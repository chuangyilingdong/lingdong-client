import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { resolveRuntimeToolchain } from "../src/runtime-tools/runtimeToolchain.js";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function fixture(
  options: {
    systemNodeVersion?: string;
    includeSystemNpm?: boolean;
    includeSystemGit?: boolean;
    includeBundled?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "runtime-toolchain-test-"));
  dirs.push(root);
  const systemBin = join(root, "system-bin");
  const bundled = join(root, "bundled");
  await mkdir(systemBin, { recursive: true });
  if (options.systemNodeVersion) {
    await writeFile(join(systemBin, "node"), "");
    if (options.includeSystemNpm !== false) await writeFile(join(systemBin, "npm"), "");
  }
  if (options.includeSystemGit !== false) await writeFile(join(systemBin, "git"), "");
  if (options.includeBundled !== false) {
    await mkdir(join(bundled, "node", "bin"), { recursive: true });
    await mkdir(join(bundled, "git", "bin"), { recursive: true });
    await mkdir(join(bundled, "git", "share", "git-core", "templates"), { recursive: true });
    await writeFile(join(bundled, "node", "bin", "node"), "");
    await writeFile(join(bundled, "node", "bin", "npm"), "");
    await writeFile(join(bundled, "git", "bin", "git"), "");
  }
  const versions = new Map<string, string>();
  if (options.systemNodeVersion) versions.set(join(systemBin, "node"), options.systemNodeVersion);
  versions.set(join(bundled, "node", "bin", "node"), "22.16.0");
  versions.set(join(bundled, "git", "bin", "git"), "2.56.0");
  versions.set(join(systemBin, "git"), "2.50.0");
  return {
    root,
    bundled,
    baseEnv: { PATH: systemBin },
    probeVersion: (command: string) => versions.get(command) || null,
  };
}

test("系统 Node >=22.13 与系统 Git 优先，不启用内置工具", async () => {
  const f = await fixture({ systemNodeVersion: "24.1.0" });
  const result = resolveRuntimeToolchain({
    baseEnv: f.baseEnv,
    platform: "darwin",
    arch: "arm64",
    bundledToolchainRoot: f.bundled,
    probeVersion: f.probeVersion,
  });
  assert.equal(result.node.source, "system");
  assert.equal(result.node.version, "24.1.0");
  assert.equal(result.git.source, "system");
  assert.equal(basename(result.envPatch.ZCODE_NODE_BINARY || ""), "node");
  assert.equal(basename(result.envPatch.ZCODE_GIT_BINARY || ""), "git");
  assert.equal(result.envPatch.PATH, undefined);
});

test("系统 Node 过旧时切换到内置 Node，并保留系统 Git", async () => {
  const f = await fixture({ systemNodeVersion: "16.20.0" });
  const result = resolveRuntimeToolchain({
    baseEnv: f.baseEnv,
    platform: "darwin",
    arch: "x64",
    bundledToolchainRoot: f.bundled,
    probeVersion: f.probeVersion,
  });
  assert.equal(result.node.source, "bundled");
  assert.equal(result.node.version, "22.16.0");
  assert.equal(result.node.reason, "system-node-too-old");
  assert.equal(result.git.source, "system");
  assert.equal(result.envPatch.ZCODE_NODE_BINARY, join(f.bundled, "node", "bin", "node"));
  assert.equal(
    result.envPatch.NPM_CONFIG_CACHE?.endsWith(join("runtime-toolchain", "npm-cache")),
    true,
  );
  assert.ok((result.envPatch.PATH || "").split(delimiter).includes(join(f.bundled, "node", "bin")));
});

test("系统 Git 缺失时使用内置 Git 并配置 exec/template 环境", async () => {
  const f = await fixture({ systemNodeVersion: "24.1.0", includeSystemGit: false });
  const result = resolveRuntimeToolchain({
    baseEnv: f.baseEnv,
    platform: "darwin",
    arch: "arm64",
    bundledToolchainRoot: f.bundled,
    probeVersion: f.probeVersion,
  });
  assert.equal(result.git.source, "bundled");
  assert.equal(result.git.version, "2.56.0");
  assert.equal(result.git.reason, "system-git-missing");
  assert.equal(result.envPatch.ZCODE_GIT_BINARY, join(f.bundled, "git", "bin", "git"));
  assert.equal(result.envPatch.GIT_EXEC_PATH, join(f.bundled, "git", "libexec", "git-core"));
  assert.equal(
    result.envPatch.GIT_TEMPLATE_DIR,
    join(f.bundled, "git", "share", "git-core", "templates"),
  );
  assert.ok((result.envPatch.PATH || "").split(delimiter).includes(join(f.bundled, "git", "bin")));
});

test("内置工具缺失时保留可用系统 Node/Git", async () => {
  const f = await fixture({ systemNodeVersion: "20.10.0", includeBundled: false });
  const result = resolveRuntimeToolchain({
    baseEnv: f.baseEnv,
    platform: "darwin",
    arch: "x64",
    bundledToolchainRoot: f.bundled,
    probeVersion: f.probeVersion,
  });
  assert.equal(result.node.source, "system");
  assert.equal(result.node.reason, "bundled-node-missing");
  assert.equal(result.git.source, "system");
});
test("Windows 内置 Git 配置 ucrt64 exec/template/CA 路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-toolchain-win-"));
  dirs.push(root);
  const bundled = join(root, "bundled");
  await mkdir(join(bundled, "node"), { recursive: true });
  await mkdir(join(bundled, "git", "cmd"), { recursive: true });
  await mkdir(join(bundled, "git", "usr", "bin"), { recursive: true });
  await mkdir(join(bundled, "git", "ucrt64", "bin"), { recursive: true });
  await mkdir(join(bundled, "git", "ucrt64", "libexec", "git-core"), { recursive: true });
  await mkdir(join(bundled, "git", "ucrt64", "share", "git-core", "templates"), {
    recursive: true,
  });
  await mkdir(join(bundled, "git", "ucrt64", "etc", "ssl"), { recursive: true });
  await mkdir(join(bundled, "git", "etc"), { recursive: true });
  await writeFile(join(bundled, "node", "node.exe"), "");
  await writeFile(join(bundled, "node", "npm.cmd"), "");
  await writeFile(join(bundled, "git", "cmd", "git.exe"), "");
  await writeFile(join(bundled, "git", "usr", "bin", "sh.exe"), "");
  await writeFile(join(bundled, "git", "ucrt64", "bin", "git.exe"), "");
  await writeFile(
    join(bundled, "git", "ucrt64", "libexec", "git-core", "git-credential-wincred.exe"),
    "",
  );
  await writeFile(
    join(bundled, "git", "ucrt64", "share", "git-core", "templates", "description"),
    "",
  );
  await writeFile(join(bundled, "git", "ucrt64", "etc", "ssl", "cert.pem"), "");
  await writeFile(join(bundled, "git", "etc", "gitconfig"), "");
  const versions = new Map<string, string>([
    [join(bundled, "node", "node.exe"), "22.16.0"],
    [join(bundled, "git", "cmd", "git.exe"), "2.56.0"],
  ]);
  const result = resolveRuntimeToolchain({
    baseEnv: { PATH: "" },
    platform: "win32",
    arch: "x64",
    bundledToolchainRoot: bundled,
    probeVersion: (command) => versions.get(command) || null,
  });
  assert.equal(result.node.source, "bundled");
  assert.equal(result.git.source, "bundled");
  assert.equal(
    result.envPatch.GIT_EXEC_PATH,
    join(bundled, "git", "ucrt64", "libexec", "git-core"),
  );
  assert.equal(
    result.envPatch.GIT_TEMPLATE_DIR,
    join(bundled, "git", "ucrt64", "share", "git-core", "templates"),
  );
  assert.equal(
    result.envPatch.GIT_SSL_CAINFO,
    join(bundled, "git", "ucrt64", "etc", "ssl", "cert.pem"),
  );
  assert.equal(result.envPatch.GIT_CONFIG_SYSTEM, join(bundled, "git", "etc", "gitconfig"));
  const pathEntries = (result.envPatch.PATH || "").split(delimiter);
  assert.ok(pathEntries.includes(join(bundled, "node")));
  assert.ok(pathEntries.includes(join(bundled, "git", "cmd")));
  assert.ok(pathEntries.includes(join(bundled, "git", "usr", "bin")));
  assert.ok(pathEntries.includes(join(bundled, "git", "ucrt64", "bin")));
});
