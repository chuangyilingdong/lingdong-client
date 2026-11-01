# 灵动 ai 课堂全局系统提示词

## 目标

平台后台可以配置一段对学生课堂生效的全局系统提示词。客户端必须把它作为系统级约束注入 Agent，
而不是把它显示成用户消息或允许学生编辑。

## 平台字段

`GET /api/student/runtime/client-context` 可增加：

```json
{
  "globalSystemPrompt": "平台规定的全局约束",
  "globalSystemPromptRevision": "2026-11-01T10:00:00Z"
}
```

- 两字段均可选；缺失或空字符串表示不启用。
- `globalSystemPrompt` 最大 32 KiB UTF-8；超限时客户端忽略整段并记录告警。
- `globalSystemPromptRevision` 只用于诊断，不进入模型上下文。

## 所有权与生效边界

- 平台是提示词内容的唯一所有者。
- Desktop Main 按 workspace identity 原子写入只读运行时文件，并下发
  `ZCODE_PLATFORM_SYSTEM_PROMPT_FILE` 路径。
- Agent runtime 在创建新的 session context 时异步读取该文件，并作为独立 system section 注入。
- 已经初始化过 ContextBuilder 的会话保持创建时的提示词，避免修改历史 system block；新任务、新
  runtime 或重启后读取最新版本。平台若要求正在进行的课堂立即变更，应在网关侧同步限流/拦截，
  不能依赖修改既有会话上下文。

## 注入顺序与失败语义

1. 内置 CLI 身份、Agent 行为、会话指导和环境段保持不变。
2. 全局提示词作为最后的系统级平台约束插入，位于 Skills 与 workspace/user instructions 之前。
3. 主 Agent 与子 Agent 都必须收到同一份全局提示词。
4. 文件缺失、不可读、空内容或超过 32 KiB：本次不注入平台提示词并记录 warn/error；不得把错误
   内容或半截提示词送入模型。
5. 日志不得打印提示词正文，只允许记录长度和 revision。

## 事件顺序

```text
平台 client-context
  → Main 规范化并原子写提示词文件
  → Agent 新 runtime 读取文件
  → ContextBuilder 追加平台 system section
  → 所有模型请求带上该约束
```

## 验收

1. 平台下发非空提示词后，新任务的首个 system prompt 包含该内容。
2. 自定义 Agent prompt 不会覆盖或丢失平台提示词。
3. 子代理请求同样包含平台提示词。
4. 空值、缺失、超限和读取失败都不会产生半截提示词。
5. 日志不包含提示词正文。