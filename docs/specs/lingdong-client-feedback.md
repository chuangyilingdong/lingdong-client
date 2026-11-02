# 灵动ai 客户端问题上报接入平台 Spec

- 状态：实现中（2026-11-02）
- 范围：`packages/services`、`packages/desktop`、`packages/ui`
- 平台依赖：学习平台 `client_feedback` 接口与平台管理后台

## 1. 目标

在灵动ai 平台登录模式下，客户端“问题上报”只提交到学习平台，由平台方在平台后台接收、查看和处理。提交内容包含用户描述、截图、可选的诊断日志、客户端环境与当前模型上下文。

## 2. 非目标

- 不写入机构 `help_feedback`，机构管理员和老师不接收客户端反馈。
- 不在灵动ai 模式下向 `zcode.z.ai` 双写。
- 不自动把使用者的敏感配置文件、凭据或数据库打进日志。
- v1 不在客户端内实现在线对话回复；后台处理结果通过状态回显。

## 3. 状态所有权

- 学习平台数据库 `client_feedback`：工单内容和处理状态的唯一事实。
- 学习平台 `client_feedback_attachments`：附件与工单的关联事实。
- 学习平台 `file_assets`：附件字节和访问权限的唯一所有者。
- 客户端反馈服务：只负责提交与读取投影，不把服务端状态复制成第二事实。
- 客户端本地待提交任务只属于 UI 乐观进度，不参与权威状态。

## 4. 模式与迁移边界

1. 灵动ai 平台登录后，Host 收到平台反馈配置，反馈服务切换为 `PlatformFeedbackService`。
2. 非灵动ai 模式继续使用现有 ZCode 反馈服务，行为不变。
3. 灵动ai 模式不得同时提交到 ZCode 反馈服务；切换后只有平台一条写入路径。
4. 平台登录 token 只传给本地 Host 的反馈服务，不进入 Renderer。

## 5. 事件顺序

```text
用户点击问题上报
  -> 创建反馈（携带 operationId 作为幂等键）
  -> 平台 client_feedback 写入 SUBMITTED
  -> 客户端上传截图（失败可继续）
  -> 用户勾选诊断日志时生成脱敏 zip 并上传
  -> 平台后台可查看工单、环境和附件
  -> 平台管理员更新处理状态
  -> 客户端“我的反馈”读取最新状态
```

## 6. 接口

客户端使用平台登录 token 调用：

- `POST /api/client-feedback`
- `GET /api/client-feedback`
- `GET /api/client-feedback/:id`
- `POST /api/client-feedback/:id/messages`
- `POST /api/client-feedback/:id/attachments`（multipart）
- `GET /api/client-feedback/:id/attachments/:attachmentId/download`

创建请求以 `idempotencyKey` 保证重试不重复建单；相同用户与幂等键返回同一工单。

## 7. 失败语义

- 未登录/登录失效：提示重新登录，不回退到 ZCode 反馈服务。
- 创建失败：不生成虚假工单 ID。
- 创建成功但附件失败：工单保留，并提示附件未全部上传。
- 日志生成失败：不影响文字工单提交，明确提示日志未上传。
- 上传重试使用同一工单 ID，不重复创建工单。

## 8. 验收

1. 灵动ai 客户端提交后，平台管理后台“问题反馈”出现记录。
2. 机构端“问题反馈处理”看不到该记录。
3. 相同 operationId 重试只生成一条平台工单。
4. 勾选诊断日志后，后台详情可下载日志附件。
5. 平台管理员更新状态后，客户端“我的反馈”显示最新中文状态。
6. 未登录或 token 失效时不向 ZCode 反馈服务回退。
7. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。

## 9. 回滚

平台关闭反馈接入配置时，灵动ai 客户端应保留手动导出日志能力。已写入平台的工单不回滚、不迁移到机构表。
