# ZCode → 灵动ai 平台接口契约（客户端适配版，2026-09-28）

## 目标

ZCode 作为客户端底座，平台服务端继续保持现有账号、课堂、网关、发送次数和作品接口。客户端不再依赖 DSH 的 profile、Cordis、patchFiles 或 DSH 插件。

## 现有接口继续保留

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/login` | 平台账号登录，返回 `token` 和 `user` |
| POST | `/api/auth/logout` | 注销当前平台账号 |
| GET | `/api/student/runtime/client-context` | 当前课堂、网关、模型、预设、发送次数、课堂工作区 |
| POST | `/api/student/runtime/submit-upload` | 上传/提交课堂作品 |
| GET | `/api/student/works?page=1&limit=20` | 查询历史作品 |

接口响应可以是 `{ data: payload }` 或直接返回 payload；错误建议继续返回 `{ error: { code, message } }` 或 `{ message }`。

## `client-context` 建议字段

```json
{
  "classroom": {
    "id": "classroom-id",
    "lessonId": "lesson-id",
    "title": "课堂标题"
  },
  "gateway": {
    "baseUrl": "https://aicyld.com/api/runtime-gateway",
    "key": "短期运行时凭据"
  },
  "models": [
    { "id": "deepseek-flash", "displayName": "DeepSeek Flash" }
  ],
  "defaultModel": "deepseek-flash",
  "presets": [],
  "sends": { "limit": 20, "used": 0, "remaining": 20 },
  "workspacePath": "可选：平台指定的本机课堂目录"
}
```

客户端会把平台网关映射为 ZCode 的受管 Provider：

```text
providerId = lingdong-platform-gateway
api type   = openai-chat-completions
baseUrl    = client-context.gateway.baseUrl
apiKey     = client-context.gateway.key
```

课堂默认使用平台网关 Provider；该 Provider 的模型仅来自平台上下文。成人学生仍可使用 ZCode 自带 Provider 管理、个人外部 API Key 等能力，课堂注入不得覆盖个人配置。

## 网关请求契约

ZCode 第一阶段固定使用 OpenAI Chat Completions 兼容协议：

- `gateway.baseUrl` 是兼容 API 的基址（例如 `https://example.invalid/api/gateway/v1`）；SDK 请求 `POST <gateway.baseUrl>/chat/completions`，平台不得下发已包含 `/chat/completions` 的完整路径
- `Authorization: Bearer <gateway.key>`
- `Content-Type: application/json`
- 支持 `stream: true`
- 支持标准 `choices[].delta.content`
- 支持标准 tool call：`choices[].delta.tool_calls[]`
- 推荐支持 `stream_options: { "include_usage": true }`
- 非流式和流式结尾都应返回 usage（如果渠道支持）

客户端可能发送的字段：

- `model`
- `messages`
- `tools`
- `tool_choice`
- `temperature`
- `max_tokens` 或 `max_completion_tokens`
- `stream`
- `stream_options`

平台不能依赖 DSH 特有字段；ZCode 的消息和工具 schema 应按 OpenAI-compatible 契约处理。

## usage / 缓存字段

平台继续按现有账单口径写 `usage_records` / `compute_attempts`，同时建议向客户端透传：

