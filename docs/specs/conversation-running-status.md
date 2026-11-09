# 对话运行中状态

## 背景

当前对话工作状态使用旋转 loader，无法直观看到已经运行多久。官方 ZCode 使用像素矩阵动画、
“工作中”文案和高精度耗时；本仓库接入同一表现，同时保持已有推理过程常显。

## 所有权

- 推理行可见性继续由 `ConversationRowRenderContext.messageStreamShowReasoning` 决定，默认开启。
- 运行时长事实来自 turn/work segment 的 `workStatus.durationMs`；`ChatLoading` 只负责在两次
  上游更新之间做本地平滑推进。
- 运行阶段文案由 UI 根据当前 work segment 的 `assistantWorkRows` 派生：首个非空可见输出前为
  `thinking`，之后为 `working`。不新增持久化状态，不把派生结果写回任务或协议。

## 产品规则

1. 首个非空可见输出前显示“小灵正在思考”；`reasoning_start`、空 streaming reasoning 和空
   streaming assistant text 都不算首个可见输出。
2. 收到首个非空 reasoning、assistant text 或 tool call 后切换为“工作中”；同一 work segment
   内不退回“小灵正在思考”。
3. 运行中推理过程保持可见；用户设置关闭推理时仍按现有设置隐藏。
4. 当前 work segment 的折叠头和底部运行状态使用同一阶段文案；运行中显示像素矩阵动画、
   阶段文案和高精度时长（十分之一秒）。
5. 时长从当前 work segment 已有 duration 起算；组件收到新的上游 duration 后重新校准。
6. 完成、等待用户输入、权限确认和 active work 阻断时，不显示运行中状态。
7. 减少动效偏好开启时关闭像素和文字动画，但仍显示静态状态与时长。

## 验收

- 发送后、首个输出前显示“小灵正在思考 1 分 28.7 秒”这类文案，并每 100ms 平滑更新。
- 首个非空 reasoning、assistant text 或 tool call 出现后，折叠头和运行状态同时切换为“工作中”。
- 空 reasoning 行或空 assistant text 行不会提前把“小灵正在思考”切到“工作中”。
- 已有耗时超过 0 时，组件首次显示从该值开始，不从 0 重新计时。
- 推理开启时，推理摘要和运行中状态可以同时存在。
- 完成或等待交互后运行中状态消失。
