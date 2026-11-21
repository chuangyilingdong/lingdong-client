# 课堂启动工作区身份透传

## 背景

课堂登录后，Main 已确定当前课堂工作区并把路径写入
`ZCODE_LINGDONG_WORKSPACE_PATH`。但窗口启动参数只透传路径与 purpose，没有透传
`ZCODE_LINGDONG_WORKSPACE_IDENTITY`。Renderer 的恢复逻辑因此把课堂启动误判成
“没有初始 workspace identity”，创建默认会话工作区，并可能把课堂显示成“尚未打开项目”。

## 产品规则

1. 课堂启动由 Main 作为唯一事实源，同时透传：
   - `initialWorkspacePath`
   - `initialWorkspaceIdentity`
   - `initialWorkspacePurpose = project`
2. Renderer 必须把三项参数一并传给 Root；不得丢弃 identity 或用路径重新构造身份。
3. 存在课堂初始 workspace identity 时，恢复逻辑不得创建或激活默认会话工作区：
   `{dataBaseDir}/.zcode/workspace/default`。
4. 课堂模式侧栏必须把当前课堂工作区归类为项目；即使持久化数据缺失或错误地标成
   `conversation`，过滤后也只能进入项目区，不能显示“尚未打开项目”的任务/会话区。
5. 课堂任务必须运行在当前课堂工作区；默认会话工作区只作为历史错位任务的提交兼容根目录。
6. identity 缺失时保持旧启动行为，不阻断应用启动；提交侧继续使用受控双目录 allowlist。
7. `workspaceIdentity` 只是工作区隔离键，不能单独证明工作区是远端。只有以下任一条件成立时，
   Renderer 才能进入远端 waiting/ready 语义：
   - `remoteSessionId` 存在；
   - `remoteTarget` 存在；
   - `workspaceIdentity` 能被 `@zcode/shared` 的远程 identity 解析器识别。
8. 课堂本地 identity（如 `user_...:csession_...`）必须继续使用 base Local Host services，
   不得显示“远端未连接”，也不得阻止新建任务、打开项目或挂载对话 pane。

## 所有权与事件顺序

```text
平台登录成功
  -> Main 计算 classroom workspacePath + workspaceIdentity
  -> resolveStartupWindowBootstrap()
  -> createWindowInstance()
  -> WindowBootstrapOptions
  -> renderer URL flags
  -> Root initialWorkspaceAbsPath + initialWorkspaceIdentity + project purpose
  -> 恢复历史 tabs
  -> addTab/activate classroom workspace
  -> Agent 使用课堂 workspace 作为真实 cwd
```

- Main 拥有课堂 workspace 路径与身份。
- Renderer 只消费启动参数，不重新计算课堂身份。
- 默认会话工作区不是课堂事实源，不得覆盖课堂 active workspace。

## 验收

1. `ZCODE_LINGDONG_WORKSPACE_PATH` 与 `ZCODE_LINGDONG_WORKSPACE_IDENTITY` 同时存在时，
   startup bootstrap 返回课堂 path、identity 与 purpose `project`。
2. renderer 启动参数包含 `initialWorkspaceIdentity`。
3. Root 收到 identity 后，`ensureConversationWorkspaceOnRestore` 不启用。
4. 课堂界面显示当前课堂项目，而不是“尚未打开项目”。
5. 课堂持久化 tab 即使 purpose 为 `conversation`，侧栏过滤后也按 `project` 显示。
6. `pnpm typecheck`、`pnpm lint`、典型平台启动测试通过。
7. 带本地课堂 identity、但没有 `remoteSessionId` / `remoteTarget` 的 workspace 解析到
   `local-ready`，并使用 base services。
8. 只有远程 identity 能构造出 canonical `remote:` identity；普通本地 identity 不触发
   disconnected remote 分支。
