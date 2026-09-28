# 灵动ai创作客户端（ZCode 底座）

灵动ai创作客户端基于 [ZCode](https://github.com/zai-org/ZCode) 桌面 Agent 工作台构建，并接入灵动ai平台账号、课堂、模型网关、发送次数和作品提交链路。

## 当前架构

- Electron Desktop：`packages/desktop`
- Agent / Host / Session / Workspace：ZCode workspace packages
- 模型网关：平台 `client-context.gateway`
- 平台登录入口：`packages/desktop/src/main/lingdongPlatformGate.ts`
- 登录 preload：`packages/desktop/src/preload/lingdongGate.ts`
- Provider 配置：登录成功后在进程临时目录生成，仅包含平台受管 Provider
- 平台契约：`docs/平台接口契约-zcode.md`

客户端启动顺序：

```text
启动 Electron
  → 灵动ai 平台账号登录
  → 获取当前课堂 client-context
  → 创建课堂工作区
  → 生成 lingdong-platform-gateway Provider
  → 启动 ZCode Host / Agent
  → 打开 ZCode 工作区
```

## 平台联动

平台继续提供：

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/student/runtime/client-context`
- `POST /api/student/runtime/submit-upload`
- `GET /api/student/works?page=1&limit=20`

模型调用统一使用平台下发的 OpenAI Chat Completions 兼容网关，不依赖客户端内置的 Z.ai/BigModel Provider。

完整字段、流式 tool call、usage/cache token、耗时日志和平台待办见 `docs/平台接口契约-zcode.md`。

## 本地开发

环境要求：Node.js 24、pnpm 10。

```powershell
$env:PATH='C:\Program Files\nodejs;'+$env:PATH
pnpm install --ignore-scripts --offline
pnpm typecheck
pnpm --filter @zcode/desktop build:no-runtime-assets
```

开发运行：

```powershell
pnpm dev:desktop:test
```

启动后先显示灵动ai平台登录窗口；登录成功并存在课堂后才启动 Agent 工作区。

## 构建

Windows：

```bash
bash scripts/build-win.sh
```

macOS Apple Silicon：

```bash
bash scripts/build-mac-arm64.sh
bash scripts/build-mac-arm64.sh --unsigned
```

底层打包入口是：

```bash
pnpm --filter @zcode/desktop run bundle -- --os win --arch x64
pnpm --filter @zcode/desktop run bundle -- --os mac --arch arm64
```

## 发布

发布仍然保持现有下载 manifest 和原子双端发布机制：

```bash
bash deploy/publish-client.sh <Windows exe> <macOS dmg>
```

发布前必须由用户明确确认；当前迁移分支不会自动发布。

## 迁移边界

本分支不再使用 DSH 的源码检出、Cordis patch、DSH profile、DSH 插件闭包或 DSH 构建脚本。所有客户端能力应通过 ZCode 的 Host/Service/Provider/UI 边界实现。
