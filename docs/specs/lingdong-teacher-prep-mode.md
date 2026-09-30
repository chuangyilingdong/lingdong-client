# 老师端「VibeCoding 备课」模式

## 一句话

平台网页 / 机构后台点「VibeCoding 备课」→ `lingdong://open?prep=1&lesson=<lessonId>` 拉起客户端 →
客户端用**同一把 token** 取备课上下文 → **进创作环境但把发送入口整个收起来**。

## 深链

- `lingdong://open?prep=1&lesson=<lessonId>`：scheme/host 与既有的 `lingdong://open` 完全一样，只多了两个查询参数。
- 不认这两个参数时按原行为走（当作普通入口链接：只拉起 / 把主窗口带到前台）。
- 前置：安装器注册 `zcode` + `lingdong`；已开启时收到该链接要把主窗口 `show()/focus()`。

## 上下文

- `GET /api/student/runtime/client-context?prep=1&lessonId=<lessonId>`，`Authorization: Bearer <token>`。
- 老师/机构管理员**不带参数也一样**走备课分支（平台按角色判）。
- 备课响应特征：`prep: true`、`classroom: null`、`lesson`、`presets`、`models`、`defaultModel`，
  **没有 `gateway`**（平台故意不发运行密钥，客户端不可能生成内容）。
- 错误：未登录/过期 `401`；课时不属于该机构 `403 COURSE_NOT_ASSIGNED`；课时不存在/未发布 `404 LESSON_NOT_FOUND`。

## 客户端行为

1. **判据只能是 `data.prep === true`**：没开课的学生也是 `classroom: null`，用 `!classroom` 会把学生误判成备课。
2. 备课上下文 `classroom === null` 是**正常形态**，不得停在「老师还没有开始上课」那一档。
3. 工作区独立：`Documents/灵动ai创作/<老师>-备课-<课时>`，与学生课堂目录互不覆盖。
4. **不写 Provider 配置、不注入任何网关密钥**：`providerConfigPath` 留空，`PLATFORM_GATEWAY_KEY` / `PLATFORM_GATEWAY_BASE_URL` 置空。
5. UI：**隐藏发送按钮**（含回车发送），输入框保留，让老师能走一遍学生流程；显示「备课模式 · 不生成」。
6. 学生路径**一个字节都不改**：学生响应没有 `prep` 字段，`prepMode` 恒为 false。

## 不变量

1. 备课模式下不得发出任何上游生成请求（结构上不可能：没有 gateway）。
2. 备课模式不得创建/复用学生会话的工作区与额度桶。
3. 学生（含「老师没开课」的学生）永远不进备课模式。
4. 备课入口链接不触发 workspace / OAuth / 支付 / 分享任何既有动作。

## 验收

| # | 操作 | 期望 |
| - | ---- | ---- |
| 1 | 老师账号登录 | 进创作环境，显示「备课模式 · 不生成」 |
| 2 | 输入并回车 / 找发送按钮 | 没有发送按钮，也没有任何网关请求 |
| 3 | 后台点「VibeCoding 备课」 | 客户端被拉起或带到前台并进备课模式，显示该课时标题 |
| 4 | 学生账号 + 老师已开课 | 与现在完全一致：有发送按钮、能生成 |
| 5 | 学生账号 + 老师没开课 | 与现在一致（「老师还没有开始上课」），不是备课模式 |
