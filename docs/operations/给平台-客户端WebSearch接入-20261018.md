# 客户端 WebSearch 接入平台搜索网关

- 日期：2026-10-18
- 客户端版本：0.2.9 之后的下一个版本
- 关联客户端 spec：`docs/specs/client-web-tools.md`

## 0. 平台确认结果（2026-10-18）

平台已确认 8 项，搜索网关已就绪：生产 TEXT 渠道为 DeepSeek `deepseek-flash`，实测能返回 10 条真实结果，典型耗时 2.4–9 秒；`web_search_20260209` / `web_search_20250305` 均可用；`page_age` 字段存在但恒为 `null`；错误体统一为 Anthropic 形并新增稳定 `error.code`；`client-context` 已下发 `gateway.searchUrl` 与 `features.webSearch`。

客户端按平台回复实施：

1. 优先使用 `gateway.searchUrl`，缺失时回退 `baseUrl + '/search/messages'`。
2. `features.webSearch=false` 时隐藏 `WebSearch`（备课、未开课、画布课堂）。
3. 按 `error.code` 分流：key 过期重试一次、限流退避两次、超时/上游不可用不连续重试、课堂 403 直接提示。
4. 结果只依赖 `url/title`；`page_age` 为 `null` 时不参与新旧判断，`encrypted_content` 忽略。
5. 搜索工具运行中 UI 已显示“正在搜索”，无需额外 3 秒提示。

## 1. 结论

客户端不再要求平台新增“搜索接口”。我们确认平台已经有：

```text
POST /api/gateway/v1/search/messages
```

客户端会直接复用这条 Anthropic Messages 透传网关，作为课堂模型的 `WebSearch` 后端。平台只需要确认/补齐下面 8 项，不需要重写搜索链路。

## 2. 客户端请求契约

### 2.1 地址

```text
{gateway.baseUrl}/search/messages
```

当前 `client-context.gateway.baseUrl` 为 `https://<平台域名>/api/gateway/v1`，因此完整地址是：

```text
https://<平台域名>/api/gateway/v1/search/messages
```

### 2.2 鉴权

客户端会同时带：

```http
x-api-key: <runtime key>
authorization: Bearer <runtime key>
```

`runtime key` 就是 `client-context.gateway.key` 下发的课堂运行时密钥，与聊天网关同一把。

客户端在收到 401 后会等待 500ms 重读当前 Provider key；若 key 已轮换则自动重试一次。平台只需保证 `client-context` 继续按现有节奏下发新 key。

### 2.3 请求体

```json
{
  "max_tokens": 4096,
  "messages": [
    {
      "role": "user",
      "content": "2026 年 React 最新版本"
    }
  ],
  "tools": [
    {
      "type": "web_search_20260209",
      "name": "web_search",
      "max_uses": 8
    }
  ]
}
```

说明：

- **不传 `model`**。请平台按 `searchChannelSelection(policy, '')` 使用已配置的搜索模型；如果必须传 `model`，请告知我们字段取值。
- `allowed_domains` / `blocked_domains` 只在模型显式传入时出现，平台现有 `searchTools` 会原样透传。
- 强制 `stream: false`；客户端不接受流式搜索响应。
- 客户端工具超时为 **90 秒**，其中 HTTP 请求超时 **85 秒**。平台当前 `RUNTIME_SEARCH_TIMEOUT_MS` 上限为 240 秒，请确认实际搜索能在 85 秒内返回；如果经常超过，请告知我们调整。

## 3. 客户端期望的响应

