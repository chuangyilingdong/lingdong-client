# Windows ZCode 迁移阶段验收（2026-09-29）

## 范围与结论

本轮只推进 Windows；Windows 已发布 `0.2.0-zcode.2`，没有修改学习平台仓库，不处理 Mac。**迁移尚未整体完成**。

本轮修复：

1. 平台 Provider 从不合法的 Built-in release 改为合法的 Personal Config，并复用公开 codec 与配置仓库。
2. 只合并/清理平台 Provider，保留学生自配 Provider 与个人默认选择；坏配置不覆盖，旧会话不移除较新密钥。
3. Main 先解析数据根再写课堂配置，Host 读取同一路径。
4. 登录窗口不是主窗口，启动门保护零窗口过渡；退出清理进入现有 Host shutdown 屏障。
5. 有可用课堂/个人模型时，不因缺少厂商 family 而再次要求 OAuth 登录。
6. 桌面主窗口标题改为“灵动ai创作客户端”。

## 已执行验证

| 验证                                | 结果                         | 边界                                              |
| ----------------------------------- | ---------------------------- | ------------------------------------------------- |
| `pnpm typecheck`                    | 通过                         | 当前源码                                          |
| `pnpm lint`                         | 通过，68 warnings / 0 errors | 警告为当前仓库已有项                              |
| `pnpm architecture:check --changed` | 通过，0 violations           | baseline / new 均为 0                             |
| `pnpm test:platform`                | 9 / 9 通过                   | 配置 codec / Runtime + 启动登录条件               |
| `pnpm smoke:platform`               | 通过                         | mock 接口合同，不是实际模型运行                   |
| Desktop `build:no-runtime-assets`   | 通过                         | 源码产物；UI 后续单独重建也通过                   |
| `pnpm smoke:platform:windows`       | 通过                         | 本机 Electron + 独立测试数据目录 + localhost mock |
| 正常退出                            | 通过                         | Host/Agent 退出，个人配置文件保留，平台条目已移除 |

Windows E2E 已从 UI 执行：

```text
平台 mock 登录 → 课堂目录 → 平台默认模型
  → Agent 请求 /gateway/v1/chat/completions（独立 gateway key）
  → SSE 文本回复
  → 第一轮 Read / tool result
  → 第二轮 Read / tool result
  → 最终回复
  → 提交 index.html + PNG 封面
  → 刷新作品列表
```

mock 观测到 tool result 数量依次为 0、1、2；作品包含 index.html 且 cover=true。

## 可重复入口

- 单元/运行时回归：`pnpm test:platform`
- 额度场景：`pnpm smoke:platform:quota` / `:zero` / `:unlimited`
- 更新联动：`pnpm smoke:platform:update`
- 本地 mock：`node packages/desktop/tests/mock-platform.mjs`
- 已启动的独立 Windows Electron 测试实例：`pnpm smoke:platform:windows`
- E2E 默认 CDP `http://127.0.0.1:9229`、mock `http://127.0.0.1:19090`，仅允许 localhost 地址；可用 `LINGDONG_E2E_CDP` / `LINGDONG_E2E_MOCK` 指定。
- 测试实例必须隔离 `HOME`、`ZCODE_DESKTOP_HOME_DIR`、`ZCODE_DATA_BASE_DIR`、`ZCODE_DESKTOP_USER_DATA_DIR`，并设置 `LINGDONG_API_BASE` 为 mock 地址。不要用日常真实账号或个人配置目录运行测试。
- 当前开发 Electron 依赖缺少可执行文件，本次使用本地 Electron 41.0.3 缓存解压的运行时，没有重新安装依赖。Node 实际为 24.19.0，`mise.toml` 固定值为 24.14.0，最终 CI/发布应按固定版本再验收。

## 已完成的阶段验证（2026-09-29 追加）

