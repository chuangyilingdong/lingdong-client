# 本地 ToolSearch 与 DeferredToolCall

## 背景

当前 VibeCoding 主 Agent 会向模型暴露全部内置工具。一次普通请求的工具定义约 4 万字符，完整内置工具目录约 7 万字符；首轮缓存未命中时，这些 schema 会直接增加输入 token 和首字延迟。上游 ZCode 已提供 ToolSearch / DeferredToolCall，用“按需发现工具”替代“每次发送全部定义”。

本次只移植 **local 模式**：

- 不实现 Anthropic/native tool reference。
- 不新增 provider-specific 协议。
- 工具仍由本地 registry 执行，权限、Hook、审计和持久化链路不变。

## 所有权

- Tool Registry 是所有已注册工具的唯一事实源。
- `ToolSearchRuntimeState` 拥有 resident/deferred 分类、搜索目录和搜索算法，不保存第二份工具实现。
- Tool Executor 拥有 `DeferredToolCall -> 实际工具` 的执行前解析权；解析必须发生在 permission、Hook 和 handler 之前。
- Provider message projection 只负责 `modelCallWrapper` 的模型可见还原，不参与执行决策。
- Agent Runtime 只在当前 session 内持有 ToolSearch 状态，不跨 session 共享可变 catalog。
- subagent child runtime 必须继承父 session 的 `toolSearch` 配置；否则父会话显式关闭后，child 会重新启用 local 模式。

## 产品规则

1. local 模式开启时，Provider 只看到：
   - resident tools；
   - `ToolSearch`；
   - `DeferredToolCall`。
2. resident tools 固定为核心高频工具：
   `Read`、`Write`、`Edit`、`ApplyPatch`、`Bash`、`Glob`、`Grep`、
   `TodoRead`、`TodoWrite`、`AskUserQuestion`、`Skill`、`EnterPlanMode`、
   `ExitPlanMode`、`WebSearch`、`WebFetch`。
3. 其余 provider-visible、非 provider-native 工具进入 deferred catalog；MCP 工具也默认 deferred。
4. `ToolSearch` 只搜索 deferred catalog：
   - 支持 `select:<tool_name>` 精确选择；
   - 普通查询按工具名、描述、capability 排序；
   - 返回有界数量的完整 input schema，不返回未注册工具。
5. `DeferredToolCall` 输入固定为 `{ name, input }`，只允许调用 deferred 工具：
   - resident tool、未知工具、ToolSearch、DeferredToolCall、provider-native tool 一律拒绝；
   - 不得通过该入口绕过真实工具的权限、审批、Hook 或输出预算。
6. Executor 命中 `DeferredToolCall` 时，先把调用改写为真实工具名和真实 input，再进入原执行链路。
7. 模型历史中的 assistant tool call 和 tool result 通过 `modelCallWrapper` 保留模型侧名称 `DeferredToolCall`；Provider 投影必须还原为包装调用，不能让模型看到内部改写后的名称。
8. ToolSearch 状态关闭、deferred catalog 为空或低于最小收益阈值时，恢复全量工具暴露，不注册额外控制工具。
9. ToolSearch 失败、结果为空或 schema 过大时不得阻断普通 resident 工具调用。

## 默认与开关

- 默认模式：`local`。
- 环境变量 `ZCODE_TOOL_SEARCH=off` 可关闭；其他非法值回退默认 `local`。
- 最小 deferred 工具数：`8`，低于该值不启用，避免小工具面增加一次额外搜索。
- subagent child runtime 与父 session 使用同一模式和阈值；workflow child 继续通过配置展开继承。
- 本次不增加 UI 设置，不改变平台协议。

## 事件顺序

```text
模型返回 DeferredToolCall
  → Executor 校验 target 属于 deferred catalog
  → 改写为真实 tool name / input，并记录 modelCallWrapper
  → 真实工具的 permission / Hook / handler / result budget
  → ToolExecutionResult(modelCallWrapper=DeferredToolCall)
  → 内存 Tool result 携带 wrapper
  → Provider 投影：
      assistant tool_call = DeferredToolCall({name,input})
      tool result         = DeferredToolCall result
```

## 失败语义

- 未知或非 deferred target：返回可恢复的工具错误，不下发真实工具 handler。
- ToolSearch 无结果：返回空结果与可操作的查询提示，不报基础设施错误。
- 真实工具执行失败：沿用原工具错误、权限错误和 turnControl，不二次包装成成功。
- ToolSearch state 缺失或模式 off：`DeferredToolCall` 不可用，resident 工具与旧链路保持可用。
- Provider 投影遇到 wrapper 与实际工具名不一致时，以 wrapper 作为模型可见名称，实际工具只用于执行归因。

## 非目标

- 不移植 Anthropic native ToolSearch / tool_reference。
- 不修改工具调用次数预算、上下文裁剪或输出预算。
- 不把 ToolSearch 结果持久化为第二份工具定义。
- 不扩大 MCP 权限，不改变 MCP 信任判断。

## 验收

- local 模式下 Provider tool list 不包含 deferred tools，包含 resident、ToolSearch、DeferredToolCall。
- `AskUserQuestion` 直接出现在 resident tool list 中，课堂 Provider 请求体无需先搜索即可收到该工具。
- `Skill`、`EnterPlanMode`、`ExitPlanMode`、`WebSearch`、`WebFetch` 直接出现在 resident tool list 中，不进入 deferred catalog。
- 课堂 E2E 中 mock Provider 返回 `AskUserQuestion` 时，客户端显示多题选项卡；用户选择并提交后，Agent 能继续收到答案并完成回合。
- `select:<name>` 和关键词搜索能命中正确的 deferred tool。
- `DeferredToolCall` 改写后实际执行真实工具，权限与 Hook 使用真实工具声明。
- `DeferredToolCall` 不能调用 resident、未知、自身或 provider-native 工具。
- assistant tool call 与 tool result 在 Provider 请求中都显示为 `DeferredToolCall`。
- 模式 off 时工具列表与当前行为完全一致。
- Provider 实际请求体只包含 resident 和两个控制工具，不包含 deferred tool schema。
- 打包态 E2E 能从 mock Provider 收到的请求体读取并校验工具面。
- `pnpm typecheck`、定向测试和架构检查通过。
