# ZCode → 灵动ai 平台接口契约（客户端适配版，2026-09-28）

## 目标

ZCode 作为客户端底座，平台服务端继续保持现有账号、课堂、网关、发送次数和作品接口。客户端不再依赖 DSH 的 profile、Cordis、patchFiles 或 DSH 插件。

## 现有接口继续保留

| 方法 | 路径                                  | 用途                                             |
| ---- | ------------------------------------- | ------------------------------------------------ |
| POST | `/api/auth/login`                     | 平台账号登录，返回 `token` 和 `user`             |
| POST | `/api/auth/logout`                    | 注销当前平台账号                                 |
| GET  | `/api/student/runtime/client-context` | 当前课堂、网关、模型、预设、发送次数、课堂工作区 |
| POST | `/api/student/runtime/submit-upload`  | 上传/提交课堂作品                                |
| GET  | `/api/student/works?page=1&limit=20`  | 查询历史作品                                     |

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
    "baseUrl": "https://aicyld.com/api/gateway/v1",
    "key": "短期运行时凭据"
  },
  "models": [{ "id": "deepseek-flash", "displayName": "DeepSeek Flash" }],
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
2. `client-context.gateway.baseUrl` 是 `https://aicyld.com/api/gateway/v1`（**不含** `/chat/completions`）；客户端请求 `<baseUrl>/chat/completions`。⚠️ 契约早期示例里的 `/api/runtime-gateway` 平台不存在（404），一律以 `client-context` 下发值为准。
3. 网关兼容 ZCode 的标准 tool call 和流式 usage。
4. 补齐缓存 token 透传和每轮耗时日志。
5. 保持 401/403/`SESSION_SUPERSEDED` 与 429 错误码语义不变。
6. 在平台侧验证 ZCode 的一轮文本请求和至少两轮 tool call。
7. 不要让客户端依赖 DSH 的 session、profile、Cordis 或 `patchFiles` 字段。

## 变更策略

平台可以先按兼容层上线，不必立刻修改数据库结构。客户端底座替换不改变课堂、账号、账单、网关和作品的业务归属。

## 课堂规则：一个学生只有一个进行中的课堂（2026-09-29）

### 产品规则（权威口径）

**一个学生在同一时间只能存在 1 个进行中的课堂，客户端不存在任何"选课堂"逻辑。**

这 1 节课的形式由课时声明决定，可能是：

- 画布课堂
- VibeCoding 课堂
- **两种形式同时存在**（课时 `delivery_modes` 可声明多种，客户端按 VibeCoding 能力判定即可进入）

平台侧强制：`apps/server/src/services/classroomSessions.js` 的 `activeParticipationFor` 在
「候选人名单」与「把学生加进课堂」两条写路径都拦未终态占用（PENDING/ACTIVE），reason `IN_OTHER_SESSION`。

### 客户端行为

- 登录后直接 `GET /api/student/runtime/client-context`（**不传 `sessionId`**），用返回的 `classroom` 进入课堂。
- **不渲染任何课堂选择 UI**，不解析 `classrooms` 列表做选择，不保存待选课堂。
- 平台没有可进课堂时，把平台 `message` 原样展示给学生（下面契约表）。
- 交作品 / 刷新上下文同样不传 `sessionId`：平台按"唯一那节课"自行解析。

平台支持 `?sessionId=` 指定课堂，但**客户端不使用**该参数；它只保留给将来可能的多端场景。

### 服务端返回契约

| 情况                                 | 返回                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 有可进的 VibeCoding 课堂             | `classroom` 有值 + `gateway`/`presets`/`sends`                                                                                       |
| 课时同时声明画布 + VibeCoding        | 同上（按课时声明的 `delivery_modes` 判定，可进入）                                                                                   |
| 老师还没开始上课                     | `classroom:null`、`upcoming` 给出"接下来哪一节"、`message:"老师还没有开始上课"`、**不下发密钥**                                      |
| 当前是画布课堂                       | `classroom:null`/`classrooms:[]`/`upcoming:null`、`message:"当前是画布课堂，请在学生端进入画布课堂"`、**不带 gateway/presets/sends** |
| 点名的那节课已结束（客户端不再触发） | `reason:CLASSROOM_NOT_AVAILABLE`、`message:"你选的那节课已经结束了"`                                                                 |

### 与平台现有注释的差异（需平台侧对齐）

`apps/server/src/routes/studentRuntime.js` 目前仍保留一段注释，写着"多于一节时客户端让学自己选"，
理由是有绕过校验的历史脏数据（一个学生挂两场 ACTIVE）。按本次产品口径：

