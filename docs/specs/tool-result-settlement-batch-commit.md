# 工具结果批量进入模型历史

## 背景

模型一次响应可以声明多个工具调用。工具执行完成后，当前运行时逐项异步保存工具结果；如果中途某个工具 part、媒体附件或用量记录保存失败，后面的兄弟工具结果可能还没有进入模型历史，下一次模型请求就会出现“assistant 有 tool_call、但缺少对应 tool result”的不完整配对。

## 所有权

`executeToolCallsForModelStep` 是本轮工具结果进入内存模型历史的唯一入口。持久化适配器只负责 durable part / attachment / usage，不决定模型历史是否完整。

## 规则

1. 一批工具执行完成后，先在本地 Turn request history 中一次性提交该批次全部工具结果。
2. 批量提交必须发生在任何工具结果异步持久化、媒体保存、checkpoint、usage 记录或 follow-up 队列处理之前。
3. 每个结果使用既有 `createRuntimeToolResultEntry`、`modelContentForToolResult` 和 `isErrorForToolResult` 语义，不新增第二种序列化格式。
4. durable persistence 仍逐项执行；失败时保留真实错误并交给既有失败恢复，不把持久化失败伪装成成功。
5. 不新增工具调用次数硬停止，不修改上下文裁剪或输出预算。
6. Provider 请求投影必须保持同一批 tool result 连续；夹在中间的历史提醒移到整组 tool result 之后。

## 事件顺序

```text
工具执行完成
  → 汇总全部 ToolExecutionResult
  → 一次性写入 turn request history
  → 逐项保存 part / media / usage
  → checkpoint / recovery anchor / follow-up
  → 下一次 provider 请求
```

## 验收

- 多工具批次中任一异步保存失败，模型历史仍包含该批次所有工具结果。
- 成功路径不会重复写入工具结果。
- 工具结果顺序与 assistant tool_call 声明顺序一致。
- 取消、错误结果、媒体结果继续沿用现有状态和错误文案。
