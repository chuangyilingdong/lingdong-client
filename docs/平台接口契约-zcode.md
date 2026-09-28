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

客户端不再使用 Z.ai、BigModel 或其他内置 Provider；平台下发的模型列表是唯一模型列表来源。

## 网关请求契约

ZCode 第一阶段固定使用 OpenAI Chat Completions 兼容协议：

- `POST <gateway.baseUrl>`
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
- `files[]`
- `cover`（可选 PNG base64 或平台已有文件引用）
- `copyrightConfirmed`

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

## ZCode 课堂工作台状态与交作品所有权（2026-09-28）

### 所有者

- 登录会话、课堂上下文、运行时网关凭据：`packages/desktop/src/main/lingdongPlatformGate.ts`（Electron Main 单一所有者）。
- 当前课堂工作区：平台上下文初始化后由 `startupWorkspace` 启动参数与 ZCode workspace/session store 共同消费；Main 只注入 canonical path/identity，不复制任务状态。
- 发送次数：`packages/services/src/zcode-agent/lingdongQuota.ts` 在 Agent prompt admission 处消费；UI 不作为最终事实来源，平台 429 仍是最终门禁。
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
2. Provider 配置只在进程临时目录生成，退出时删除。
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