- 客户端**不实现选择**；若平台因脏数据返回多节，客户端使用平台默认给出的那一节，不做二次挑选。
- 平台侧应清掉这类脏数据并保证 `classrooms` 恒定 ≤1，然后同步删除该注释里的"让客户端选"要求。
- 在平台清理完成前，客户端行为是"跟随平台默认值"，可能与该注释的期望不一致——**以本口径为准**。

## 客户端的课堂能力边界（2026-09-29）

Renderer 不直接接触平台凭据，也不直接调用 preload 桥。课堂能力统一收敛为
`IPlatformService.classroom`（`IClassroomPlatformService`）：

| 方法                   | 用途               | 说明                                      |
| ---------------------- | ------------------ | ----------------------------------------- |
| `getPresets()`         | 当前课堂提示词预设 | 插入草稿，不自动发送                      |
| `scanWorkspaceFiles()` | 扫描课堂工作区候选 | 返回 path/relativePath/size/updatedAt     |
| `submitWork(payload)`  | 提交作品           | `copyrightConfirmed` 必须来自用户显式确认 |
| `listWorks()`          | 查询历史作品       | 提交后回显                                |

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

### 更新联动的平台侧要求（2026-09-29 客户端已验证）

客户端已用真实 `autoUpdater` + `ManifestUpdateProvider` 在本地清单上跑通「检出更新 → 下载 → sha256 校验 → 可安装」，并验证被篡改的安装包会被拒绝。平台侧需要保证：

1. `manifest.json` 里的 `files.<target>.name` 必须是 `downloads/` 下的真实文件名，安装包与清单同目录可直接 GET 下载。
2. `size` 与 `sha256` 必须与实际字节严格一致；客户端按 `sha256` 校验，不一致会直接失败且不会进入可安装状态。
3. `version` 必须递增且与安装包内版本一致，否则 `electron-updater` 会认为没有更新或反复提示。
4. 未配置强更时 `mandatory=false`、`minVersion=""`；客户端不会因此拦截启动（详见「平台强制更新门」）。
5. 发布必须原子：先上传两个平台的安装包，再一次性写回 `manifest.json`，避免用户拿到“新清单 + 旧安装包”。

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

| 场景                   | 网关请求            | 额度提示 |
| ---------------------- | ------------------- | -------- |
| `limit=0`              | 0（本地即拦）       | 显示     |
| `limit=1`              | 1（第二次本地拦截） | 显示     |
| `limit=null` 连发 3 次 | 3（不误判为 0）     | 不显示   |

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

## 平台侧回复核对（2026-09-29 版）

平台逐条核完 7 条待办 + 更新清单 5 条 + 发送次数 5 条，结论与客户端实现对照如下。

### 已确认一致（客户端无需改动）

| 项                                      | 平台结论                                                      | 客户端                                                               |
| --------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| 5 个接口路径                            | 不变，且加常驻守卫                                            | 一致                                                                 |
| `gateway.baseUrl`                       | `https://aicyld.com/api/gateway/v1`，不含 `/chat/completions` | 一致（SDK 自行拼 `/chat/completions`）                               |
| tool call + 流式 usage                  | 已支持并真请求验过                                            | 一致                                                                 |
| 缓存 token + 每轮耗时日志               | 已支持两套命名                                                | 一致                                                                 |
| 401/403/`SESSION_SUPERSEDED`/429        | `SESSION_SUPERSEDED`=401；超限=429                            | 客户端原样展示 `error.message`（已测）                               |
| 不依赖 DSH 字段                         | 响应无任何 DSH 字段                                           | 一致                                                                 |
| `classroom` / `models` / `presets` 形状 | `{id,lessonId,title}` / `{id,displayName}` / `[{title,text}]` | 一致（显示用 displayName，请求用 id）                                |
| 响应包络                                | 成功 `{success,ok,data}`，错误 `{error:{code,message}}`       | 客户端统一 `unwrap(data)` + 取 `error.message`（已用 mock 包络验证） |
| 作品上限                                | 60 文件 / 16 MiB / 24 MB body                                 | 与客户端默认一致                                                     |
| 封面失败不阻断                          | 只记 warnings                                                 | 客户端把封面当 best-effort                                           |

### 本次按平台回复做的客户端改动

1. **`sends.limit=0` 按"不限"处理**（平台口径：`null` 或正整数，后台"不填或填 0"都是不限）。
   原先客户端把 0 当"一次都不许发"，一旦平台把后台原始值透传下来会整节课误拦，已改为 `limit>0` 才是上限。
   ⚠️ 请平台确认：`sends.limit` 永远不下发 0（当前实现满足）。
2. **提交响应里的 `works`**：客户端优先用提交响应自带的 `works` 回显，缺省时回落 `GET /student/works`，
   因此**新版未发版前也能正常工作**，发版后自动少一次请求。
