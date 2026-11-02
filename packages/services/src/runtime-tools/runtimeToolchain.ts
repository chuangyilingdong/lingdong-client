import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";
import { prependPathEntries } from "./runtimeToolResolver.js";

const MINIMUM_NODE_VERSION = "22.13.0";
const logger = createServiceLogger("runtime-toolchain");
let loggedSelectionKey = "";

export type RuntimeToolchainSource = "system" | "bundled" | "missing";

export interface RuntimeToolchainSelection {
  source: RuntimeToolchainSource;
  command: string | null;
  version: string | null;
  reason?: string;
}

export interface RuntimeToolchainResolution {
  node: RuntimeToolchainSelection;
  git: RuntimeToolchainSelection;
  envPatch: Record<string, string>;
}

export interface RuntimeToolchainOptions {
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string;
  cwd?: string;
  bundledToolchainRoot?: string;
  probeVersion?: (command: string, args: string[], env: NodeJS.ProcessEnv) => string | null;
}

function firstExisting(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

function findCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const pathValue = env.PATH;
  if (!pathValue) return null;
  const extensions =
    platform === "win32"
      ? (env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".COM"])
      : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function probeVersionDefault(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  const text = String(result.stdout || "").trim();
  const match = text.match(/v?(\d+\.\d+\.\d+)/);
  return match?.[1] || null;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part) || 0);
  const b = right.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function resolveBundledRoot(tool: "node" | "git", options: RuntimeToolchainOptions): string | null {
  if (options.bundledToolchainRoot) {
    return resolve(options.bundledToolchainRoot, tool);
  }
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const resourcesPath =
    options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const cwd = options.cwd ?? process.cwd();
  return firstExisting([
    resourcesPath ? resolve(resourcesPath, "tools", tool) : "",
    resolve(cwd, "bundled-tools", `${platform}-${arch}`, tool),
    resolve(cwd, "packages", "desktop", "bundled-tools", `${platform}-${arch}`, tool),
  ]);
}

function bundledNodePaths(root: string | null, platform: NodeJS.Platform) {
  if (!root) return null;
  const command = firstExisting([
    platform === "win32" ? join(root, "node.exe") : join(root, "bin", "node"),
  ]);
  if (!command) return null;
  return {
    command,
    binDir: dirname(command),
    npm: firstExisting([platform === "win32" ? join(root, "npm.cmd") : join(root, "bin", "npm")]),
  };
}

function bundledGitPaths(root: string | null, platform: NodeJS.Platform) {
  if (!root) return null;
  if (platform === "win32") {
    const command = firstExisting([join(root, "cmd", "git.exe")]);
    if (!command) return null;
    return {
      command,
      root,
      binDirs: [join(root, "cmd"), join(root, "usr", "bin"), join(root, "ucrt64", "bin")],
      execPath: join(root, "ucrt64", "libexec", "git-core"),
    };
  }
  const command = firstExisting([join(root, "bin", "git")]);
  if (!command) return null;
  return {
    command,
    root,
    binDirs: [join(root, "bin")],
    execPath: join(root, "libexec", "git-core"),
  };
}

