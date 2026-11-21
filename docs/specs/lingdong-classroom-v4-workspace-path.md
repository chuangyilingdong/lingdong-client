# 课堂 V4 createSession 工作区路径透传

## 背景

课堂本地工作区同时有两个事实：

- `workspaceIdentity`：隔离键，例如 `user_...:csession_...`。
- `workspacePath`：真实 Windows 目录，例如
  `...\刘学生-画布创作-...-csession_...`。

V4 `createSession` 只携带 `workspaceId` 时，课堂本地 identity 会被 CLI 当成
`workingDirectory`。该 identity 含有 Windows 不允许出现在目录名中的冒号，导致 Bash、
node_repl MCP 和 Browser Use 启动子进程时统一报
`spawn ... ENOENT`。侧边栏自动预览依赖 Browser Use 事件，因此也被同一条错误路径阻断。

## 所有权

- Renderer 的 workspace scope 拥有并透传 `workspaceIdentity` 与 `workspacePath` 两个事实。
- V4 `createSession` payload 同时携带：
  - `workspaceId`：身份键，保持 `workspaceIdentity?.trim() || workspacePath`。
  - `workspacePath`：文件操作、命令 cwd、Git 和路径展示使用的真实目录。
- CLI `resolveWorkspaceRefFromId()` 只负责把协议事实还原为 workspace ref，不推断或拆分 identity。

## 产品规则

1. 所有 V4 `createSession` 入口都必须携带真实 `workspacePath`，包括草稿预热、首条发送和
   附件待提交的 fallback 创建路径。
2. 本地课堂 identity 的 `workspaceKey` 仍是 identity，用于会话索引、队列和隔离；
   `workingDirectory` 必须是 `workspacePath`。
3. 远程 identity 继续由 shared parser 解析远端路径；显式 `workspacePath` 优先。
4. 普通本地工作区无 identity 时，`workspaceId` 与 `workspacePath` 都是该绝对路径。
5. 非远程 `workspaceId` 既不是绝对路径、又没有显式 `workspacePath` 时必须 fail-closed，
   不得把隔离键当作目录继续启动子进程。
6. 旧客户端未携带 `workspacePath` 时保留绝对本地路径和合法远程 identity 的兼容路径；
   非法本地 identity 返回明确错误，而不是误导性的 `bash.exe ENOENT`。

## 事件顺序

```text
Renderer workspace scope
  -> createSession { workspaceId = identity | path, workspacePath = path }
  -> CLI createSession handler
  -> host.createSessionRecord
  -> resolveWorkspaceRefFromId(workspaceId, workspacePath)
  -> session.workspaceKey = identity
  -> runtime.workingDirectory = workspacePath
  -> Bash / node_repl MCP / Browser Use use the same valid cwd
  -> Browser Use reveal event opens the right side pane
```

## 失败语义

- `workspacePath` 为空或缺失且 `workspaceId` 不是合法绝对本地路径/远程 identity 时，
  `createSession` 在创建 record 前失败。
- 子进程启动失败不得再被解释为 Git/Bash 未安装。
- `workspaceIdentity` 不得进入日志凭据、命令路径或持久化目录名。

## 验收

1. V4 `createSession` schema 保留 `workspacePath`。
2. 草稿预热和三条首发/fallback 创建路径都发送 identity 与真实路径。
3. 本地 identity + 路径解析为 same `workspaceKey`、correct `workspacePath`。
4. 本地 identity 无路径时不创建会话，并返回明确协议错误。
5. 远程 identity 继续解析为远端路径；显式路径优先。
6. 课堂 E2E 中 Bash 可启动、node_repl/Browser Use 可连接，预览侧栏能收到自动展开事件。