- `pnpm test:platform`（Provider/启动门/额度）全部通过；`pnpm smoke:platform` 通过。
- `pnpm smoke:platform:windows`：流式文本 + 两轮工具 + 带封面交作品 + 课堂预设（均经 `IPlatformService.classroom`）通过。
- `pnpm smoke:platform:quota` / `:zero` / `:unlimited`：三个额度场景通过。
- 正常退出：个人配置文件保留、本课堂平台条目清除。

## 必须继续完成的项

### 发送次数（本机投影已完成，平台口径待联调）

已完成：

- 新增 `packages/services/src/zcode-agent/lingdongQuotaLedger.ts`：同机多 Host 共享一个带文件锁的课堂额度投影，原子写，按 workspace identity + sessionId + commandId 幂等。
- 计数收口到 Service 实际命令入口：V4 `sendText`、`createSession.firstInput`、附件兼容 `session/send`；空会话预热、工具回合、`workspaceGenerateText` 不计数。
- Main 在登录时按平台 used 建立基线，课堂上下文刷新时向平台 used 单调收敛；不同课堂用不同 identity 桶。
- 仅 `lingdong-platform-gateway` 消耗课堂投影；学生自配 Provider 不受影响。
- 删除旧的 `lingdongQuota.ts`（只挂在旧 adapter，V4 主路径绕不过去）及其失效环境变量。
- UI 增加专用提示“本节课发送次数已用完，请先保存当前想法或联系老师。”，不再显示通用发送失败。

实测（独立测试数据根 + localhost mock，`pnpm smoke:platform:quota*`）：

| 场景                   | 网关流式请求                  | 额度提示 |
| ---------------------- | ----------------------------- | -------- |
| `limit=0`              | 0                             | 显示     |
| `limit=1`              | 1（第二次本地拦截，无新请求） | 显示     |
| `limit=null` 连发 3 次 | 3                             | 不显示   |

额度单元测试 6/6：空值不误判为 0、显式 0 拦截、同命令重放只占一次、明确拒绝释放预留、ACK 不确定保留、两个 ledger 实例并发只放行最后一个名额、平台 used 更新不会压低本机已接受计数。

尚未完成（需要平台配合/真实课堂）：

- 平台 `enforceVibecodingSendLimit` 与客户端“一次提交 = 一次”的口径对齐；客户端工具回合会多次请求网关，平台不得重复计数。
- 真实平台 429 + `SEND_QUOTA_EXCEEDED` 端到端一次，以及多课堂切换时额度隔离。
- `limit` 为 null 时平台必须下发 null/空值而不是 0。

### 平台与 UI 边界

- 真实平台账号/多课堂切换、401/403/SESSION_SUPERSEDED、额度耗尽。
- 真实平台的流式 usage / 缓存 token / compute_attempts 与 usage_records 对账。
- ~~课堂预设/交作品 UI 直接调用 `window.lingdong`~~ **已完成**：课堂能力已纳入 `IPlatformService.classroom`（`IClassroomPlatformService`），UI 通过 `usePlatform()` 消费；`window.lingdong` 只保留在 `desktopPlatform.ts` 适配层一处，Web/手机按能力缺省处理并在缺失时给出明确提示。
- 平台身份展示、退出/切号全流程、启动更新在正式安装包中的验证。

### 更新联动（2026-09-29 已验证客户端侧闭环）

已用真实 `autoUpdater` + `ManifestUpdateProvider` + 本地 mock 清单跑通：

| 场景                                                | 期望                                             | 结果 |
| --------------------------------------------------- | ------------------------------------------------ | ---- |
| 清单 `version=0.2.0-zcode.2`、`sha256` 与安装包一致 | 检出更新 → 下载 → 校验通过 → `update-downloaded` | 通过 |
| 清单 `sha256` 被篡改                                | 校验失败报错，且不得进入 `update-downloaded`     | 通过 |

证据来自 main 进程日志与 mock 侧下载计数：

