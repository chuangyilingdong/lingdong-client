#!/usr/bin/env node

// 准备随桌面客户端分发的 Node.js/npm 与 Git。
// 下载源和 SHA256 固定在 third-party/runtime/toolchain.json，产物只写 bundled-tools/<platform>。
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getTargetPlatform } from "./target-platform.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const target = getTargetPlatform();
const supportedKeys = new Set(["win32-x64", "darwin-x64", "darwin-arm64"]);
const toolchainConfig = JSON.parse(
  await readFile(join(repoRoot, "third-party/runtime/toolchain.json"), "utf8"),
);
const outputRoot = join(desktopRoot, "bundled-tools", target.key);
const cacheRoot = join(repoRoot, "node_modules/.cache/zcode-runtime-toolchain");
const markerPath = join(outputRoot, ".toolchain.json");
const nodeEntry = toolchainConfig.node.platforms[target.key];
const gitEntry = toolchainConfig.git.platforms[target.key];

if (target.os === "darwin" && process.platform !== "darwin") {
  throw new Error(
    "macOS runtime toolchain must be prepared on macOS to preserve executable bits and symlinks",
  );
}

if (!supportedKeys.has(target.key) || !nodeEntry || !gitEntry) {
  console.warn(`[runtime-toolchain] skip unsupported target ${target.key}`);
  process.exit(0);
}

function log(message) {
  console.log(`[runtime-toolchain] ${message}`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function download(url, destination, expectedSha256) {
  if (await pathExists(destination)) {
    const existing = await sha256File(destination);
    if (existing === expectedSha256) return;
    await rm(destination, { force: true });
  }
  await mkdir(dirname(destination), { recursive: true });
  const tempPath = `${destination}.download`;
  await rm(tempPath, { force: true });
  log(`download ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
  const actual = await sha256File(tempPath);
  if (actual !== expectedSha256) {
    await rm(tempPath, { force: true });
    throw new Error(`sha256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
  }
  await rename(tempPath, destination);
}

function nodeBaseUrl() {
  const mirror =
    process.env.ZCODE_RUNTIME_NODE_DIST_MIRROR?.trim() ||
    process.env.ZCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || toolchainConfig.node.defaultBaseUrl).replace(/\/+$/u, "");
}

async function extractArchive(archive, destination) {
  await mkdir(destination, { recursive: true });
  runCommand("tar", ["-xf", archive, "-C", destination], {
    cwd: repoRoot,
    env: process.env,
  });
}

async function firstDirectory(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) {
    throw new Error(`expected exactly one top-level directory in ${path}`);
  }
  return join(path, directories[0].name);
}

async function copyDirectory(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (path) => !path.endsWith(".DS_Store"),
  });
}

