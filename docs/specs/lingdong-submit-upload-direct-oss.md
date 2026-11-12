# 课堂作品直传 OSS

## 背景

multipart 提交把作品二进制整体送进平台，平台需要占用请求 body 和内存闸。并发 100 个 20MB 作品时，
服务端上传闸只能允许 1 份并发，其余请求会收到 429。平台新增 prepare/direct 协议，让客户端把二进制
直接 PUT 到 OSS，平台只接收文本与资产引用。

平台生产 release `20261112T114601Z` / commit `bea192ce` 已上线直传；旧 JSON 和 multipart 入口继续保留。

## 产品规则

1. 新客户端提交作品时优先走 direct：先调用 `POST /api/student/runtime/submit-upload/prepare`。
2. prepare 文件清单中，二进制文件带 `size` 和 32 位 hex `md5`；文本文件只带 `size`。
3. 客户端对预签名 PUT 使用返回的 `method` / `url` / `headers`，不得改写 `content-type`；二进制上传并发为 3。
4. 单个 PUT 的失败重试一次；仍失败时回退现有 multipart，不把上传网络错误直接抛给用户。
5. 所有二进制 PUT 完成后调用 `POST /api/student/runtime/submit-upload/direct`，提交文本内容、二进制引用和
   `uploadToken`；封面作为 `cover.png` 参与 prepare/PUT，并在 finalize 中带 `cover=true`。
6. direct finalize 的业务校验错误（票据、大小、md5、magic、课堂门禁等）必须原样/按现有错误码抛出，不得回退或吞掉。
7. 只有 prepare 返回 `501`、`404`、`DIRECT_UPLOAD_UNAVAILABLE`，或 PUT 网络/HTTP 失败时才回退 multipart。
8. 客户端继续执行既有限制：最多 60 个文件、文件与封面的实际总字节不超过 100MB、封面不超过 1.5MB。
9. 日志必须记录 `transport=direct|multipart`，供线上确认实际走的通道。
10. Renderer 不感知 direct/multipart，也不接触 OSS URL、uploadToken 或文件字节。

## 所有权与边界

- `packages/desktop/src/main/lingdongPlatformGate.ts` 是 prepare、OSS PUT、direct finalize 和 fallback 的唯一所有者。
- Renderer 只提交作品候选与课堂字段，继续通过 `window.lingdong.submitWork` 进入 Main。
- 平台负责签发 uploadToken/预签名 URL，并在 direct finalize 时校验大小、ETag、magic 和课堂权限。
- OSS 负责接收二进制对象；未完成上传的 `direct-upload/` 孤儿对象由平台后续清理。

## 事件顺序

```text
Renderer submitWork
  -> Main resolveSubmitPlan + 读取文件
  -> POST prepare(files: size/md5, task/session)
  -> 收到 uploadToken + 每个 binary 的 PUT url/headers
  -> 并发 3 PUT 二进制（失败重试一次）
  -> POST direct(uploadToken, 文本内容, binary 引用, cover)
  -> 平台 HEAD/ETag/magic 校验并落作品
  -> Main 写本地提交指纹并返回 Renderer

prepare 404/501/UNAVAILABLE 或 PUT 最终失败
  -> 回退现有 multipart
```

## 失败语义

- prepare 不可用：静默回退 multipart，日志记录 `transport=multipart`。
- PUT 网络错误或非 2xx：重试一次；仍失败则回退 multipart。
- direct finalize 业务错误：直接返回，不触发 multipart 重复提交。
- 文件读取、入口缺失或总字节超限：在 prepare 前失败。
- 封面采集失败：不阻断提交，direct/multipart 均按无封面处理。

## 验收

1. direct 成功时 prepare、并发 PUT、direct finalize 顺序正确，日志为 `transport=direct`。
2. 二进制清单为 32 位 hex md5 + 字节数，文本清单只含字节数。
3. PUT 使用平台返回的 headers，失败重试一次，仍失败则回退 multipart。
4. prepare 404/501/`DIRECT_UPLOAD_UNAVAILABLE` 回退 multipart。
5. direct finalize 的 400/403 等业务错误不触发 multipart。
6. 封面通过 `cover.png` 上传并在 finalize 中带 `cover=true`。
7. 文本内容在 finalize body 中提交，不进入 OSS PUT。
8. 文件数、总字节和封面大小限制与平台一致。
