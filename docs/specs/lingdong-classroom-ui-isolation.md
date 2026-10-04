# 灵动ai 课堂客户端身份、模型额度与工作区隔离 Spec

## 背景

Windows 客户端迁移到 ZCode 底座后，生产运行时仍使用 `ZCode` 作为 Electron 应用名和 `~/.zcode` 作为业务数据根，导致与官方 ZCode 共用 `userData`、配置、会话数据库和工作区历史。UI 也未消费平台快照里的学生账号、模型映射名和课堂发送额度。

## 范围

- 生产与 Preview 客户端必须使用独立的 Electron `userData` 和业务数据根，不与官方 ZCode 共用。
- 课堂模式下，侧栏账号必须来自平台 `auth/login` 返回的学生账号。
- 课堂模式只显示当前课堂工作区及其任务，不显示其他课堂或其他 ZCode 工作区历史。
- 模型触发器对 `lingdong-platform-gateway` 显示平台 `models[].displayName`，不显示内部 Provider 名称。
- 模型触发器显示课堂发送次数 `used/limit`；`limit=null` 显示 `used/不限`。
- 登录页恢复 DSH 版本的品牌视觉；安装器自定义主题另立移植项。

## 状态所有者

- `packages/desktop/src/main/lingdongPlatformGate.ts` 是平台会话、课堂上下文、学生账号、模型映射和额度文件路径的唯一所有者。
- `packages/desktop/src/main/desktopRuntimeEnv.ts` 是应用身份、Electron `userData` 和业务数据根的唯一所有者。
- Renderer 通过 `IPlatformService.classroom.getSnapshot()` 读取只读快照，不接触 token、gateway key 或额度文件。

## 不变量

1. 正式包应用名为 `灵动ai创作客户端`，业务数据根为其独立 `userData`；Preview 同样独立。
2. 官方 ZCode 的 `%APPDATA%\ZCode`、`~/.zcode` 不作为课堂客户端数据根。
3. 平台快照必须包含 `user/login/displayName`、`models[].id/displayName`、`sends.used/limit`。
4. 课堂模式侧栏只保留当前 `workspaceIdentity` 对应工作区。
5. 额度读取只读本机投影；发送审计仍由 `zcodeAgentService` 的 reserve/settle 链路负责。
6. 平台登录门未完成时，任何主窗口创建入口（包括 macOS `activate`、Dock、托盘、深链）都不得创建主窗口或启动 Host/Agent；只能聚焦登录门。只有登录门完成并拿到当前 `client-context` 后，才能创建主窗口。

## 失败语义

- 快照读取失败时 UI 回退到现有 ZCode 账号显示和模型名，不阻塞对话或发送。
- 平台模型映射缺失时显示原始 model id。
- 额度文件缺失时显示 `0/不限` 之前先按 `limit=null, used=0` 处理，不提示错误。
- 登录页资源缺失时必须回退到内联登录页，不能出现白屏。
- 登录门等待期间触发 `activate`：不得复用 `lastWorkspaceSession` 启动旧课堂 Host，不得创建主窗口；保持登录门可见并等待用户完成平台登录。

## 验收

- 独立数据根启动时，侧栏显示平台学生 `displayName`，不显示官方 ZCode 账号。
- `displayName=Mock Model` 时，模型触发器显示 `Mock Model`，不显示 `灵动ai 平台网关/mock-model`。
- `sends.limit=10, used=0` 时显示 `0/10`；发送一轮后显示 `1/10`。
- 预置其他工作区历史时，课堂模式侧栏不展示这些工作区。
- 登录页加载 `resources/gate/login.html`，包含 DSH 品牌资源并沿用 mock 登录选择器。
- 登录门等待期间触发 `activate`：不创建主窗口、不启动旧 workspace Host；登录完成后主窗口使用当前课堂 workspace。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 和现有平台 E2E 通过。

## 2026-09-30 品牌替换补充

- App logo、侧栏折叠 logo、桌面顶部 logo、启动页 HTML/React logo 全部使用灵动ai图标。
- 登录窗使用灵动ai方形图标，并移除原生菜单栏（文件/编辑/视图/窗口/帮助）。
- 停止自动挂载职业/工作方向引导，移除设置页对应入口。
- 对话空态水印改为灵动ai字标；夜间问候改为“小灵陪你一起VibeCoding”。
- 新任务输入框提示改为“向小灵提问，小灵即可开启创造”。
- Windows 未签名构建通过 `rcedit` 在 afterPack 写入白底灵动ai exe 图标/版本资源。
- 课堂模式隐藏普通账户菜单、手机远控和设置按钮；课堂 Footer 直接展示学生账号、课堂预设和退出登录。
- 课堂预设弹窗不再出现 ZCode 文案。

## 2026-09-30 任务栏图标与 updater 目录补充

- Windows 运行时窗口/任务栏图标必须与安装器一致（白底灵动ai方形）：`packages/desktop/src/main/index.ts` 打包态读 `icon_lingdong.png`、开发态读 `build/icon_installer.png`；`iconPath` 不得再回退到透明字标 `icon_windows.png`。
- electron-updater 的更新缓存目录名由 package.json `name` 推导；`extraMetadata.name` 固定为 `灵动ai创作客户端`，对应目录 `%LOCALAPPDATA%\灵动ai创作客户端-updater`，不得再出现 `@zcodedesktop-updater`。
- Windows 打包态启动时调用 `migrateLegacyUpdaterCacheDir()` 迁移旧目录；目标已存在或迁移失败时不得阻断启动。

## 2026-10-04 macOS activate 抢跑登录门修复

现场日志：旧课堂结束后应用 `relaunch` 到登录门，15:18:18 macOS `activate` 事件在主窗口协调器里创建了主窗口，15:18:21 Host 用本地 `lastWorkspaceSession` 启动了旧课堂 workspace，导致学生后续作业落在旧课程目录。

修复规则：

1. `primaryWindowCoordinator.canCreateWindow` 必须在 `isLingdongPlatformGatePending()` 为真时返回阻塞，并只聚焦登录窗。
2. `app.activate`、Dock、托盘和其他入口共享同一阻塞边界；不得各自判断。
3. 登录成功后由既有 `app-ready` 路径创建主窗口，此时 `ZCODE_LINGDONG_WORKSPACE_PATH` 已由当前 `client-context` 注入。
4. 回归测试必须覆盖“登录门等待时 activate 不创建窗口，登录门完成后允许创建窗口”。