3. **平台不下发 `workspacePath`**：客户端回退到本机 `Documents/灵动ai创作/<学生>-<课时>`，已按生产事实验证。
4. **交作品不再依赖 `sessionId`**：平台不读 `sessionId`/`classroomId`（课堂由运行时密钥解出），客户端已停止下发 `sessionId`。

### 平台侧仍需定/改

1. **`limit=0` 与"一次都不许发"**：平台口径下 `0 = 不限`，无法表达"一次都不许发"。
   客户端目前也没有这个状态（老师要停发请用"结束课堂"）。若产品确实需要"零次课堂"，需先定口径。
2. **网关历史截断 `MAX_HISTORY=40`（约 13 轮）**：超出后早期上下文被丢弃。
   平台在 `/chat/completions` 响应头返回 `x-platform-history-dropped`（本轮被丢弃的消息条数，仅 >0 时返回）。
   **客户端只消费这一个字段**：`x-platform-history-limit`（保留上限）平台可以照旧发，但客户端不用它，也不必为它做兼容。
   客户端已接入：适配层取响应头 → v4 投影 `control.historyTruncation` → Renderer 一次性提示（见
   `docs/specs/zcode-platform-history-truncation-notice.md`）。
   备注：请求不经浏览器 CORS，无需 `expose-headers`；只需中间层透传这个头。
3. **`submit-upload` 的 `works` 待发版**：发版前客户端走 `GET /student/works` 回落，功能不受影响。

## 2026-09-30 安装包命名与历史截断标记

### 安装包命名（已定）

- 客户端**不校验**安装包文件名：更新器直接取 `files[<target>].name` 当下载路径，只校验 `version + name + sha256` 非空与 sha256 值，没有文件名正则。
- 但客户端统一采用**规范名**发布：`deploy/publish-client.sh` 接受带 `-unsigned` 的构建产物，上传前归一化为 `lingdong-client-<版本>-win-x64.exe` / `lingdong-client-<版本>-mac-arm64.dmg`。
- 因此平台上传口的严格正则**不需要放宽**（与平台「我们放宽正则 / 你们去后缀」中的「去后缀」一致）。

### 历史截断标记（平台已定，客户端已接入）

- 头名：`x-platform-history-dropped`（本轮被丢弃的消息条数，仅 >0 时返回）。`x-platform-history-limit` 平台可保留但客户端不消费。
- 客户端已接入：适配层状态事件携带响应头 → v4 投影 `control.historyTruncation` → Renderer 在校会话内一次性提示（不阻断发送）。
- 更正一处平台注释：平台原写「客户端读 `files[target].version ?? manifest.version`」，当前客户端**只读顶层 `version`**，忽略 `files[target].version`；要做每平台独立版本须先改客户端。

## 2026-09-29 UI 联动补充

客户端已直接消费以下字段，平台不需要新增接口，但必须保证字段语义和值稳定：

1. `POST /api/auth/login` 返回的 `data.user` 用于课堂底部“当前学生”显示：
   - 优先显示 `displayName`，缺省回退 `login`；
   - 官方 ZCode OAuth 账号不再用于课堂身份显示。
2. `client-context.models[]` 是学生可见模型名的唯一来源：
   - 请求仍使用 `id`；
   - UI 直接显示 `displayName`；为空时回退 `id`；
   - 不要把内部 Provider、渠道或网关名称拼到学生可见模型名中。
3. `client-context.sends` 用于发送按钮旁展示 `used/limit`：
   - UI 展示本机投影，登录时以平台 `used` 为基线；
   - `limit=null` 显示 `used/不限`；
   - 平台在课堂中重置用量时应同时重置/重新登录课堂，保证 `used` 语义单调。
4. 工作区历史不来自平台：客户端课堂模式只保留当前课堂工作区；平台只负责下发当前 `classroom` 和模型/额度，不提供历史项目选择。
5. 登录页与安装器品牌是客户端资源；平台不需要下发 HTML、Logo 或安装器配置。

平台仍需完成的前置事项：

- 发版 `submit-upload` 的 `works` 字段；客户端当前已有 `GET /student/works` 回落，不阻塞使用。
- ~~决定 `MAX_HISTORY=40` 是否可配并在截断时返回标记~~ → **已定并已接入**：响应头 `x-platform-history-dropped`，客户端在会话内一次性提示。
- 明确“本节课一次都不许发”的产品语义；当前平台口径 `0 = 不限`，无法表达零发送课堂。
- 用真实学生账号联调 `SESSION_SUPERSEDED`、`SEND_QUOTA_EXCEEDED`，并核对缓存 usage 与 `usage_records` / `compute_attempts`。
