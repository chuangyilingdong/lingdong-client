# 课堂结束自动补交 VibeCoding 作品

## 背景

老师结束课堂后，平台在 10 分钟宽限期内允许客户端为刚结束的 VibeCoding 课堂补交作品。
学生没有在课堂内点「提交作品」时，只要客户端仍开着，就应在检测到课堂结束后自动提交本节课产生的任务。

平台接口：`POST /api/student/runtime/submit-upload`，请求为 `multipart/form-data`。
自动提交时 `meta` part 里的 JSON 额外携带：

```jsonc
{
  "taskId": "3f2c...",
  "sessionId": "csession_...",
  "autoSubmit": true,
  "copyrightConfirmed": false,
  "files": [{ "name": "index.html", "binary": false }],
}
```

入口文件和素材分别放在 `file:0`、`file:1` … part；自动提交不发送 `cover`。

平台只接受 ENDED、结束时间在宽限期内、学生在名单内且课时为 VibeCoding 的课堂。
手动提交过的同 `taskId + entryFile` 不覆盖；自动提交结果允许 `autoSubmitSkipped`。

## 产品规则

1. Main 在学生课堂运行期间缓存当前 `classroom.id` 与 `startedAt`。
   - `startedAt` 优先使用 `client-context.classroom.startedAt`。
   - 平台未提供或值非法时，使用该课堂第一次被客户端看到的时间。
   - 同一课堂后续轮询只补全权威开始时间，不回退已缓存的首次看到时间。
2. Main 现有每 5 秒 `client-context` 轮询继续负责检测结束。
   - 成功响应中 `classroom` 为空且 reason 属于现有课堂结束集合时，进入自动提交。
   - 成功响应中出现了另一节课、缓存的课堂 id 已不在当前 classroom 时，也先为旧课堂进入自动提交。
   - 网络失败、401、临时 5xx 不触发自动提交或退出。
3. 自动提交由 Renderer 根据本地 task 状态选任务；Main 不读取或复制 task/session 业务状态。
4. 只处理满足以下任一条件的任务：
   - `task.createdAt >= classroom.startedAt`；
   - 或该任务的 V4 `turnHeader` / `fileChanges` 有课堂开始后的变化。
5. 每个任务只提交一个入口：从课堂开始后产生变化的可提交文件（`.html/.htm/.docx/.xlsx/.pptx`）中，
   按工作区文件更新时间选择最新入口；素材继续由宿主 `resolveSubmitPlan` 自动打包。
6. 以下任务跳过：
   - 没有课堂开始后的可提交入口；
   - 现有 `scanWorkspaceFiles({ taskId, taskFilePaths })` 返回的 `preview.lastSubmittedAt` 存在。
     `lastSubmittedAt` 同时覆盖本地 `taskId + entryRelativePath` 指纹与平台 `taskId + entryFile` 历史作品。
7. 自动提交顺序执行，任务之间不并发：每个任务独立成一条作品；平台按 `taskId + entryFile` 判重。
8. 自动提交使用 `copyrightConfirmed: false`，不采集封面；手动提交链路与版权确认要求保持不变。
9. 网络失败最多重试 1 次；`403 AUTO_SUBMIT_WINDOW_CLOSED` 或
   `403 AUTO_SUBMIT_WRONG_CLASSROOM` 立即停止后续任务；`autoSubmitSkipped` 只跳过当前任务。
10. 所有任务处理完，或从检测到结束起超过 10 分钟，立即停止。
11. 自动提交结束后 Main 再执行既有课堂退出流程：写一次性提示、清理课堂状态、relaunch 到登录门。
12. 客户端未启动、窗口提前关闭或 Renderer 不存在时不伪造提交；Main 直接按既有流程退出。

## 所有权与边界

- 课堂生命周期、课堂缓存、轮询、自动提交请求路由：`packages/desktop/src/main/lingdongPlatformGate.ts`。
- 本地任务筛选、V4 fileChanges 读取、逐任务自动提交：Renderer 的
  `useLingdongClassroomAutoSubmit` + `runLingdongClassroomAutoSubmit`。
- 提交打包、平台请求、本地提交指纹写入：继续由 Main 的 `submitWorkFromDesktop` 唯一负责。
- 平台 token 仍不进入 Renderer；Renderer 只通过 `IPlatformService.classroom` 调用。
- Main 不以单一路径猜测 task 归属，也不维护 task 列表投影。

## 事件顺序

```text
Main 每 5 秒 GET client-context
  -> 缓存 classroom.id/startedAt
  -> 检测 classroom 消失或缓存 id 不再出现
  -> 生成 requestId，向现有主窗口发送 classroom-ended 事件
Renderer 匹配 workspacePath/workspaceIdentity
  -> claim(requestId)
  -> 列出 workspace tasks
  -> 读取 task.createdAt + V4 turnHeader/fileChanges
  -> 逐任务 scanWorkspaceFiles(taskId, taskFilePaths)
  -> 跳过已提交/无入口
  -> submitWork(autoSubmit=true, sessionId, copyrightConfirmed=false)
  -> 网络失败重试一次
  -> complete(requestId, result)
Main 收到 complete 或确认无窗口可处理
  -> 写 gate notice
  -> 清理 Provider / activeState
  -> app.relaunch() + app.quit()
```