async function readBinaryArchitecture(filePath) {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 64) return null;
    const magicLe = header.readUInt32LE(0);
    if (
      [
        0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
        0xbfbafeca,
      ].includes(magicLe)
    ) {
      const cpu =
        magicLe === 0xcefaedfe || magicLe === 0xcffaedfe
          ? header.readUInt32BE(4)
          : header.readUInt32LE(4);
      return cpu === 0x01000007
        ? "x64"
        : cpu === 0x0100000c
          ? "arm64"
          : `mach-o-0x${cpu.toString(16)}`;
    }
    if (header[0] === 0x4d && header[1] === 0x5a) {
      const peOffset = header.readUInt32LE(0x3c);
      if (
        peOffset + 6 <= bytesRead &&
        header.toString("ascii", peOffset, peOffset + 4) === "PE\u0000\u0000"
      ) {
        const machine = header.readUInt16LE(peOffset + 4);
        return machine === 0x8664
          ? "x64"
          : machine === 0xaa64
            ? "arm64"
            : `pe-0x${machine.toString(16)}`;
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function assertBinaryArchitecture(filePath, expectedArch, label) {
  const actual = await readBinaryArchitecture(filePath);
  if (actual !== expectedArch) {
    throw new Error(
      `${label} architecture mismatch: expected ${expectedArch}, got ${actual || "unknown"} (${filePath})`,
    );
  }
}

async function assertRequiredFiles(root, relativePaths, label) {
  for (const relativePath of relativePaths) {
    const fullPath = join(root, relativePath);
    if (!(await pathExists(fullPath))) {
      throw new Error(`${label} missing required file: ${fullPath}`);
    }
  }
}

function nodeRequiredFiles() {
  return target.os === "win32"
    ? ["node.exe", "npm.cmd", "npx.cmd", "node_modules/npm/bin/npm-cli.js"]
    : ["bin/node", "bin/npm", "bin/npx", "lib/node_modules/npm/bin/npm-cli.js"];
}

function gitRequiredFiles() {
  return target.os === "win32"
    ? ["cmd/git.exe", "ucrt64/bin/git.exe", "ucrt64/libexec/git-core/git-credential-wincred.exe"]
    : ["bin/git", "libexec/git-core/git", "share/git-core/templates"];
}

async function prepareNode(archive) {
  const staging = await mkdtemp(join(tmpdir(), "zcode-node-toolchain-"));
  try {
    await extractArchive(archive, staging);
    const extractedRoot = await firstDirectory(staging);
    const destination = join(outputRoot, "node");
    await copyDirectory(extractedRoot, destination);
    await assertRequiredFiles(destination, nodeRequiredFiles(), "Node");
    await assertBinaryArchitecture(
      target.os === "win32" ? join(destination, "node.exe") : join(destination, "bin", "node"),
      target.arch,
      "Node",
    );
    if (target.os !== "win32") {
      for (const relativePath of ["bin/node", "bin/npm", "bin/npx"]) {
        const filePath = join(destination, relativePath);
        if ((await stat(filePath)).isFile()) {
          await chmod(filePath, 0o755);
        }
      }
    }
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function prepareGit(archive) {
  const staging = await mkdtemp(join(tmpdir(), "zcode-git-toolchain-"));
  try {
    await extractArchive(archive, staging);
    const destination = join(outputRoot, "git");
    await copyDirectory(staging, destination);
    await assertRequiredFiles(destination, gitRequiredFiles(), "Git");
    await assertBinaryArchitecture(
      target.os === "win32"
        ? join(destination, "ucrt64", "bin", "git.exe")
        : join(destination, "bin", "git"),
      target.arch,
      "Git",
    );
    if (target.os !== "win32") {
      await chmod(join(destination, "bin/git"), 0o755);
    }
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function isReady() {
  if (!(await pathExists(markerPath))) return false;
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker.schemaVersion !== 1 || marker.platform !== target.key) return false;
    if (marker.nodeVersion !== toolchainConfig.node.version) return false;
    if (marker.gitVersion !== toolchainConfig.git.version) return false;
    if (marker.nodeSha256 !== nodeEntry.sha256 || marker.gitSha256 !== gitEntry.sha256)
      return false;
    await assertRequiredFiles(join(outputRoot, "node"), nodeRequiredFiles(), "Node");
    await assertBinaryArchitecture(
      target.os === "win32"
        ? join(outputRoot, "node", "node.exe")
        : join(outputRoot, "node", "bin", "node"),
      target.arch,
      "Node",
    );
    if (!(await pathExists(join(outputRoot, "node", "SOURCES.json")))) return false;
    await assertRequiredFiles(join(outputRoot, "git"), gitRequiredFiles(), "Git");
    await assertBinaryArchitecture(
      target.os === "win32"
        ? join(outputRoot, "git", "ucrt64", "bin", "git.exe")
        : join(outputRoot, "git", "bin", "git"),
      target.arch,
      "Git",
    );
    if (!(await pathExists(join(outputRoot, "git", "SOURCES.json")))) return false;
    return true;
  } catch {
    return false;
  }
}

if (await isReady()) {
  log(
    `ready ${target.key} node=${toolchainConfig.node.version} git=${toolchainConfig.git.version}`,
  );
  process.exit(0);
}

await mkdir(cacheRoot, { recursive: true });
const nodeArchive = join(cacheRoot, nodeEntry.fileName);
const gitArchive = join(cacheRoot, gitEntry.fileName);
await download(`${nodeBaseUrl()}/${nodeEntry.fileName}`, nodeArchive, nodeEntry.sha256);
await download(gitEntry.url, gitArchive, gitEntry.sha256);
await mkdir(outputRoot, { recursive: true });
log(`stage Node ${toolchainConfig.node.version} for ${target.key}`);
await prepareNode(nodeArchive);
log(`stage Git ${toolchainConfig.git.version} for ${target.key}`);
await prepareGit(gitArchive);
await writeFile(
  join(outputRoot, "node", "SOURCES.json"),
  JSON.stringify(
    {
      component: "Node.js",
      version: toolchainConfig.node.version,
      platform: target.key,
      url: `${nodeBaseUrl()}/${nodeEntry.fileName}`,
      sha256: nodeEntry.sha256,
      license: "LICENSE",
    },
    null,
    2,
  ),
);
await writeFile(
  join(outputRoot, "git", "SOURCES.json"),
  JSON.stringify(
    {
      component: "Git",
      version: toolchainConfig.git.version,
      distribution: toolchainConfig.git.distribution,
      platform: target.key,
      url: gitEntry.url,
      sha256: gitEntry.sha256,
      license: "LICENSE.txt",
    },
    null,
    2,
  ),
);
await writeFile(
  markerPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      platform: target.key,
      nodeVersion: toolchainConfig.node.version,
      nodeSha256: nodeEntry.sha256,
      gitVersion: toolchainConfig.git.version,
      gitSha256: gitEntry.sha256,
      preparedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
log(`ready ${target.key} node=${toolchainConfig.node.version} git=${toolchainConfig.git.version}`);
