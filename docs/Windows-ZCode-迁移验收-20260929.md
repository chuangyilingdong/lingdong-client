# Windows ZCode 迁移阶段验收（2026-09-29）

## 范围与结论

本轮只推进 Windows；没有发布，没有修改学习平台仓库，不处理 Mac。**迁移尚未整体完成**。

本轮修复：

1. 平台 Provider 从不合法的 Built-in release 改为合法的 Personal Config，并复用公开 codec 与配置仓库。
2. 只合并/清理平台 Provider，保留学生自配 Provider 与个人默认选择；坏配置不覆盖，旧会话不移除较新密钥。
3. Main 先解析数据根再写课堂配置，Host 读取同一路径。
4. 登录窗口不是主窗口，启动门保护零窗口过渡；退出清理进入现有 Host shutdown 屏障。
5. 有可用课堂/个人模型时，不因缺少厂商 family 而再次要求 OAuth 登录。
6. 桌面主窗口标题改为“灵动ai创作客户端”。

## 已执行验证

| 验证 | 结果 | 边界 |
|---|---|---|
| `pnpm typecheck` | 通过 | 当前源码 |
| `pnpm lint` | 通过，68 warnings / 0 errors | 警告为当前仓库已有项 |
| `pnpm architecture:check --changed` | 通过，0 violations | baseline / new 均为 0 |
| `pnpm test:platform` | 9 / 9 通过 | 配置 codec / Runtime + 启动登录条件 |
| `pnpm smoke:platform` | 通过 | mock 接口合同，不是实际模型运行 |
| Desktop `build:no-runtime-assets` | 通过 | 源码产物；UI 后续单独重建也通过 |
| `pnpm smoke:platform:windows` | 通过 | 本机 Electron + 独立测试数据目录 + localhost mock |
| 正常退出 | 通过 | Host/Agent 退出，个人配置文件保留，平台条目已移除 |

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
- 本地 mock：`node packages/desktop/tests/mock-platform.mjs`
- 已启动的独立 Windows Electron 测试实例：`pnpm smoke:platform:windows`
- E2E 默认 CDP `http://127.0.0.1:9229`、mock `http://127.0.0.1:19090`，仅允许 localhost 地址；可用 `LINGDONG_E2E_CDP` / `LINGDONG_E2E_MOCK` 指定。
- 测试实例必须隔离 `HOME`、`ZCODE_DESKTOP_HOME_DIR`、`ZCODE_DATA_BASE_DIR`、`ZCODE_DESKTOP_USER_DATA_DIR`，并设置 `LINGDONG_API_BASE` 为 mock 地址。不要用日常真实账号或个人配置目录运行测试。
- 当前开发 Electron 依赖缺少可执行文件，本次使用本地 Electron 41.0.3 缓存解压的运行时，没有重新安装依赖。Node 实际为 24.19.0，`mise.toml` 固定值为 24.14.0，最终 CI/发布应按固定版本再验收。

## 必须继续完成的项

### 发送次数（已确认缺口）

当前 `consumeLingdongSend()` 只挂在 `zcodeTaskServiceAdapter.sendPromptToAgent()`，本次 UI 正常发送实际走 `zcodeAgentService.sendConversationCommandV4()`。因此新 V4 主路径未经过现有客户端计数逻辑。

后续应在实际命令 admission 边界覆盖 V4 及带附件兼容路径，并以 commandId/inputId 去重；重试和 tool call 不能再扣一次。还要修正缺省 limit 被 `Number("")` 解释为 0 的情况，验证额度耗尽、平台 429、课堂刷新和 Desktop/mobile 两种交付语义。平台仍是额度和账单的最终权威。

### 平台与 UI 边界

- 真实平台账号/多课堂切换、401/403/SESSION_SUPERSEDED、额度耗尽。
- 真实平台的流式 usage / 缓存 token / compute_attempts 与 usage_records 对账。
- 课堂预设/交作品 UI 仍有旧适配的直接 `window.lingdong` 调用，应按当前 AGENTS 约定收口至 hook 与 IPlatformService；不能只为 Desktop 绕过跨端合同。
- 平台身份展示、退出/切号全流程、启动更新在正式安装包中的验证。

### 安装包状态

本轮运行验收使用的是最新源码产物，不是最终安装包。

`dist/win-x64` 与 `.tmp/verify-win` 中现有同版本 EXE 早于后续 Provider/首屏修复，**不是可发布候选**，不可复用或直接发给学生。所有本地代码验收完成后应从最终提交重新构建 Windows 包，采集 size/SHA256，验证安装和更新，再等用户单独确认发布。

Mac 暂不推进。现有发布脚本仍有双端版本一致性约束；Windows-only 发布策略留待发布前确认，不能为了绕过脚本直接改线上清单。