- `[auto-update] initializing, current version: 0.2.0-zcode.1`
- `[auto-update] new version available: 0.2.0-zcode.2`
- `[auto-update] download progress: …%`
- `[auto-update] downloaded: 0.2.0-zcode.2`（仅正例）
- `[auto-update] error:`（仅反例）

运行方式：`pnpm smoke:platform:update`（需先启动 `packages/desktop/tests/mock-platform.mjs`）。该脚本使用 `ZCODE_AUTO_UPDATE_DEV=1` 开发态开关，仅用于本地验证清单/下载/校验链路，不改变生产包行为。

仍待完成（需要真实环境）：

- 从最终提交重新构建 Windows 安装包，再在真实清单上验证“下载 → 用户确认 → 安装替换 → 版本变更”。
- 平台侧确认 `downloads/` 目录与 `manifest.json` 同源，安装包公网可下且 `sha256`/`size` 与实际字节严格一致。

## 打包态验证（app.isPackaged = true，2026-09-29）

前面两个阻断缺陷（强更门误拦、Provider schema 不合法）只在打包/真实路径暴露，因此本轮补做了打包态验证。使用 `win-unpacked` 产物（未安装到系统，避免污染本机），连本地 mock：

| 验证                                                     | 命令                                                                     | 结果     |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | -------- |
| 打包态启动不被强更门拦截，显示平台登录门                 | `pnpm e2e:packaged:launch`                                               | 通过     |
| 打包态课堂全链路（登录/流式/两轮工具/交作品+封面/预设）  | `pnpm smoke:platform:packaged`                                           | 通过     |
| 打包态额度 0 / 1 / 无限                                  | `pnpm smoke:platform:quota*`（配合 `LINGDONG_E2E_SESSION`）              | 3/3 通过 |
| 打包态生产更新路径（无 dev 开关）：清单→下载→sha256 校验 | `pnpm smoke:platform:update:packaged`                                    | 通过     |
| 单课堂直接进入（平台规则主路径）                         | `node packages/desktop/tests/windows-classroom-selection.e2e.mjs single` | 通过     |
| 平台下发 2 节 ACTIVE（脏数据）仍无选择 UI                | `node packages/desktop/tests/windows-classroom-entry.e2e.mjs two-active` | 通过     |

打包态产物（源码提交 `5a9ac9d`，仅用于验证，**不是发布候选**）：

```text
文件：.tmp/verify-win/lingdong-client-0.2.0-zcode.1-win-x64.exe
大小：149,751,501 字节
SHA256：1F53D8D0A7C9EB974475EC403F6CBF1B71767BAFBCC6690612F238E372F64ED2
```

注意：该产物构建于后续仅测试脚本改动之前，且未做代码签名；正式发布必须从最终提交重新构建并重新采集 size/SHA256。

未在打包态验证的部分：NSIS 安装/卸载流程、安装后真实更新替换、代码签名校验——这些需要真实发布环境，等用户确认后再做。

## 安装包状态

本轮运行验收使用的是最新源码产物，不是最终安装包。

`dist/win-x64` 与 `.tmp/verify-win` 中现有同版本 EXE 早于后续 Provider/首屏修复，**不是可发布候选**，不可复用或直接发给学生。所有本地代码验收完成后应从最终提交重新构建 Windows 包，采集 size/SHA256，验证安装和更新，再等用户单独确认发布。

Mac 暂不推进。现有发布脚本仍有双端版本一致性约束；Windows-only 发布策略留待发布前确认，不能为了绕过脚本直接改线上清单。

## 课堂平台边界收口（2026-09-29 追加）

### 所有者与接口

- 契约：`packages/shared/src/platform.ts` 新增 `IClassroomPlatformService` 与 `ClassroomPreset / ClassroomWorkspaceScan / ClassroomWorkSubmission / ClassroomSubmitResult / ClassroomWorksList`，并作为 `IPlatformService.classroom` 暴露。
- 适配：`packages/desktop/src/renderer/src/desktopPlatform.ts` 是唯一读取 `window.lingdong` 的位置；preload 未注入时 `classroom` 缺省。
- 消费：`LingdongPresetsDialog` 用 `classroom.getPresets()`；`LingdongWorksDialog` 用 `scanWorkspaceFiles() / submitWork() / listWorks()`。
- 凭据仍只在 main：renderer 只拿到预设、文件候选、提交结果与作品列表，拿不到平台 token 或网关 key。