多个窗口都收到事件时，由 Main 只接受第一个匹配 workspace 的 claim；其他窗口回传未认领确认，
不得产生重复自动提交。认领窗口销毁但未完成时，Main 结束本次请求并按既有退出流程继续。

## 平台生产确认（2026-11-03）

- 生产 `https://aicyld.com` 已切换到包含展示授权放通的 release `20261103T060957Z` / commit `bb40096e`。
- `submit-upload` 已支持 `sessionId`、`autoSubmit: true`、`copyrightConfirmed: false` 与 `taskId` 同传。
- 三个自动提交错误码与手动作品 `autoSubmitSkipped` 语义已在生产生效。
- migration 51 已执行：`works.auto_submitted`、`vibecoding_submissions.auto_submitted` 均为
  `tinyint NOT NULL DEFAULT 0`。
- 生产宽限期实测为 `600000ms`；未配置 `RUNTIME_AUTO_SUBMIT_GRACE_MS`，使用代码默认值并夹在 1 分钟至 1 小时。
- 权威窗口起点是服务端 `class_sessions.ended_at`，不是客户端检测时刻。客户端继续使用检测后的本地
  10 分钟安全截止；最多少提交约一个轮询周期，收到 `403 AUTO_SUBMIT_WINDOW_CLOSED` 立即停止。
- `client-context` 当前不下发宽限值；平台承诺短期保持 600000ms，未来若调整会先提供新的客户端契约。
- 产品与平台确认：自动提交后**不再要求学生补确认展示**，提交即视为同意展示。客户端继续发送
  `copyrightConfirmed: false`，不得伪造为 `true`，也不新增展示确认 UI。
- 平台已把 `auto_submitted=1` 视为已同意展示；审核通过后可直接发布到作品广场，公开列表、详情和分享码已放通。
- 手动提交路径不变，仍要求 `copyrightConfirmed: true`。

### 生产 E2E 实测（2026-11-03）

- 使用生产临时 VibeCoding 课堂完成一次真实链路：学生客户端生成 `index.html` + `style.css`，
  老师端结束课堂后客户端自动补交并返回登录门。
- 平台 `GET /api/student/works` 返回该作品：`autoSubmitted: true`、`taskId` 非空、
  `copyrightConfirmedAt: null`、`entryFile: "index.html"`。
- 老师端作品详情快照包含 `index.html`、`style.css`，`missingAssets` 为空。
- 老师端作品详情响应不单独暴露 `autoSubmitted`；自动来源以学生作品列表/数据库标记为准。
- 本次测试课堂已结束并作为历史记录保留。

## 平台契约映射

- Renderer 新请求字段：`sessionId`、`autoSubmit: true`、`copyrightConfirmed: false`。
- Main 透传并返回平台顶层 `autoSubmitted` / `autoSubmitSkipped`，`works[].autoSubmitted` 原样保留。
- 平台错误码必须保留到 Renderer，供停止策略判断；不能再只返回自然语言 message。
- 手动提交仍使用 `copyrightConfirmed: true`，不发送 `sessionId`/`autoSubmit`。

## 失败语义

- `AUTO_SUBMIT_WINDOW_CLOSED`：宽限期已过或学生不在名单，停止后续提交，不重试。
- `AUTO_SUBMIT_WRONG_CLASSROOM`：不是 VibeCoding 课时，停止后续提交，不重试。
- `AUTO_SUBMIT_SESSION_REQUIRED`：客户端缺陷，记为失败并停止后续提交。
- `autoSubmitSkipped=true`：当前任务已存在，继续下一个任务。
- 其他 4xx/5xx：当前任务失败，继续下一个任务；不把失败伪装成成功。
- 网络异常：当前任务立即重试一次；再次失败则当前任务失败并继续下一个任务。
- 平台尚未切换、仍按旧 copyright 规则处理时，自动提交会失败；客户端不得改用手动路径或伪造
  `copyrightConfirmed: true`，仍应完成退出流程。

## 兼容与迁移边界

- 自动提交只在课堂结束后的内部路径触发，不影响学生手动提交。
- 现有本地指纹格式 `taskId + entryRelativePath` 与平台 `taskId + entryFile` 判重语义都保留。
- 画布课堂由平台在老师结束时自动提交，客户端不参与。
- 不新增 task/session 持久化副本，不改 Desktop/Web 实时链路语义。

## 验收

1. 单元测试覆盖：本课任务筛选、开始前旧任务排除、旧任务课后文件变化纳入、已提交任务跳过、
   网络重试一次、窗口关闭停止、`autoSubmitSkipped` 继续。
2. E2E：课堂内生成任务文件但不手动提交 -> 模拟老师结束 -> 客户端先自动提交再返回登录门 ->
   mock 平台收到 `sessionId`、`autoSubmit: true`、`copyrightConfirmed: false`、正确 `taskId` 与素材清单。
3. 去重 E2E：学生已在课堂内手动提交 -> 模拟老师结束 -> 自动流程识别本地/平台已有作品并跳过，
   不产生自动提交请求、不覆盖手动作品的版权确认状态，随后仍返回登录门。
4. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
5. E2E 可执行入口：`pnpm smoke:platform:classroom-auto-submit`（自动提交）与 `pnpm smoke:platform:classroom-auto-submit:skip`（手动提交后跳过）。
