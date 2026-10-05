# 灵动ai / 小灵品牌文案

## 背景

客户端迁移自 ZCode 底座后，部分用户可见文案仍显示 `ZCode`。对话空态还会按时间显示“早上好/晚上好”等文案；Agent 身份提示词也仍是 `You are ZCode`，导致学生问“您好”时模型自称 ZCode。

## 品牌规则

1. 产品名统一使用“灵动ai”；英文使用 `Lingdong AI`。
2. 助手人设名统一使用“小灵”；英文使用 `Xiaoling`。
3. 对话空态所有时段（清晨、上午、中午、下午、晚上、深夜及 office 模式）统一显示：
   `小灵陪您一起VibeCoding`。
4. Agent system prompt 必须声明助手是小灵，并明确禁止自称 ZCode。
5. 用户可见 UI、菜单、TUI/CLI 帮助、插件显示名/描述、About、反馈标签和内置技能文案不得再出现 `ZCode`。
6. 内部标识不迁移：`@zcode/*` 包名、`ZCODE_*` 环境变量、协议名、IPC/命令 ID、文件路径和数据根保持原样。

## 所有者与边界

- UI 文案唯一所有者是 `packages/ui/src/i18n/locales/`。
- 桌面窗口/About/CUA 文案在对应 desktop 文件内维护。
- Agent 身份唯一来源是 `apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts`。
- 子代理和 workflow prompt 可以保留自身职责，但不得把产品身份写成 ZCode。

## 失败语义

- 用户可见文案中的 `ZCode` 视为回归；不得用字号、颜色或编码绕过。
- 空态问候不得再按时间显示不同产品文案。
- 内部包名/协议名不属于品牌文案，测试必须按文件白名单校验，不做全仓机械替换。

## 验收

1. 中文空态所有时段都显示“小灵陪您一起VibeCoding”。
2. 新会话发送“您好”时，system prompt 明确要求回答助手名“小灵”，不得自称 ZCode。
3. UI/CLI 文案白名单文件不再包含 `ZCode` 字面量。
4. `pnpm typecheck`、`pnpm lint`、`pnpm test:platform`、`pnpm architecture:check --changed` 通过。
5. 构建并发布 Windows/macOS 双平台 0.2.6 正式包。