### 语义

- `copyrightConfirmed` 只在用户点击“确认并提交 N 个文件”后置真；按钮文案即确认动作，UI 不再隐式默认。
- 缺少 `classroom` 能力（Web/手机）时提示“当前环境不支持课堂作品提交。”，不再退化成“无法扫描课堂工作区”。
- 可选封面失败仍不阻断正文提交（由 main 采集，客户端不感知）。

### 验收

`pnpm smoke:platform:windows` 在独立数据根 + localhost mock 下通过，覆盖预设弹窗与交作品弹窗；两条路径都经由 `IPlatformService.classroom`。

## 课堂进入验证结论（2026-09-29）

按产品口径「一个学生同时只能有 1 个进行中的课堂，不存在选择逻辑」核对并修改了客户端：

- 客户端**删除全部课堂选择逻辑**：不再传 `sessionId`、不再渲染选择 UI、不再保存待选课堂。
- 登录后直接用 `client-context` 返回的 `classroom` 进入；无可进课堂时原样展示平台 `message`。
- 平台源码确认该规则被强制：`activeParticipationFor` 在两条写路径拦未终态占用（`IN_OTHER_SESSION`）。
- 平台 `studentRuntime.js` 里"多于一节时让客户端选"的旧注释与本次口径冲突，已列为平台侧对齐项。

本地 E2E 矩阵（独立数据根 + localhost mock，`node .tmp/run-all-local-e2e.mjs`）：

| 场景                                            | 期望                                                     | 结果     |
| ----------------------------------------------- | -------------------------------------------------------- | -------- |
| 只有 1 节进行中课堂                             | 直接进入，无选择 UI                                      | 通过     |
| 2 节 ACTIVE（模拟脏数据）                       | 仍无选择 UI，使用平台默认那一节                          | 通过     |
| 老师还没开始上课                                | 展示"老师还没有开始上课"，不建工作区                     | 通过     |
| 当前是画布课堂                                  | 展示"当前是画布课堂，请在学生端进入画布课堂"，不建工作区 | 通过     |
| 主流程（流式 + 两轮工具 + 交作品含封面 + 预设） | 通过                                                     | 通过     |
| 额度 0 / 1 / 无限                               | 见上文额度表                                             | 3/3 通过 |

命令入口：

```text
node packages/desktop/tests/windows-classroom-entry.e2e.mjs single|two-active|not-started|canvas
pnpm smoke:platform:windows      # 主流程
pnpm smoke:platform:quota*       # 额度
```

## 平台回复（2026-09-29）后的补充验证

平台侧 7 条待办 + 更新清单 5 条 + 发送次数 5 条逐条核完，其中会影响客户端的四点已改并验证：

| 场景                                       | 期望                                                          | 命令                                                  |
| ------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------- |
| 平台不下发 `workspacePath`（生产事实）     | 回退到本机 `Documents/灵动ai创作/<学生>-<课时>`，并创建成功   | `windows-platform-contract.e2e.mjs no-workspace-path` |
| 账号在别处登录（401 `SESSION_SUPERSEDED`） | 登录窗展示平台 message "当前账号已在其他设备登录"，不进工作区 | `… session-superseded`                                |
| 提交响应直接带 `works`（未发版的新形状）   | 用响应里的 `works` 回显（mock 故意让列表接口返回 0 条以区分） | `… submit-includes-works`                             |
| `sends.limit=0`                            | 按平台口径视为**不限**（原实现会误判为"一次都不许发"）        | `… quota-flow.e2e.mjs limit-0`                        |

