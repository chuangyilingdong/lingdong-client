# 灵动ai 客户端内置运行时工具链 Spec

- 状态：实现中（2026-11-02）
- 范围：`packages/desktop`、`packages/services`、`packages/shared`
- 目标平台：`win-x64`、`mac-x64`、`mac-arm64`，同时保持 Linux 构建可跳过

## 1. 目标

把可移植 Node.js/npm 和 Git 随桌面客户端安装包分发，使 Agent 在用户未安装开发环境时仍可执行项目依赖安装、构建和 Git 操作；用户机器已安装可用工具时优先使用系统版本。

不把用户日志打进安装包。新增的是首跑阶段诊断日志和运行时工具选择日志。

## 2. 版本与来源

- Node.js：`22.16.0`，与仓库 `engines.node >=22.13` 对齐。
- Git：Dugite Native `v2.56.0-2` 对应目标平台的归档。
- 下载源、文件名、SHA256 固定在 `third-party/runtime/toolchain.json`。
- 构建准备脚本只接受校验通过且目标架构匹配的归档。

## 3. 状态所有权

- `packages/desktop/scripts/prepare-runtime-toolchain.mjs`：唯一负责下载、校验、解包和写入 `bundled-tools/<platform>/node|git`。
- `packages/services/src/runtime-tools/runtimeToolchain.ts`：唯一负责系统/内置工具选择及环境变量构造。
- `runtimeCommandEnv.ts`：把选择结果合并进 Agent 子进程环境。
- `ZCODE_GIT_BINARY` / `ZCODE_NODE_BINARY`：选中工具链的显式路径；不得由多处各写一份。

## 4. 选择顺序

### Node/npm

1. 从登录 shell PATH 查找系统 `node` 与 `npm`。
2. 系统 Node 版本 >= 22.13.0 时使用系统工具链。
3. 否则使用内置 Node 22.16.0。
4. 内置缺失时保留系统结果（若可用），否则记录 warning，不伪造可执行路径。

### Git

1. 优先使用可执行的系统 `git`。
2. macOS 只有 `/usr/bin/git` 占位程序且无 Xcode Command Line Tools 时视为不可用。
3. 系统不可用时使用内置 Git，并设置其 `GIT_EXEC_PATH`、模板和系统配置所需变量。
4. 内置缺失时保留系统结果（若可用），否则记录 warning。

## 5. 环境边界

- 不修改系统 PATH、`.zshrc`、`/etc/paths`、Homebrew、nvm/fnm/mise 或全局 npm。
- 只修改 Agent、终端和工具子进程的环境。
- 用户系统工具优先；内置目录追加到 PATH 作为兜底。
- 内置 Node/npm 使用时，npm cache 指向灵动ai 用户数据目录，避免写安装目录。
- 不混用系统 `node` 与内置 `npm`。

## 6. 首跑日志

至少记录一次：

```text
runtime-toolchain selected source=system|bundled node=<version> npm=<version> git=<version>
runtime-toolchain bundled missing ...
runtime-toolchain version probe failed ...
```

日志不得包含 token、npm auth、用户仓库内容或命令参数。

## 7. 构建与签名

- `prepare:runtime-assets` 增加 `prepare:runtime-toolchain`。
- Windows 包携带 `node/node.exe`、`npm.cmd` 与 Git 便携目录。
- mac 包按目标 arch 分别携带 darwin-x64 / darwin-arm64 资源，不混装。
- mac 内嵌 Mach-O 必须在最终 app 签名前完成签名；沿用 `resources/tools` 时不得被 `signIgnore` 当作未验证资产。
- 新安装包版本号提升为 `0.2.13`。

## 8. 验收

1. 未安装 Node/Git 的 Windows 环境能执行 `node --version`、`npm --version`、`git --version`。
2. 已安装系统 Node/Git 的环境优先使用系统版本，不修改系统配置。
3. 系统 Node 低于 22.13 时使用内置 Node。
4. `mac-x64` 和 `mac-arm64` 包内二进制架构正确。
5. 构建日志能看到工具链来源和版本。
6. 客户端原有反馈、Agent、Browser Use、Git checkpoint 回归通过。
7. 新安装包完成三平台构建；mac 包完成签名/公证验证。

## 9. 2026-11-02 实施记录

- 新增 `third-party/runtime/toolchain.json`，固定 Node 22.16.0 与 Dugite Native Git 2.56.0 的 URLs/SHA256。
- `prepare:runtime-assets` 与开发态资源检查都会准备内置工具链。
- `afterPack` 直接复制 Node/Git 到 `Contents/Resources/tools`，因为 electron-builder 的 extraResources 默认排除 `node_modules`，会导致 npm 文件缺失。
- 已生成 Windows 测试包 `lingdong-client-0.2.13-win-x64_TEST.exe`，包内 Node/npm/Git 实测可执行，Git 可初始化仓库。
- Mac x64 与 arm64 归档校验通过，Node/Git Mach-O 架构分别为 x86_64 和 arm64；Mac 安装器仍需 macOS CI 与签名/公证。
