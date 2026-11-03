# 本地首 Token 延迟观测

## 背景

课堂慢请求需要区分渲染器准备、命令准入、执行等待、请求准备、模型请求和首输出返回。现有 `LocalTtftObserver` 已实现单窗口观测，平台配置通过 `rendererActionTrace.localTtftEnabled` 控制是否启用；桌面端也支持 `ZCODE_LOCAL_TTFT_ENABLED=true` 作为诊断开关。

## 所有权

- Renderer 的 `LocalTtftObserver` 拥有点击到首输出的端到端时间事实。
- CLI 通过协议事实提供 admission / execution / model request / output 时间。
- `conversationTelemetrySupervisor` 和桌面 main exporter 只消费记录，不重新定义首输出。

## 规则

1. 首输出只认在线 `deltas` 中的真实正文、reasoning 或 tool input，不认 ACK、checkpoint、初始 snapshot、恢复 snapshot 或重放。
2. 后台、排队、guided、重试、取消、失败和容量排除分别记录 outcome，不能伪装成成功样本。
3. 跨进程时间只在 clock calibration 有效时拼接完整区间；未校准时保留可记录阶段并标记 `missing`，不能把“未校准”误报为坏时钟。
4. 观测失败不得阻断提交、流式投影、取消或清理。
5. 本次不默认开启生产采样，只补测试和文档；启用由平台 rollout 配置决定。

## 验收

- 请求开始到首个真实内容帧能生成 `first_output` 记录。
- `model_request` 区间覆盖 requestAt 到 outputAt。
- 初始 snapshot、recovery 和后台状态不会产生成功首输出。
- 关闭 `localTtftEnabled` 时不产生记录。