另外：mock 的 5 个客户端接口已改用平台真实包络 `{success,ok,data}` / 错误 `{error:{code,message}}`，
所以上面所有场景同时验证了客户端的解包逻辑。

E2E 全矩阵（11 项）由 `.tmp/run-all-local-e2e.mjs` 一次跑完，全部通过。

⚠️ 该 E2E 会在真实 `Documents/灵动ai创作` 下创建"联调学生-联调测试课堂"目录（生产回退路径所致），
脚本会在实例退出后删除；**若该目录在运行前已存在则一律不删**（同目录下有真实学生作业）。

### 仍待平台决定

- `MAX_HISTORY=40`（约 13 轮）静默截断：建议改为可配 + 在响应里给出截断标记；详见平台契约文档。
- "一次都不许发"的课堂状态：平台口径下 `0 = 不限`，无法表达；产品需要的话要先定口径。
- `submit-upload` 的 `works` 发版（发版前客户端自动回落，不影响功能）。

## Windows 已发布（0.2.0-zcode.2，2026-09-29）

版本从 `0.2.0-zcode.1` 升到 `0.2.0-zcode.2`（更新类 E2E 改为从 `package.json` 推导当前/下一版本，不再手工同步）。

本次只发布 Windows，发布命令使用 `deploy/publish-client.sh --single-platform`：跳过双端版本一致性检查，并从线上 manifest 删除 `mac-arm64` 条目，避免 Mac 继续暴露旧包。Windows 正式身份构建为 `ZCODE_ENV=production`、未签名（`ZCODE_ENABLE_WIN_SIGN=0`）：

```text
文件：lingdong-client-0.2.0-zcode.2-win-x64.exe
大小：149,767,958 字节（142.8 MiB，限制 500 MiB）
SHA256：68d88b3a6f5607a435eab88af5d90e474bb3aebbe2609635fd5a2734049be365
发布时间：2026-09-29T14:33:39Z
公网：https://aicyld.com/downloads/lingdong-client-0.2.0-zcode.2-win-x64.exe
```

| 验证                                                | 结果                                           |
| --------------------------------------------------- | ---------------------------------------------- |
| 最终发布二进制（win-unpacked）课堂全链路            | 通过                                           |
| 最终发布二进制生产更新路径（清单→下载→sha256 校验） | 通过                                           |
| 发布脚本远端字节数 / SHA256 核对                    | 通过                                           |
| 公网 manifest 与安装包 HEAD                         | 通过（200，Content-Length 149767958）          |
| 最终发布包 NSIS 静默安装 / 启动 / 静默卸载          | 通过；安装到独立目录，退出码 0，卸载后目录删除 |

**未验证**：从旧版本更新到本版本的"安装器实际替换"（需要两次完整出包 + 真机更新）。
electron-updater 的下载与校验已验证，替换动作属标准路径。

### 回滚基线（发布前线上清单，2026-09-29 21:2x）

```json
{
  "version": "0.1.7-rc.2.10",
  "files": {
    "win-x64": {
      "name": "lingdong-client-0.1.7-rc.2.10-win-x64.exe",
      "size": 429679192,
      "sha256": "fe639784042ada4543488d08046a961f98dfe058dfc86b4ab156e9fcab433d0b"
    },
    "mac-arm64": {
      "name": "lingdong-client-0.1.7-rc.2.10-mac-arm64.dmg",
      "size": 536242178,
      "sha256": "39e37e6382b0cb15eea5bca25bdf4b96918754dac141c9673a99c6f8bca8728e"
    }
  }
}
```

回滚方式：把 `manifest.json` 的两端 version/name/size/sha256 改回上表并原子写回（对应安装包仍在
`/srv/ai-kids-platform/downloads/`，发布脚本不会删除旧包）。

### 发布注意

- Windows-only 发布必须带 `--single-platform`；脚本会在同一原子写回中移除另一平台条目。
- 当前线上只保留 Windows 条目；Mac 端按本次口径暂缓，后续若要恢复需重新产出同版本包。