请保持 Anthropic Messages 原生响应，不要套 `{success,data}` 信封：

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "server_tool_use",
      "id": "srvtoolu_xxx",
      "name": "web_search",
      "input": { "query": "..." }
    },
    {
      "type": "web_search_tool_result",
      "tool_use_id": "srvtoolu_xxx",
      "content": [
        {
          "type": "web_search_result",
          "title": "页面标题",
          "url": "https://example.com/page",
          "page_age": "2 days ago"
        }
      ]
    },
    {
      "type": "text",
      "text": "搜索摘要…… [来源](https://example.com/page)"
    }
  ],
  "usage": {
    "input_tokens": 100,
    "output_tokens": 200,
    "server_tool_use": {
      "web_search_requests": 1
    }
  }
}
```

客户端会读取：

- `content[].type === "text"`：拼成摘要；
- `content[].type === "web_search_tool_result"`：读取 `content[]` 里的 `url`、`title`、`page_age`；
- `content[].type === "server_tool_use"`：统计搜索次数；
- `usage.server_tool_use.web_search_requests`：写入 `WebSearchOutput.webSearchRequests`；
- `usage.input_tokens` / `usage.output_tokens`：写入 `modelUsage`。

**最小要求**：`web_search_tool_result.content[]` 必须包含 `url`；`title`、`page_age` 可选。没有 `web_search_tool_result` 时，客户端仍可用 `text` 中的 Markdown 链接兜底提取来源。

## 4. 平台需要确认/补齐的 8 项

1. **端点可用**
   - 确认 `/api/gateway/v1/search/messages` 对课堂运行时 key 开放。
   - 确认 `gateway.baseUrl + "/search/messages"` 就是最终地址；如果路径不同，请给出准确路径。

2. **鉴权**
   - 确认 `x-api-key` 和 `Authorization: Bearer` 两种形式都接受。
   - 确认过期 key 返回 401，并带 `RUNTIME_KEY_EXPIRED` 或等价错误码。

3. **课堂门禁**
   - 确认沿用 `assertRuntimeClassroomActive`：课堂结束或学生被移出名单后返回 403/409，并带明确错误码。
   - 确认课堂策略允许学生内容外发（`allowStudentExternalContent`）；搜索查询会像聊天一样发往外部搜索服务。

4. **搜索渠道/模型**
   - 确认课堂所属机构/课时的搜索渠道已配置。
   - 确认 `searchChannelSelection(policy, '')` 选出的模型支持 Anthropic `web_search`。
   - 如果平台要求客户端传 `model`，请给出应传的模型 ID。

5. **工具类型**
   - 客户端会发送 `type: "web_search_20260209"`。
   - 如果平台/上游只认 `web_search_20250305` 或其他版本，请明确告知，我们改成对应值。
   - 确认 `max_uses` 上限仍为 10；客户端默认 8。

6. **响应字段**
   - 确认 `web_search_tool_result.content[]` 保留 `url`、`title`、`page_age`。
   - 确认 `usage.server_tool_use.web_search_requests` 存在（用于客户端日志与用量展示）。
   - 如果上游不返回 `page_age`，可以省略，不影响功能。

7. **错误格式**
   - 请保持 Anthropic 错误格式：
     ```json
     {
       "type": "error",
       "error": {
         "type": "invalid_request_error",
         "message": "……"
       }
     }
     ```
   - 客户端会按 HTTP 状态映射：401=密钥过期，429=频率限制，5xx=上游不可用。

8. **可选：在 client-context 暴露能力位**
   - 建议后续增加：
     ```json
     {
       "gateway": {
         "baseUrl": "...",
         "key": "...",
         "searchUrl": "https://.../api/gateway/v1/search/messages"
       },
       "features": {
         "webSearch": true
       }
     }
     ```
   - 这样客户端不用推导路径，也能按机构/课堂灰度。没有这两个字段时，客户端会按 `baseUrl + "/search/messages"` 推导，并在 404 时回退为“无 WebSearch”。

## 5. 客户端不会做的事

- 不会把平台真实上游密钥带进客户端；客户端只持有课堂运行时 key。
- 不会直接调用搜索厂商（Tavily/Serper/Bing 等）；搜索渠道与计费全部留在平台。
- 不会缓存搜索结果；每次 `WebSearch` 都打平台网关。
- 不会把搜索查询写入客户端生产日志；只记录查询长度、耗时、结果数和错误码。

## 6. 验收用例

### 6.1 正常搜索

```bash
curl -i -X POST "https://<平台域名>/api/gateway/v1/search/messages" \
  -H "x-api-key: <runtime key>" \
  -H "authorization: Bearer <runtime key>" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "max_tokens": 4096,
    "messages": [{"role":"user","content":"2026 年 React 最新版本"}],
    "tools": [{"type":"web_search_20260209","name":"web_search","max_uses":8}]
  }'
```

期望：HTTP 200；`content[]` 至少有一个 `web_search_tool_result`；其中至少一条 `web_search_result` 带 `url`。

### 6.2 密钥过期

使用过期/伪造 key 请求，期望 HTTP 401，错误体可读，错误码为 `RUNTIME_KEY_EXPIRED` 或等价。

### 6.3 课堂结束

课堂结束后用同一把 key 请求，期望 403/409，且不会继续消耗上游搜索费用。

### 6.4 搜索渠道未配置

期望返回明确错误（如 `RUNTIME_SEARCH_KEY_MISSING` / `RUNTIME_SEARCH_TOOL_REQUIRED`），不要返回 200 空结果。

## 7. 兼容与回滚

- 老客户端不会调用该端点，平台无需做客户端版本判断。
- 新客户端在端点 404/未配置时隐藏 `WebSearch`，聊天与 `WebFetch` 不受影响。
- 平台如果临时关闭搜索，只需让端点返回明确错误；客户端会提示“搜索暂不可用”，不会崩溃。
