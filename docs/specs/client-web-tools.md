# 客户端 WebSearch / WebFetch 能力

- 状态：客户端已实现，平台已确认（2026-10-18）
- 范围：`packages/desktop`、`apps/zcode-cli/packages/core`、`apps/zcode-cli/packages/bootstrap`、`apps/zcode-cli/packages/contracts`
- 平台依赖：复用已有 `POST /api/gateway/v1/search/messages`

## 1. 目标

课堂模型当前使用 `openai-chat-completions`，模型能力位 `supportsNativeWebSearch=false`，因此客户端不会向模型暴露 `WebSearch`。本 spec 定义一条**客户端搜索后端**路径，使课堂模型在不切换 Provider 协议的前提下具备：

1. `WebSearch`：输入查询，返回网页结果、来源链接、摘要与用量。
2. `WebFetch`：输入 URL，抓取公开网页并转为 Markdown（已有能力，本次只做回归与权限确认）。

## 2. 非目标

- 不改变 Anthropic 等原生 Provider 的 `WebSearch` 行为。
- 不新建平台搜索接口；复用平台现有的 `/api/gateway/v1/search/messages`。
- 不在 v1 做客户端搜索缓存、跨会话搜索历史或搜索配额账本。
- 不在 v1 自动放行 `WebFetch`；保留现有 medium-risk 权限确认。

## 3. 能力矩阵

| 模型/场景                               | WebSearch                           | WebFetch               |
| --------------------------------------- | ----------------------------------- | ---------------------- |
| 课堂模型（`lingdong-platform-gateway`） | 通过 `WebSearchPort` 调平台搜索网关 | 已注册，按现有权限确认 |
| 原生支持 web search 的 Provider         | 保持原有 provider-native 路径       | 已注册                 |
| 其他个人 Provider                       | 不暴露 `WebSearch`（除非原生支持）  | 已注册                 |

## 4. 状态所有权

- `AgentRuntime`：唯一决定当前模型可见工具集合。
- `WebSearchPort`：唯一负责客户端搜索网络 I/O 的端口；实现方为 bootstrap 的平台适配器。
- 平台搜索网关：唯一负责运行时密钥校验、课堂门禁、搜索渠道选择、上游转发与用量记账。
- `websearch.ts`：唯一负责把平台响应归一化为 `WebSearchOutput`。
- 客户端不保存搜索结果的第二份事实；v1 不做本地缓存。

## 5. 事件顺序

```text
模型发出 tool_call(WebSearch)
  -> 权限服务：readOnly + low risk + needsApproval=false => allow
  -> websearch handler:
       若 model.supportsNativeWebSearch => 原有 provider-native 路径
       否则若 webSearchPort.supportsModel(model) => 调平台搜索网关
  -> WebSearchPort 从当前 Provider Registry 读取课堂运行时 key
  -> POST {gateway.searchUrl ?? gateway.baseUrl + "/search/messages"}（Anthropic Messages 方言）
  -> 平台校验 key + 课堂 ACTIVE + 学生名单
  -> 平台选择搜索渠道/模型，转发 web_search 工具请求
  -> 平台返回 content[] + usage
  -> WebSearchPort 提取 text / web_search_result / web_search_requests
  -> handler 返回 WebSearchOutput
  -> 模型基于结果回答并引用来源
```

失败路径：401 -> 提示运行时密钥过期；429 -> 提示搜索频率过高；5xx/超时 -> 提示搜索服务暂不可用；空结果 -> 成功返回空结果。

## 6. 接口

### 6.1 Core 端口

```ts
export interface WebSearchPortRequest {
  input: WebSearchInput;
  model: Model;
  sessionId: SessionId;
  traceContext?: TraceContext;
  abortSignal: AbortSignal;
}

export interface WebSearchPortResult {
  results: WebSearchResultItem[];
  sources: WebSearchSource[];
  summary?: string;
  webSearchRequests?: number;
  modelUsage?: ModelUsage;
}

export interface WebSearchPort {
  supportsModel(model: Model): boolean;
  search(request: WebSearchPortRequest): Promise<WebSearchPortResult>;
}
```

### 6.2 可见性规则

```ts
model.properties.supportsNativeWebSearch || webSearchPort?.supportsModel(model) === true;
```

`supportsModel` 只对 `LINGDONG_PLATFORM_PROVIDER_ID` 返回 `true`，避免个人 Provider 误走课堂网关。

平台下发 `features.webSearch=false` 时，Host 不创建 `WebSearchPort`，工具因此不会出现在模型可见工具列表中；备课模式、未开课、画布课堂都属于这一类。

### 6.3 平台请求

