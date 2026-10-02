# 课堂结束后返回登录门

## 背景

老师结束课堂后，平台运行时网关会拒绝后续生成请求：

- HTTP 403
- code `RUNTIME_CLASSROOM_INACTIVE`
- message `课堂已经结束，创作环境已关闭`

客户端当前只把这条错误作为普通任务提示展示，学生仍停留在已经失效的创作环境里。
目标行为是：客户端主动识别课堂结束，清理本课堂运行态，并返回登录门。

## 产品规则

1. 学生课堂进入后，Main 每 5 秒轮询一次 `GET /api/student/runtime/client-context`。
2. 只有下述成功响应才判定课堂结束：
   - 当前不是备课模式；
   - HTTP 200 且 `classroom` 为空；
   - 原因是 `NOT_STARTED` / `CLASSROOM_NOT_AVAILABLE` / `CLASSROOM_MODE_MISMATCH`。
3. 网络失败、401、临时 5xx 不触发退出，避免网络抖动把学生踢回登录页。
4. 判定课堂结束后：
   - 写入一次性登录提示 `课堂已结束，请重新登录。`；
   - 清理平台 Provider 与会话状态；
   - `app.relaunch()` 后退出当前进程；
   - 新进程显示登录门，并在登录卡片里展示这次提示。
5. 同一进程内该退出动作只允许执行一次，轮询期间的并发结果不得重复 relaunch。
6. 备课模式 `prep:true` 不轮询、不退出。

## 所有者与边界

- 唯一所有者：`packages/desktop/src/main/lingdongPlatformGate.ts`。
- 登录提示是一次性文件状态，登录门读取后删除；不进入 renderer 全局状态。
- Renderer 不直接轮询平台、不持有 token，也不负责决定是否退出。

## 事件顺序

```text
学生已进入课堂
  → Main 定时 GET client-context
  → classroom:null 且原因属于课堂结束
  → 写一次性 gate notice
  → 清理 Provider / activeState
  → app.relaunch()
  → app.quit()
  → 新进程登录门读取并删除 notice
  → 登录页显示“课堂已结束，请重新登录。”
```

## 验收

1. 模拟课堂结束：主窗口关闭，重新出现登录门；登录门显示结束提示。
2. 网络失败：不退出。
3. 备课模式：课堂为空也不退出。
4. 连续多次轮询只触发一次 relaunch。
