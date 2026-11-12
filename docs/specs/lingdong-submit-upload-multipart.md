# 课堂作品 multipart 提交

## 背景

课堂作品提交包含入口文件、引用素材和可选封面。旧协议把二进制文件编码成 base64 后塞进 JSON，
100MB 作品会膨胀到约 133MB，并在 Main 进程里产生多份完整字符串副本，增加内存峰值和 CPU 开销。

平台生产 release `20261112T093036Z` / commit `5232f6c9` 已让
`POST /api/student/runtime/submit-upload` 同时接受 multipart 和旧 JSON。客户端本次只切换新版本到
multipart；旧客户端继续使用 JSON，不需要强制升级。

## 产品规则

1. 手动提交和课后自动补交都使用 `multipart/form-data`。
2. `meta` part 是 JSON 字符串，包含作品名、标题、版权确认、任务/课堂字段和文件元数据。
3. `meta.files[i]` 与文件 part `file:i` 按索引一一对应；文件 part 保留原始字节，不再 base64 或 UTF-8 转换。
4. `binary` 只作为 `meta.files[i].binary` 的元数据传给平台，不改变文件 part 的原始字节。
5. 手动提交可额外发送 `cover` PNG part，并在 `meta.cover=true` 中声明；自动补交不采集封面。
6. 请求不手工设置 `Content-Type`，由 `fetch` 生成带 boundary 的 multipart header。
7. 客户端按实际请求数据字节限制整单为 `100MB`，包括文件、封面和 `meta`；multipart boundary 等协议开销由
   平台额外允许。
8. 成功响应、`works` 解包、`autoSubmitted` / `autoSubmitSkipped` 和平台错误码保持旧 JSON 语义。
9. 平台旧 JSON 入口只用于兼容旧客户端；新客户端本期不实现 multipart 失败后自动降级到 JSON。

## 所有权与边界

- `packages/desktop/src/main/lingdongPlatformGate.ts` 是 multipart 组包、平台 token 注入和提交响应的唯一所有者。
- Renderer 只传候选文件和提交元数据，不接触平台 token、文件字节或 FormData。
- 文件扫描、路径校验、入口选择和素材收集继续由 Main 现有的 `resolveSubmitPlan` / `prepareSubmitFiles` 负责。
- 平台负责解析 multipart、按 `meta.files` 顺序落盘、执行原有判重和课堂门禁。

## 事件顺序

```text
Renderer submitWork
  -> Main resolveSubmitPlan
  -> readFile 原始 bytes
  -> 生成 meta JSON
  -> FormData(meta, file:0..n, cover?)
  -> fetch POST /api/student/runtime/submit-upload
  -> 平台按 meta.files 顺序解析 file:i
  -> 返回 works / autoSubmitted / autoSubmitSkipped
  -> Main 写本地提交指纹并返回 Renderer
```

## 失败语义

- 网络失败、鉴权失败、课堂结束、自动补交窗口关闭和平台业务错误继续使用现有 `PlatformRequestError` 语义。
- mock/平台返回非 JSON 或非法响应时保持原提交失败语义，不伪造成功。
- 文件读取失败、入口缺失或实际数据超过 100MB 时，在发请求前失败。
- 封面采集失败不阻断正文提交，只减少 `cover` part。

## 验收

1. 手动提交发送 `meta`、`file:0..n` 和可选 `cover`，平台收到正确文件名、文本和二进制内容。
2. 自动补交发送 `meta.sessionId`、`meta.autoSubmit=true`、`meta.copyrightConfirmed=false`，不发送封面。
3. 二进制素材不再经过 base64；请求体积按原始字节计算。
4. `meta.files[i]` 与 `file:i` 顺序一致，平台判重键和 `taskId` 行为不变。
5. 旧客户端 JSON 提交仍可工作。
6. 平台 403、429、网络错误和自动补交跳过语义保持可归类、可重试边界不变。
