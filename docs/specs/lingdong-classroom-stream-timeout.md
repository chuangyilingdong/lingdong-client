# 灵动课堂模型流静默超时

## 背景

灵动课堂网关允许模型请求在较长时间内只发送 SSE 注释心跳，并在超过 10 分钟后才返回首个真实模型事件。
Agent 默认的模型流 idle timeout 是 10 分钟，不能把平台心跳当作模型事件，因此课堂请求到点后会被
客户端主动中断并静默重试。该行为会重复发起模型请求，也会让 UI 长时间停留在“小灵正在思考”。

本 spec 只调整课堂模式下的 idle timeout，不改变普通客户端的 10 分钟默认值，也不改变模型流失败后的
重试策略。

## 产品规则

1. 普通客户端、普通 Provider、未开课和备课模式继续使用默认值 `600_000ms`。
2. 学生进入课堂且平台上下文满足 `classroom != null`、`prep !== true` 时，Desktop Main 为该窗口的
   Host 注入 `ZCODE_MODEL_STREAM_IDLE_TIMEOUT_MS=1200000`。
3. 该课堂环境变量在 Host 启动前写入，并对课堂窗口内由该 Host 启动的 Agent 生效；课堂结束后进程
   按既有流程重启，不复用课堂环境的 20 分钟配置。
4. Agent 配置适配器把 `ZCODE_MODEL_STREAM_IDLE_TIMEOUT_MS` 映射到
   `config.modelStream.idleTimeoutMs`。
5. 环境变量只接受有限正数；空值、非数字、`0` 和负数都视为无效，不覆盖低优先级配置。
6. 环境变量沿用现有配置优先级：高于用户配置和项目配置，低于 CLI override。
7. `DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS` 保持 `600_000`，不得全局改成 20 分钟。

## 所有权与边界

- `packages/desktop/src/main/lingdongPlatformGate.ts` 拥有课堂上下文事实。
- Desktop Main 负责根据课堂上下文生成 Host 环境变量补丁，不把课堂判断下沉到 Renderer 或模型层。
- `apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts` 负责环境变量到运行时配置的唯一映射。
- Agent model adapter 只消费已合并的 `config.modelStream.idleTimeoutMs`，不自行读取课堂状态。
- Renderer 不保存 idle timeout，也不判断当前是否为课堂。

## 事件顺序

```text
平台登录门完成
  → Main 读取 client-context.classroom / prep
  → classroom != null 且 prep !== true
  → 写入 ZCODE_MODEL_STREAM_IDLE_TIMEOUT_MS=1200000
  → 启动窗口 Host
  → Host 启动 Agent
  → CLI parseEnvConfig 映射到 modelStream.idleTimeoutMs
  → model adapter 使用 20 分钟 idle timeout

备课 / 未开课 / 非课堂
  → 不写入课堂 timeout 环境变量
  → CLI 回落到默认 600000 或显式的用户/项目/CLI 配置
```

## 失败语义

- 平台上下文没有课堂或处于备课模式：不注入，保持默认配置。
- 环境变量格式非法：忽略该值，继续使用下一优先级配置或默认值。
- 环境变量合法但不等于 20 分钟：仍按通用配置覆盖规则生效，课堂注入值本身固定为 20 分钟。
- idle timeout 仍是请求级保护；超过配置时间没有真实模型事件时，沿用现有模型流失败与重试语义。

## 验收

1. 课堂上下文返回 `classroom != null` 且非备课时，Host 环境包含
   `ZCODE_MODEL_STREAM_IDLE_TIMEOUT_MS=1200000`。
2. 备课上下文或 `classroom == null` 时，不生成课堂 timeout 环境变量补丁。
3. `parseEnvConfig` 把合法值映射到 `modelStream.idleTimeoutMs`；非法值不产生该字段。
4. 未设置环境变量时，合并后的 `modelStream.idleTimeoutMs` 仍为 `600000`。
5. `test-stream-11m` 在 10 分钟节点不再出现新的 `compute_attempts`，11 分钟首个真实内容正常到达，
   客户端日志不出现新的 `MODEL_STREAM_IDLE_TIMEOUT`。
