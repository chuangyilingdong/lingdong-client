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

## 失败语义

- 快照读取失败时 UI 回退到现有 ZCode 账号显示和模型名，不阻塞对话或发送。
- 平台模型映射缺失时显示原始 model id。
- 额度文件缺失时显示 `0/不限` 之前先按 `limit=null, used=0` 处理，不提示错误。
- 登录页资源缺失时必须回退到内联登录页，不能出现白屏。

## 验收

- 独立数据根启动时，侧栏显示平台学生 `displayName`，不显示官方 ZCode 账号。
- `displayName=Mock Model` 时，模型触发器显示 `Mock Model`，不显示 `灵动ai 平台网关/mock-model`。
- `sends.limit=10, used=0` 时显示 `0/10`；发送一轮后显示 `1/10`。
- 预置其他工作区历史时，课堂模式侧栏不展示这些工作区。
- 登录页加载 `resources/gate/login.html`，包含 DSH 品牌资源并沿用 mock 登录选择器。
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
