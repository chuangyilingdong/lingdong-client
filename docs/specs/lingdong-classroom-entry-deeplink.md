# 课堂入口深链（平台网页 → 客户端）

## 背景

平台「灵动学习」页的 **进入 VibeCoding 课堂** 按钮是 `<a href="lingdong://open">`；
`lingdong` 是 DSH 时代定的 scheme，换 ZCode 底座后客户端只注册了 `zcode`，
于是装了新客户端的机器点按钮毫无反应。

## 契约

- **客户端必须同时注册 `zcode` 与 `lingdong` 两个 scheme**（安装器 + 运行时都要）。
- `lingdong://open` 是**入口链接（entry ping）**：它不携带工作区、不携带凭据，
  客户端**不得**由它推导出任何动作；正确行为是
  1. 未启动 → 拉起客户端，走正常启动（登录门 → 平台登录 → `client-context` → 进课堂）；
  2. 已启动 → 把主窗口带到前台，不重启、不重新登录。
- `zcode://workspace/open`、支付回调、OAuth 回调、分享导入的语义**不变**。

## 状态所有者

- **scheme 归属**：`packages/desktop/electron-builder.config.js` 的 `protocols[].schemes`（安装期）
  与 `packages/desktop/src/main/desktopOAuthDeepLink.ts` 的 `registerDeepLinkProtocol`（运行时）。
  两处必须一致，缺一处都会出现「装得上、点不动」或「点得动、装不上」。
- **深链动作裁决**：`handleDeepLink`（`desktopOAuthDeepLink.ts`）是唯一裁决点；
  不认识的 URL 返回 `false`，不报错、不弹窗。
- **窗口聚焦**：`packages/desktop/src/main/index.ts` 的 `focusPrimaryApplicationWindow()` 是唯一实现，
  由 `second-instance`（Windows/Linux）与未处理的 `open-url`（macOS）共用。

## 事件顺序

```text
客户端未启动
  浏览器 → 系统按 scheme 拉起客户端 → argv 带 lingdong://open
    → 不命中任何已支持动作 → 正常启动流程（登录 / client-context / 课堂）

客户端已启动
  浏览器 → 系统拉起第二实例 → 单实例锁转发 argv 给在跑实例
    → handleDeepLink 不命中 → focusPrimaryApplicationWindow()（restore/show/focus）

macOS 已启动
  open-url(url) → handleDeepLink 不命中 → focusPrimaryApplicationWindow()
```

## 不变量

1. `lingdong://open` 在任何路径下都**不得**触发工作区打开、OAuth、支付或分享动作。
2. 已启动时点击入口链接：进程不重启、不重新登录、不新建窗口。
3. 未启动时点击入口链接：表现为「普通启动」，不得出现任何选课堂 UI。
4. scheme 注册列表在安装器与运行时两处保持一致。

## 失败语义

- 系统里 `lingdong` 被别的程序抢了默认处理器 → 会打开别的程序；客户端不做抢占式纠正。
- 浏览器/第三方外壳对自定义协议弹确认框 → 属正常前置，客户端侧无感知。
- URL 解析失败 / 未知 host：记 warn 并忽略，不阻断启动、不影响当前会话。

## 验收

1. 打包产物安装后，`HKCU\Software\Classes\lingdong`（Windows）与 Info.plist `CFBundleURLTypes`（macOS）都含新客户端。
2. 打包态启动日志里出现 `zcode` 与 `lingdong` 两条协议注册记录。
3. 在已运行实例上再拉起带 `lingdong://open` 的第二实例：主进程不重启、主窗口仍在（单一实例锁生效）。
4. `pnpm typecheck`、`pnpm lint`、平台测试与打包态 E2E 通过。