- `prompt_tokens`
- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`
- `prompt_tokens_details.cached_tokens`
- `completion_tokens`
- `total_tokens`

平台内部日志继续记录：

- `provider / model / channelId`
- `time_to_first_token_ms`
- `total_upstream_ms`
- `retry_count`
- `errorCode`

## 发送次数

客户端会在 UI/命令入口做本地体验提示，但平台网关 429 或业务错误仍是最终门禁。平台建议保留当前 429 语义，并返回：

```json
{ "error": { "code": "SEND_QUOTA_EXCEEDED", "message": "本节课发送次数已用完" } }
```

如课堂次数变化，客户端重新请求 `client-context` 即可刷新显示。

## 作品提交

当前 `submit-upload` 接口继续兼容即可。建议支持：

- `sessionId`
- `classroomId`
- `files[]`，每项为 `{ name, content, binary }`；文本文件 `content` 为 UTF-8，二进制文件 `content` 为 base64
- `cover`（可选 PNG base64 或平台已有文件引用）
- `copyrightConfirmed`

客户端默认最多提交 60 个文件、总原始大小 16 MiB，JSON 请求上限约 24 MiB；平台应返回 `warnings` / `missing` / `works` 供客户端回显。

提交失败不能因可选封面失败而阻断正文作品上传。

## 平台侧待办

1. 保持以上 5 个账号/课堂/作品接口路径不变。
2. 确认 `client-context.gateway.baseUrl` 是可直接用于 OpenAI Chat Completions 的地址。
3. 网关兼容 ZCode 的标准 tool call 和流式 usage。
4. 补齐缓存 token 透传和每轮耗时日志。
5. 保持 401/403/`SESSION_SUPERSEDED` 与 429 错误码语义不变。
6. 在平台侧验证 ZCode 的一轮文本请求和至少两轮 tool call。
7. 不要让客户端依赖 DSH 的 session、profile、Cordis 或 `patchFiles` 字段。

## 变更策略

平台可以先按兼容层上线，不必立刻修改数据库结构。客户端底座替换不改变课堂、账号、账单、网关和作品的业务归属。

## 客户端的课堂能力边界（2026-09-29）

Renderer 不直接接触平台凭据，也不直接调用 preload 桥。课堂能力统一收敛为
`IPlatformService.classroom`（`IClassroomPlatformService`）：

| 方法 | 用途 | 说明 |
|---|---|---|
| `getPresets()` | 当前课堂提示词预设 | 插入草稿，不自动发送 |
| `scanWorkspaceFiles()` | 扫描课堂工作区候选 | 返回 path/relativePath/size/updatedAt |
| `submitWork(payload)` | 提交作品 | `copyrightConfirmed` 必须来自用户显式确认 |
| `listWorks()` | 查询历史作品 | 提交后回显 |

约束：

1. 平台 token、运行时网关 key、发送次数投影只存在于宿主进程；Renderer 只能通过上述方法读写课堂事实。
2. `window.lingdong` 只允许在 Desktop 的 `IPlatformService` 适配层出现；UI 组件必须走 `usePlatform()`。
3. Web/手机不提供该能力，消费方按缺省处理并给出明确提示，不得静默失败。
4. 封面采集失败不得阻断正文提交。

## ZCode 课堂工作台状态与交作品所有权（2026-09-28）

### 所有者

- 登录会话、课堂上下文、运行时网关凭据：`packages/desktop/src/main/lingdongPlatformGate.ts`（Electron Main 单一所有者）。
- 当前课堂工作区：平台上下文初始化后由 `startupWorkspace` 启动参数与 ZCode workspace/session store 共同消费；Main 只注入 canonical path/identity，不复制任务状态。
- 发送次数：`packages/services/src/zcode-agent/lingdongQuotaLedger.ts` 在 Service 的实际命令入口（V4 `sendText`、`createSession.firstInput`、附件兼容 `session/send`）预留与结算，按 workspace identity + sessionId + commandId 幂等；UI 不作为最终事实来源，平台 sends / 网关 429 仍是最终门禁。
- 作品候选：renderer 读取当前 workspace 文件服务得到派生候选；提交命令只经过 `window.lingdong.submitWork` 回 Main，由 Main 使用平台 token 调用 `submit-upload`。

### 事件顺序

```text
登录成功
  → 拉取 client-context
  → 生成平台 Provider 临时配置
  → 计算 classroom workspace identity
  → 启动 ZCode Host
  → UI 读取 platform snapshot
  → 文件服务扫描候选
  → 用户确认作品
  → Main submit-upload
  → 刷新 GET /student/works
```

### 不变量

1. renderer 不持有平台 token。
2. 平台 Provider 合并至 Personal Config；正常退出只清除本会话的平台条目，不删除文件或学生自配 Provider。
3. 工作区 identity 必须包含账号和课堂，不能只按物理路径去重。
4. 作品提交的可选封面失败不得阻断正文提交。
5. 发送次数只能在 Agent 真实发送入口消费一次，重试/工具轮不重复消费。
6. 平台响应允许 `{data: payload}` 和直接 payload 两种包装。

### 迁移边界

不得重新引入 DSH session、Cordis patch、DSH profile、DSH plugin 或 DSH 文件地址协议。ZCode 的 Host/Service/Provider/UI 是唯一实现边界。

## 客户端更新清单

ZCode Desktop 不使用 ZCode 官方更新源，生产包固定读取：

```text
https://aicyld.com/downloads/manifest.json
```

清单当前格式：

```json
{
  "version": "0.2.0-zcode.1",
  "files": {
    "win-x64": {
      "version": "0.2.0-zcode.1",
      "name": "lingdong-client-0.2.0-zcode.1-win-x64.exe",
      "size": 0,
      "sha256": "..."
    },
    "mac-arm64": {
      "version": "0.2.0-zcode.1",
      "name": "lingdong-client-0.2.0-zcode.1-mac-arm64.dmg",
      "size": 0,
      "sha256": "..."
    }
  }
}
```

ZCode 的更新 Provider 会按当前平台选择 `win-x64` / `mac-arm64`，把 `sha256` 映射为 electron-updater 的 SHA-256 校验字段，下载路径相对 `https://aicyld.com/downloads/` 解析。平台清单的双端版本仍必须保持一致。

## Windows Provider 注入与启动门（2026-09-29）

### 设计边界

