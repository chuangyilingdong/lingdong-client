# 课堂作品预览与 worksLlm

## 背景

平台在 `client-context` 与学生作品详情中新增 `worksLlm: { grant } | null`。学生作品仍通过
`POST /api/llm` 调用模型；带 grant 的预览文档必须优先走平台代理，未带 grant 时保持学生自填
Key 的旧行为。

## 所有权

- `packages/desktop/src/main/lingdongPlatformGate.ts` 是 `client-context.worksLlm` 与平台
  token 的唯一所有者。
- `packages/shared/src/vibecodingProject.js` 只负责把文件拼成预览 HTML，并把 grant/桥注入文档。
- `lingdongWorkPreviewServer.ts` 拥有短期预览 token、静态素材映射和平台 API 代理；renderer
  只拿不可推断的本地预览 URL。
- `IClassroomPlatformService.prepareWorkPreview` 是 renderer 请求预览的唯一入口。
- grant 不进入 renderer、日志、崩溃上报或本地持久化；snapshot 只暴露 `worksLlmAvailable` 布尔值。

## 产品规则

1. 课堂内打开 HTML 文件预览时，由 Main 读取入口及引用文本文件，调用
   `buildPreviewDocument(files, entry, { worksLlm })` 生成文档。
2. 作品显式写 `usePlatform: false` 时才使用学生自己的 Key；有 grant 时默认平台优先。
3. `worksLlm` 为 null 时仍生成预览文档，但桥走旧的 BYO-Key 路径。
4. 学生已提交作品通过 `GET /api/student/works/VIBECODING/:id` 读取 `files`、`entryFile`、
   `worksLlm`，再由 Main 生成预览 URL。
5. 预览服务只监听 `127.0.0.1`，预览 token 有 TTL 和数量上限；静态素材只能读取入口工作区或
   已提交文件映射。
6. `/api/*` 与 `/platform/api/*` 只代理到平台 API；平台请求使用 Main 持有的 token，不把 token
   交给页面。
7. 预览失败必须回退原文件 URL，不能阻断普通文件打开或作品提交。

## 事件顺序

```text
Renderer 请求打开课堂 HTML
  → Main 校验路径属于当前课堂工作区
  → 读取 files + worksLlm
  → buildPreviewDocument(files, entry, { worksLlm })
  → 创建短期本地预览 URL
  → 内嵌浏览器加载文档
  → 作品 fetch('/api/llm')
  → LLM_BRIDGE 使用 grant 请求本地 /platform/api/works-llm/chat
  → Main 预览服务带平台 token/grant 转发
```

## 验收

- `client-context.worksLlm` 有 grant 时 snapshot 只显示 `worksLlmAvailable: true`，日志不含 grant。
- 课堂 HTML 预览包含 `window.__PLATFORM_WORK_LLM__` 和最新 LLM 桥；无 grant 时不注入授权。
- 作品显式 `usePlatform: false` 时仍使用学生自己的 Key。
- 学生作品详情的 `worksLlm` 能进入对应预览文档。
- 预览服务拒绝越界静态文件，预览 token 过期后返回 404。
- 普通非课堂文件打开、作品提交、自动补交行为不变。