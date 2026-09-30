# 平台网关历史截断提示

## 背景

平台网关 `/chat/completions` 只把最近 `MAX_HISTORY`（当前 40）条消息转发给上游，超出部分静默丢弃。
学生在长会话里会突然发现模型「忘了」前面的要求，而界面上看不出原因。平台据此在响应头返回两个标记，
客户端读出来提示学生。

## 平台契约

- `x-platform-history-limit`：本轮网关保留的最大**消息条数**（正整数）。
- `x-platform-history-dropped`：本轮被**丢弃的消息条数**；仅 >0（发生截断）时返回。
- 两个头出现在 `/chat/completions` 的响应上（含流式 SSE），在响应头阶段就带。
- 请求来自 Electron 主进程 / Node，不经浏览器 CORS，因此**不需要** `expose-headers`；平台只需保证中间层透传。

## 状态所有者

- **事实来源 = 平台响应头**，客户端只读、不重算历史长度，不猜测截断。
- **唯一消费者 = ZCode CLI v4 投影的 `SessionControl.historyTruncation`**（`packages/shared/src/zcode-protocol-v4/snapshot.ts`）。
- Renderer 只读 `control.historyTruncation`，不自行累计，也不把它写进消息或模型上下文。

## 值形状

```ts
{ limit: number; dropped: number } | null
```

`limit` 与 `dropped` 均为正整数；`dropped` 一定大于 0。

## 不变量

1. 只有 `x-platform-history-dropped` 解析为 >0 的整数、且 `x-platform-history-limit` 也是 >0 的整数时，才产生事实。
2. 响应头里没有 `dropped`（本轮未截断）时，事实置回 `null`，避免留下过期提示。
3. 响应头整体缺失（未捕获）时不改动现值，避免把「拿不到」当成「没截断」。
4. 值未变化时投影不下发 delta（去重），避免重复触发 UI 提示。
5. 该事实是**运行态**：不写入消息、不进入模型上下文、不持久化到会话历史。
6. 该事实与 `control.apiRetry` 相互独立：截断提示不因重试开始/结束被清除，重试也不被截断事实影响。

## 事件顺序

```text
provider fetch ─ 响应头 ─▶ adapters 状态事件(model_request_completed.responseHeaders)
   ─▶ bootstrap v4 product-projection.onModelNetworkStatus
   ─▶ controlPatch({ historyTruncation }) ─▶ state.updated delta ─▶ Renderer
```

只在 `model_request_completed` 上取事实：`model_request_failed` 没有成功轮次的保留长度，不产生事实。

## 失败语义

- 缺头、非数字、0、负数一律视为「无截断」：不报错、不阻断请求、不改变主流程。
- 自建 / 第三方 provider 没有这两个头，行为与改动前完全一致。

## 验收

1. `x-platform-history-dropped: 12` + `x-platform-history-limit: 40` 时，投影 `control.historyTruncation = { limit: 40, dropped: 12 }`。
2. 无 `x-platform-history-dropped` 头的完成事件把 `control.historyTruncation` 置回 `null`。
3. 响应头整体缺失时不改动现值。
4. 相同值重复到达不重复下发 delta。
5. 桌面端在会话内**一次性**提示「早期上下文已截断」，不阻断发送。
6. `pnpm typecheck`、`pnpm lint`、v4 投影测试通过。