```http
POST {gateway.baseUrl}/search/messages
x-api-key: <runtime key>
authorization: Bearer <runtime key>
anthropic-version: 2023-06-01
content-type: application/json
```

```json
{
  "max_tokens": 4096,
  "messages": [{ "role": "user", "content": "<query>" }],
  "tools": [
    {
      "type": "web_search_20260209",
      "name": "web_search",
      "max_uses": 8,
      "allowed_domains": ["example.com"],
      "blocked_domains": []
    }
  ]
}
```

说明：不传 `model`，由平台 `searchChannelSelection` 选择已配置的搜索模型。若平台要求必须传，客户端再补当前课堂模型 ID。

响应中的 `web_search_result.page_age` 可能为 `null`（DeepSeek 当前不给），客户端只依赖 `url` / `title`，不用它判断新旧；`encrypted_content` 等未声明字段直接忽略。

### 6.4 Host 环境与平台能力

- `PLATFORM_SEARCH_URL`：平台下发的完整搜索地址，优先使用；为空时回退到 `PLATFORM_GATEWAY_BASE_URL + "/search/messages"`。
- `PLATFORM_WEB_SEARCH_ENABLED`：`"1"` 才创建 `WebSearchPort`；`"0"` 时工具隐藏。
- `max_tokens` 固定 4096（平台下限 1024）；`max_uses` 默认 8，上限 10。

## 7. 超时、重试与取消

- 客户端工具超时：90 秒；HTTP 请求超时：85 秒（平台 80 秒返回 `RUNTIME_SEARCH_TIMEOUT`，留 5 秒余量）。
- 取消：跟随 tool call 的 `AbortSignal`。
- 按平台 `error.code` 分流，不只看 HTTP 状态：
  - `401` + `RUNTIME_KEY_EXPIRED` / `RUNTIME_KEY_INVALID`：等待 500ms 重读 Registry key，若已轮换则重试 1 次。
  - `429` / `UPSTREAM_RATE_LIMITED`：1 秒、2 秒退避，最多重试 2 次。
  - `504` / `RUNTIME_SEARCH_TIMEOUT`、`502` / `RUNTIME_SEARCH_UPSTREAM_UNREACHABLE`、`UPSTREAM_UNAVAILABLE`：提示“搜索暂不可用”，不连续重试。
  - `403` 课堂结束/学生移出/外发被禁：直接提示，不重试。
  - `UPSTREAM_AUTH`：平台渠道配置问题，不重试。
  - `400` 请求形状错误：提示更新客户端，不重试。
- 缓存：v1 不缓存；平台/上游可自行缓存。

## 8. 权限

- `WebSearch`：`readOnly=true`、`riskLevel=low`、`needsApproval=false`，自动放行。
- `WebFetch`：保持 `needsApproval=true`、`riskLevel=medium`，未知域名需用户确认；预批文档域名继续自动放行。
- `WebFetch` 的 SSRF 防护保持不变：localhost、私网 IP、非公开地址拒绝。

## 9. 验收场景

1. 课堂模型工具列表包含 `WebSearch` 与 `WebFetch`。
2. 提问“查一下 2026 年最新 X”时出现 `WebSearch` tool call，返回结果含 URL，最终回答引用来源。
3. 提问“总结 https://example.com”时出现 `WebFetch`，返回页面内容。
4. 个人 Provider 不出现客户端 `WebSearch`（除非原生支持）。
5. 课堂运行超过运行时 key TTL 后，搜索仍能用当前 key 成功。
6. 平台搜索网关返回 404/未配置时，客户端给出可读错误且不崩溃。
7. 平台返回 401/429/5xx 时，错误可恢复且不挂起。
8. `WebFetch` 对 localhost/私网地址仍然拒绝。
9. `features.webSearch=false` 时 `WebSearch` 不出现（备课/未开课/画布课堂）。
10. `page_age: null`、`encrypted_content` 存在时结果仍能正常渲染，且不依赖 `page_age` 判断新旧。
11. `UPSTREAM_RATE_LIMITED` 触发 1 秒/2 秒退避，最多重试 2 次；`UPSTREAM_AUTH` 和课堂 403 不重试。

## 10. 发布与回滚

- 仅当 `PLATFORM_WEB_SEARCH_ENABLED=1` 且 `PLATFORM_SEARCH_URL` 或 `PLATFORM_GATEWAY_BASE_URL` 存在时创建 `WebSearchPort`；`features.webSearch=false` 时工具隐藏。
- 平台搜索网关先确认可用，再发布客户端。
- 若平台网关不可用，客户端回退为“无 WebSearch”，不影响模型聊天与 `WebFetch`。