function isDarwinGitUsable(
  gitPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean {
  if (platform !== "darwin" || gitPath !== "/usr/bin/git") return true;
  const result = spawnSync("xcode-select", ["-p"], {
    env,
    stdio: "ignore",
    timeout: 2_000,
  });
  return !result.error && result.status === 0;
}

export function resolveRuntimeToolchain(
  options: RuntimeToolchainOptions = {},
): RuntimeToolchainResolution {
  const startedAt = Date.now();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const baseEnv = options.baseEnv ?? process.env;
  const probe = options.probeVersion ?? probeVersionDefault;
  const envPatch: Record<string, string> = {};
  const pathEntries: string[] = [];

  const systemNode = findCommandOnPath("node", baseEnv, platform);
  const systemNpm = findCommandOnPath("npm", baseEnv, platform);
  const systemNodeVersion = systemNode ? probe(systemNode, ["--version"], baseEnv) : null;
  const bundledNode = bundledNodePaths(
    resolveBundledRoot("node", { ...options, platform, arch }),
    platform,
  );
  const bundledNodeVersion = bundledNode
    ? probe(bundledNode.command, ["--version"], baseEnv)
    : null;
  let node: RuntimeToolchainSelection;
  if (
    systemNode &&
    systemNpm &&
    systemNodeVersion &&
    compareVersions(systemNodeVersion, MINIMUM_NODE_VERSION) >= 0
  ) {
    node = { source: "system", command: systemNode, version: systemNodeVersion };
    envPatch.ZCODE_NODE_BINARY = systemNode;
  } else if (bundledNode) {
    node = {
      source: "bundled",
      command: bundledNode.command,
      version: bundledNodeVersion,
      reason: !systemNode
        ? "system-node-missing"
        : !systemNpm
          ? "system-npm-missing"
          : "system-node-too-old",
    };
    pathEntries.push(bundledNode.binDir);
    envPatch.ZCODE_NODE_BINARY = bundledNode.command;
    const runtimeRoot = join(getAppConfigDir(), "runtime-toolchain");
    envPatch.NPM_CONFIG_CACHE = join(runtimeRoot, "npm-cache");
    envPatch.NPM_CONFIG_PREFIX = join(runtimeRoot, "npm-global");
    envPatch.NPM_CONFIG_UPDATE_NOTIFIER = "false";
    envPatch.NPM_CONFIG_FUND = "false";
  } else if (systemNode && systemNpm) {
    node = {
      source: "system",
      command: systemNode,
      version: systemNodeVersion,
      reason: "bundled-node-missing",
    };
    envPatch.ZCODE_NODE_BINARY = systemNode;
  } else {
    node = { source: "missing", command: null, version: null, reason: "node-and-npm-unavailable" };
  }

  const systemGit = findCommandOnPath("git", baseEnv, platform);
  const systemGitVersion =
    systemGit && isDarwinGitUsable(systemGit, platform, baseEnv)
      ? probe(systemGit, ["--version"], baseEnv)
      : null;
  const bundledGit = bundledGitPaths(
    resolveBundledRoot("git", { ...options, platform, arch }),
    platform,
  );
  const bundledGitVersion = bundledGit ? probe(bundledGit.command, ["--version"], baseEnv) : null;
  let git: RuntimeToolchainSelection;
  if (systemGit && systemGitVersion) {
    git = { source: "system", command: systemGit, version: systemGitVersion };
    envPatch.ZCODE_GIT_BINARY = systemGit;
  } else if (bundledGit) {
    git = {
      source: "bundled",
      command: bundledGit.command,
      version: bundledGitVersion,
      reason: systemGit ? "system-git-unusable" : "system-git-missing",
    };
    pathEntries.push(...bundledGit.binDirs);
    envPatch.ZCODE_GIT_BINARY = bundledGit.command;
    envPatch.GIT_EXEC_PATH = bundledGit.execPath;
    const systemConfig = join(bundledGit.root, "etc", "gitconfig");
    if (existsSync(systemConfig)) envPatch.GIT_CONFIG_SYSTEM = systemConfig;
    const templateDir =
      platform === "win32"
        ? join(bundledGit.root, "ucrt64", "share", "git-core", "templates")
        : join(bundledGit.root, "share", "git-core", "templates");
    if (existsSync(templateDir)) envPatch.GIT_TEMPLATE_DIR = templateDir;
    const caBundle =
      platform === "win32"
        ? join(bundledGit.root, "ucrt64", "etc", "ssl", "cert.pem")
        : join(bundledGit.root, "ssl", "cacert.pem");
    if (existsSync(caBundle)) envPatch.GIT_SSL_CAINFO = caBundle;
  } else {
    git = { source: "missing", command: null, version: null, reason: "git-unavailable" };
  }

  if (pathEntries.length > 0) {
    envPatch.PATH = prependPathEntries(baseEnv.PATH, pathEntries);
  }

  const selectionKey = `${platform}-${arch}-${node.source}-${node.version}-${git.source}-${git.version}`;
  if (selectionKey !== loggedSelectionKey) {
    loggedSelectionKey = selectionKey;
    logger.info("runtime toolchain resolved", {
      platform,
      arch,
      durationMs: Date.now() - startedAt,
      node: { source: node.source, version: node.version, reason: node.reason },
      git: { source: git.source, version: git.version, reason: git.reason },
    });
    if (node.source === "missing")
      logger.warn("bundled runtime toolchain missing Node/npm", node.reason);
    if (git.source === "missing") logger.warn("bundled runtime toolchain missing Git", git.reason);
  }

  return { node, git, envPatch };
}