- ZCode 官方 `resources/config/provider/zcode-builtin.json` 仍是内置基线，不写入课堂网关凭据，也不被平台上下文替换。
- 平台下发的 `gateway.baseUrl`、`gateway.key` 和模型列表属于当前平台会话事实，由 Electron Main 单一所有者写入 ZCode Personal Provider Config：
  - Windows 路径：`<ZCODE_DATA_BASE_DIR>/.zcode/v2/provider_config.json`
  - Provider：`lingdong-platform-gateway`
  - `group`：`standard-personal`
  - `api.type`：`openai-chat-completions`
  - `modelConfigRules.providerModelRules`：只声明平台下发的模型 ID
  - `manualProviderModelRules`：空数组
- 登录 token 只用于平台账号接口；Provider 的 `apiKey` 只使用 `client-context.gateway.key`，两者禁止互换。
- 平台网关 Provider 由 Personal 层覆盖，不进入 ZCode Built-in Active/LKG/远端刷新链路；课堂切换必须原子重写同一份 Personal Config，并刷新 Host 配置服务。

### 唯一所有者与事件顺序

```text
登录窗
  → Main 登录平台并拉取 client-context
  → Main 校验 gateway + models
  → Main 原子写入 provider_config.json
  → Host 读取 Built-in 基线 + Personal Provider
  → Main 创建主窗口
  → 主窗口就绪后关闭登录窗并解除启动门
```

不变量：

1. Renderer 不持有平台 token 或 gateway key。
2. Personal Provider Config 无效时不能静默把平台模型当作 Built-in；Host 必须显式记录配置恢复告警，客户端显示“模型配置加载失败”。
3. 登录窗不是主窗口，窗口协调器不得复用登录窗；登录窗关闭表示取消启动，不能产生未处理 Promise 拒绝。
4. 登录成功到主窗口就绪期间保持启动门，避免 Windows `window-all-closed` 提前退出。
5. 正常退出移除本会话的平台条目；课堂切换/刷新由 Main 调用配置仓库更新，个人 Provider 管理仍由现有服务负责。

### 平台强制更新门

客户端启动强更只读取：

```text
${LINGDONG_API_BASE:-https://aicyld.com}/downloads/manifest.json
```

读取 `enabled`、`mandatory`、`minVersion` 和 `version`：

- `enabled=false`：不拦启动。
- `minVersion` 非空：当前客户端低于该版本时拦启动。
- `mandatory=true` 且 `minVersion` 为空：以清单顶层 `version` 为最低版本。
- 其他情况：不拦启动。

不能读取 ZCode 官方 `/api/v1/client/configs` 的 `forceUpdate.minimalVersion`，因为官方版本号（3.x）与灵动ai客户端版本号（0.x）不属于同一发布序列，会误拦所有客户端。

### Personal 配置保留与退出清理补充

- 成人学生可继续使用 ZCode 的普通 Provider、外部 API Key、插件、MCP 和远程能力；平台 Provider 是默认课堂入口，不是唯一允许的 Provider。
- 同一个 `provider_config.json` 也包含学生自配 Provider。课堂注入必须复用 `NodePersonalProviderConfigRepository.update()`，在锁内只合并保留 ID `lingdong-platform-gateway`，禁止覆盖或删除其他项。
- 刷新只更换平台 Provider 的模型/密钥，保留学生切换到外部 Provider 的默认选择。退出只移除本会话写入的平台条目，若该条目已被更晚会话更换密钥，旧会话清理不得触碰它。
- 保存前使用公开 `decodeProviderConfigFile()` 校验 Personal schema；坏文件应保留原样并阻止课堂启动，不能静默覆盖恢复为空。
- 启动必须先解析设置中的数据根，再写 Personal Config，再创建 Host；Main 和 Host 必须读取同一个配置根。
- 退出清理进入现有 `prepareAppQuit` 屏障，不在 `will-quit` 中发出无人等待的异步文件操作。

```text
Main（课堂上下文单一 owner）
  → 配置仓库 update 锁 / schema 校验 / 原子提交
  → Host Personal Config polling（磁盘派生视图）
  → 既有 Provider Registry / Agent（Desktop 连续流；手机恢复链路不变）
退出：Host 停止 → Main 按本会话密钥比对后移除平台条目 → 完成退出屏障
```

回归验收：正确 schema 可解码；已有自配 Provider 保留；平台默认模型可选；密钥/模型刷新；用户改选外部模型后刷新不覆盖；坏配置原样保留；旧会话清理不删除新条目；退出不删除个人配置文件。

Windows 品牌验收：桌面主窗口 HTML 标题必须为“灵动ai创作客户端”，避免 Electron 主窗口仍显示底座产品名。

### Windows 首屏账号引导（2026-09-29）

