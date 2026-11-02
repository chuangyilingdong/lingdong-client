# 客户端三平台构建、更新与原子发布

## 背景

客户端需要同时支持：

- `win-x64`
- `mac-arm64`
- `mac-x64`

macOS 两个架构分别发布 DMG，不生成 universal 包。三个平台共享产品名、`appId`、版本和签名策略，但更新器必须按运行中的 CPU 架构精确选择安装包，禁止跨架构回退。

## 状态所有权与边界

| 事实                  | 唯一所有者                                   | 约束                                                                  |
| --------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| 当前运行架构          | Desktop main 的更新 Provider                 | 由 `process.platform` + `process.arch` 得到 Electron release platform |
| 平台清单              | 发布脚本与平台服务共同维护的 `manifest.json` | 身份字段由发布入口原子写；后台策略字段单独持久化并回填                |
| 发布版本              | `manifest.json.version`                      | 正常三平台发布时，三个文件必须使用同一个版本                          |
| 官网当前展示的 Mac 包 | `Download` 页面本地选择                      | 只投影 manifest；检测失败时默认 Apple 芯片，并允许手动切换            |

事件顺序：

```text
build win-x64 / mac-arm64 / mac-x64
  -> 三个安装包全部上传
  -> 逐个校验远端 size + sha256
  -> 生成完整新 manifest.tmp
  -> 同目录单次 rename manifest.json
  -> 客户端/官网只可能读到旧清单或完整新清单
```

任一上传或校验失败时，不得执行 rename；旧 manifest 必须保持可读且内容不变。

## 客户端更新识别

| Electron release platform | manifest target |
| ------------------------- | --------------- |
| `windows-x86_64`          | `win-x64`       |
| `darwin-aarch64`          | `mac-arm64`     |
| `darwin-x86_64`           | `mac-x64`       |

不变量：

- 目标平台只由当前运行的 platform + arch 决定。
- 对应 `files[target]` 缺失、文件名缺失或 SHA256 缺失时返回无可用更新，不得改选另一种 Mac 架构。
- Intel Mac 只能选择 `mac-x64`；Apple Silicon 只能选择 `mac-arm64`；Windows 行为保持 `win-x64`。
- Intel 与 Apple Silicon 可以共用 `appId`、产品名和版本，但安装包文件名必须不同。

## 构建契约

- `build-mac-arm64.yml` 继续在 Apple Silicon runner 构建 `--arch arm64`。
- 新增 `build-mac-x64.yml`，在 Intel macOS runner 构建 `--arch x64`。
- 两个 workflow 使用相同的 `ZCODE_ENV`、`ZCODE_PREVIEW_IDENTITY`、`ZCODE_ENABLE_MAC_SIGN` 和 `LINGDONG_API_BASE`。
- 目标规范名分别为：
  - `lingdong-client-<版本>-mac-arm64.dmg`
  - `lingdong-client-<版本>-mac-x64.dmg`
- CI artifact 名称与导出分支分开，避免两个架构互相覆盖。
- workflow 的 artifact 名称与导出文件名从根 `package.json.version` 派生，不再硬编码发布版本；三个安装包必须使用同一个版本号。
- 本次发布候选版本为 `0.2.12`，用于验证旧 `0.2.11` 客户端升级。

## 发布契约

`deploy/publish-client.sh` 的普通发布模式接受且只接受三个包：

```text
win-x64
mac-arm64
mac-x64
```

验收规则：

1. 每个文件名都能解析出平台与版本。
2. 三个平台各出现一次，且版本完全一致。
3. 全部上传成功并逐一核对远端字节数与 SHA256。
4. 只有第 3 步全部通过后才原子替换 `manifest.json`。
5. 保留后台策略字段；发布失败时清单完全不变。
6. `--single-platform` 继续作为恢复模式：只写一个平台，并在同一次原子写中删除另外两个平台条目，避免顶层版本把旧包伪装成新包。

旧的普通双平台发布模式不再保留；需要三平台正式发布时一次传三个包，单平台恢复必须显式使用 `--single-platform`。

## 平台侧展示契约

- 服务端 `CLIENT_PLATFORMS`、宽松版本解析、严格上传文件名和后台视图都识别 `mac-x64`。
- 后台同时展示 Windows、macOS Apple 芯片、macOS Intel 芯片，并提供对应文件名示例。
- 官网下载页读取 `win-x64`、`mac-arm64`、`mac-x64`。
- 官网优先按浏览器能力检测 Mac 架构，同时保留“Apple 芯片 / Intel 芯片”手动切换；检测失败时默认 Apple 芯片。
- 选中的架构没有有效文件时展示“正在准备中”，不得回退下载另一种架构。

## 验收场景

1. Intel Mac 的 release platform 为 `darwin-x86_64`，只选择 `mac-x64`。
2. Apple Silicon 的 release platform 为 `darwin-aarch64`，只选择 `mac-arm64`。
3. 两种 Mac 缺少自身目标时都不会交叉下载。
4. Windows release platform 仍只选择 `win-x64`。
5. 三包发布 dry-run 能校验平台齐全、版本一致。
6. 三包任一上传/校验失败时，远端 manifest 的字节内容不变。
7. 三平台正式清单版本一致，三个文件均可下载且 size / SHA256 与本地一致。
8. 官网手动切换 Apple 芯片 / Intel 芯片时，下载链接指向对应 DMG。
9. 旧版 Windows 与两种 Mac 客户端都能从旧版本升级到同一新版本。
