# 运行时密钥请求期续签

## 背景

平台 `client-context` 每 5 秒会签发新的运行时网关 key，但 Agent 进程可能已经把旧 key 冻结在
已创建的 Model 里。只靠 Main 写 Provider 配置无法保证“发往网关的那条路”一定拿到新 key。

## 所有权

- Main 的 `lingdongPlatformGate` 持有平台 token 与 `client-context` 轮询，负责把新 key 原子写入
  Personal Provider Config。
- Agent 进程的 Provider Registry 是模型请求期 key 的读取面；每次请求都从 Registry 取当前值。
- 模型请求 fetch 层只负责一次 401 重试，不保留第二份凭据状态。

## 规则

1. 请求发送前，平台 Provider 从 Registry 读取当前 `api-key`，覆盖 Authorization / x-api-key。
2. 收到 401 时，最多强制刷新一次 Provider Registry，再用刷新后的 key 重试一次。
3. 非平台 Provider、无可用 key、刷新失败：保持原始 401 语义，不再重试。
4. Main 的课堂轮询在 key 临近过期时继续写 Provider 配置；请求层换 key 是对它的兜底，不是替代。
5. 平台 `client-context` 必须保持 `cache-control: no-store`，且每次现签新 key。

## 事件顺序

```text
Main 轮询 client-context → 新 gateway.key → 原子写 Provider Config
                                              ↓
Agent 请求 → 读 Registry 当前 key → 发网关
   └─ 401 → refresh Registry → 读新 key → 只重试一次 → 200 / 原样 401
```

## 验收

1. 请求发送前 key 已被 Registry 更新时，实际请求使用新 key。
2. 401 后 Registry 能给出新 key 时，第二次请求成功且总请求数为 2。
3. Registry 刷新失败时返回原 401，不进入循环。
4. 非平台 Provider 的 401 不触发额外重试。