- Main 已完成平台登录且 Registry 发布了可用模型后，Root 直接进入课堂工作区，不再强制要求选择底座的厂商账号体系。
- Root 的既有 ModelSelectionView 是“Provider 可用性”的唯一来源；不得把平台账号伪装成 OAuth 用户，不再新增登录状态镜像。
- 拥有可用 Personal Provider（平台或学生自行配置）时，缺少 `providerFamilyDomain` 不应阻断启动。
- 无可用模型且无完整底座登录状态时，仍保留账号/API Key 引导；用户主动打开厂商账号连接仍按既有流程处理。
- 验收：平台 Provider 可用、无 OAuth 用户、无 family 时不打开启动登录页；空 Registry 仍打开；显式手动登录不受本次启动条件改变影响。

## 课堂发送次数 V4 admission 与本机投影（2026-09-29）

### 产品规则与所有权

- 平台的 sends / 网关 429 / 账单仍是最终权威。服务层持有本机课堂额度投影，只用于提前提示；不修改平台账单接口。
- 本机同账号同课堂的多个 Window Host 共用一个锁定投影文件（配置目录 `runtime/lingdong-quota/<identity-hash>.json`），避免每个进程独立计数。
- `sendText`、带 firstInput 的会话创建和附件兼容 `session/send` 进入统一 admission 包装；空会话预热、工具回合、workspaceGenerateText（内部标题等）不扣课堂发送次数。
- 只限制 `lingdong-platform-gateway` Provider。学生自带 API Key/外部 Provider 不消耗平台课堂投影。
- 幂等键由 workspace identity（本地 path fallback）、sessionId 和 commandId/inputId 组成；Desktop continuous 与 mobile replayable 复用同一 Host/键，原有 owner/lease/stale-run 裁决不改变。
- limit 缺省、null、空串或非法值表示无限；只有显式 0 才表示没有可用次数。

### 事件顺序与失败语义

```text
Main 登录/上下文刷新 → 服务层投影初始化/同步（文件锁 + 原子写）
用户命令 → Service 实际入口 → 预留一次额度
  → 既有 CLI CommandInbox admission
  → accepted：确认；已计数 duplicate：不再计数
  → rejected/stale/noop/failed：释放本次新预留
  → transport/ACK 丢失：保留不确定预留，相同 commandId 重放不重复扣减
工具调用与模型重试 → 仍属于该命令，不进入新的发送计数
Renderer → 平台 adapter 只读取投影，不自行维护计数
```

上下文刷新更新 limit 并将 used 向平台已用量收敛，不因为较旧服务端响应降低本机已接受的计数。新课堂使用新的 identity 桶；新登录在 Host 启动前以平台 used 建立新基线。

Windows 已验证（独立测试数据根 + localhost mock，2026-09-29）：

| 场景 | 网关请求 | 额度提示 |
|---|---|---|
| `limit=0` | 0（本地即拦） | 显示 |
| `limit=1` | 1（第二次本地拦截） | 显示 |
| `limit=null` 连发 3 次 | 3（不误判为 0） | 不显示 |

补充事实：同一轮含 2 次工具往返回合时会话共产生 4 次网关流式请求，账本 `used` 仍为 2，证明工具回合与模型重试不重复扣减。

### 验收场景

1. limit 空/null/缺省不拦截；limit=0 立即给出 SEND_QUOTA_EXCEEDED。
2. Desktop V4 sendText、createSession.firstInput、附件兼容入口各计一次。
3. 同 commandId 重放、两轮工具调用不重复计数。
4. 两个 ledger 实例并发争最后一次额度，只允许一个新命令。
5. 被 CLI 明确拒绝时释放新预留；ACK 不确定时相同 ID 可重试但不增加 used。
6. 平台 used/limit 刷新可观察；不同 classroom identity 不串额度。
7. 外部 Provider/内部生成/空预热会话不消耗平台投影。

## 平台侧仍需确认（发送次数，2026-09-29）

客户端已按上面的本机投影拦截，但**平台侧计费口径仍需联调确认**：

1. 平台 `enforceVibecodingSendLimit` 以“消息里看起来像学生发的条数”为判据、按请求 +1。请与客户端“一次用户提交 = 一次”对齐，避免客户端放行而平台判超。
2. 客户端工具回合会多次请求网关，平台不得因此重复计数（当前平台实现按 `looksLikeFreshSend` 处理，需真实联调确认）。
3. 客户端本地 `limit=null` 视为不限；平台 `sends.limit` 为 `null`/`undefined`/空串/`""` 时都必须表达“不限”，不要下发 `0` 表示不限。
4. 额度耗尽后平台返回 429 + `error.code=SEND_QUOTA_EXCEEDED`；客户端已能显示专用提示，请在真实课堂验证一次。
5. `client-context.sends.used` 用于登录基线；平台若在课堂中重置用量，请保持 `used` 单调或配合客户端重新登录，避免本机投影与平台账目长期背离。
