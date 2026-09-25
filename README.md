# 灵动ai创作客户端（桌面端）

面向 8–16 岁学生的 VibeCoding 创作客户端：**从上游 DSH 源码自建**，加上我们自己的
登录门、品牌与「只走平台网关」的补丁层。

> ⚠️ **本仓库与「学习平台」仓库是两个仓库、两个工作区。**
> 平台侧（网页 + 服务端 + 账号/课堂/作品）在另一个仓库里；两边通过
> **[`docs/平台接口契约.md`](docs/平台接口契约.md)** 对接 —— 改契约要两边一起改。

## 这个客户端是什么

Electron 壳（`apps/desktop`）+ 完整 dsh Web 应用（`packages/client/*`），
上游 <https://github.com/deepseek-ai/deepseek-harness> 的**一份钉住版本的检出**，
品牌与行为都靠**构建期打补丁**（`deploy/desktop/`）覆盖：

| 层 | 脚本 | 做什么 |
|---|---|---|
| 品牌 | `deploy/desktop/rebrand-client.mjs` | 产品名/安装包名、外壳文案、dsh 界面字标（含**矢量字标**与窗口标题）、应用图标、安装器/卸载器图片 |
| 登录门 | `deploy/desktop/apply-client-gate.mjs` | 把 `client-patch/` 接进检出：登录门主进程逻辑、`preload` 的 `window.lingdong`、`main.ts` 里的过门顺序、深链 `lingdong://`、宿主的 `patchFiles` |
| 产物 | `deploy/desktop/publish-client.sh` | 安装包传到平台服务器的下载目录 + 置回清单 + 从服务器侧核验 |

## 钉住的上游版本

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/deepseek-ai/deepseek-harness.git` |
| 提交 | `00102833dfaee1da9f48a3a8eae9d34005a75218`（tag **`dsh-v0.1.7-alpha.2`**） |
| 版本 | `0.1.7-alpha.2` |
| 检出位置 | `upstream/dsh-harness/`（**gitignore**，体积大、含构建缓存，不要提交） |

升级上游时：改上面这个提交号 → 重跑两个补丁脚本 → 出包 → 在真机上过一遍登录/上课链路。
补丁脚本的每一处锚点都会打印命中情况（`!!` 表示上游漂了，要人看一眼）。

## 出包（Windows）

```bash
# 0) 新机器：先把上游拉到 pin 并打补丁（已有 upstream/ 就跳过）
node deploy/desktop/rebrand-client.mjs --checkout upstream/dsh-harness
node deploy/desktop/apply-client-gate.mjs --checkout upstream/dsh-harness

# 1) 打包（⚠️ 顺序不能反：先 rebrand 再 gate；打包约 30 分钟）
cd upstream/dsh-harness
export PATH="/c/Program Files/nodejs:/c/WINDOWS/system32:$PATH"   # node≥22；bsdtar（见「坑」）
export LINGDONG_BUILD_ROOT=.desktop-build2                        # 复用构建缓存
pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:unsigned
# 产物：apps/desktop/.desktop-build2/targets/win-x64/unsigned-artifacts/lingdong-client-*.exe
```

**打不通 GitHub release 资产时**（本机实测会卡在 `prepare:runtime` 的 `fetch failed`）：
用 `scripts/electron-mirror.mjs` 离线出包 —— 见 `docs/交接-客户端-20260919.md` §三。

## 本地跑起来验证（不用出包）

```bash
export ELECTRON_OVERRIDE_DIST_PATH=<检出>/apps/desktop/.desktop-build2/targets/win-x64/electron
export LINGDONG_API_BASE=http://127.0.0.1:<平台端口>   # 登录门照这个地址要 client-context
export DSH_HOME=<隔离目录>                             # ⚠️ 别用真的 ~/.dsh
pnpm --filter @deepseek-ai/dsh-desktop run start       # --skip-build：用已编好的 lib/
```

## 守卫

```bash
node scripts/p116-client-gate-ui.mjs      # 门三页：图片真解码 / 表单契约 / 版式不相交 / 窄窗让位
```

（平台侧的守卫 —— 网关、发送次数、作品上传 —— 在平台仓库里，它们的口径见契约文档。）

⚠️ 守卫要 `playwright-core`（无依赖，纯 JS）与 Chrome。**本机 npm registry 打不通**，
所以 `node_modules/` 是从平台仓库拷来的一份（已在 `.gitignore` 里）：
`cp -r "E:/学习平台正常/node_modules/playwright-core" node_modules/`。
能上 registry 时用 `pnpm add -D playwright-core` 更干净。

## GitHub

远端已经建好并推送，当前 `main` 与 `origin/main` 同步：

```text
origin  github.com-peixunwangzhan-local:chuangyilingdong/lingdong-client.git
```

不要重复创建仓库。需要发布安装包时，走 `deploy/desktop/publish-client.sh`，且发布前先确认。

## 现在到哪一步了

侧栏预设、交作品、窗口标题、内测声明移除、安装器/卸载器全品牌图片都已完成并推送。
2026-09-24 完成 DSH 0.1.7 升级、模型清单适配、登录门窗口修复与旧会话模型迁移；最新**已发布**包 **0.1.7-alpha.2.3**；`0.1.7-alpha.2.8`（反馈十条 + 本地预览 + 完全访问权限）已出包、**未发布**。

### 2026-09-25 本地预览 + 完全访问权限（`0.1.7-alpha.2.8`，未发布）

- 侧栏「浏览器」打不开本地预览（学生做出网页却看不了）两层根因都修了：
  1) 它有个「本地回环白名单」默认留空 = 本机地址全拦 → `lingdong.patch.yml` 里放行 `127.0.0.1/localhost`；
  2) 更关键：`dsh-better-sidebar@0.19.1` 的偏好层用的是 0.1.6 的 `settings.register`，**0.1.7 已没有这个方法**，
     整个偏好面失效、客户端永远拿默认值 → 构建期 vendor 补丁把它退化成「只读、以随包 config 为准」
     （`prepare-dsh.ts` 的 `patchSidebarPrefs()`；锚点漂了直接让构建失败）
- 恢复「完全访问权限」并设为默认（上游 base 本来就有这一档，之前被我们的补丁删掉了）
- 实测：侧栏浏览器加载 `http://127.0.0.1:8765` 成功（iframe 内正文 `LINGDONG-PREVIEW-OK`）；新会话访问模式显示「完全权限」
- 安装包 `489956760` 字节 / SHA256 `8C51B79A33CA0F210B8B626913F60F8244FE7710DE3A7210423158C7625EB4E5`
- 产物：`.tmp\dsh-0.1.7-alpha.2\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\lingdong-client-0.1.7-alpha.2.8-win-x64-unsigned.exe`

### 2026-09-25 学生端反馈十条（`0.1.7-alpha.2.6`，未发布，已被 .2.8 取代）

- ① 开「技能中心」（dsh-web 的 opt-in 行）② 关「远程配对/远程控制」面板（完全控制凭据）
- ③ 数据目录修好：profile 不再落到共享 `~/.dsh`，与 sessions/凭据同用 `userData/dsh-home`
- ⑤ 去掉「上下文洞察」（dsh-context）⑥⑦ 账号名/退出登录与底部头像合并成一行，「意见反馈」随之消失
- ⑧ 侧栏工作区树只显示当前课堂，旧课堂目录与会话不再出现
- ⑨ 运行文案「深度求索中」→「小灵VibeCoding中」
- ⑩ 补齐 0.1.6 旧图标名别名（`IconXxx16/14` → `*Medium`），修第三方插件 React #130（右侧面板打不开）
- 安装包 `489955876` 字节 / SHA256 `4A21DABCB1AFA3A9D8089932E1C4B8366FE86160722694B1635F8D3034C07FF3`
- 产物：`.tmp\dsh-0.1.7-alpha.2\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\lingdong-client-0.1.7-alpha.2.6-win-x64-unsigned.exe`

### 2026-09-25 修「新建会话 / 技能中心 403」（`0.1.7-alpha.2.5`，未发布，已被 .2.6 取代）

- 根因：`@linxin666/dsh-web-all` 里的 `@linxin666/dsh-remote-web-ui` 会注入 boot 钩子，把同源的
  `/api`、`WebSocket` 改写成 `/remote/...`（配对通道）；它只在页面主机名是回环时豁免。
  桌面壳原来用 `dsh-app://app`（hostname=`app`），钩子于是装上、所有本地 API 返回 403 `unpaired`
- 修复：桌面壳应用源改为回环形 `dsh-app://127.0.0.1/`（preload / IPC / 转发层判定同步改）
- 实测：`POST /api/session/create` → 200、`GET /api/pair/status` → 200、无 console error、
  侧栏会话列表与「使用次数5/5」正常
- 安装包 `490136681` 字节 / SHA256 `47D075EF37E9AE49B1385926B2F09061A3CEB500F365444167585D77EE6E60D0`
- 产物：`.tmp\dsh-0.1.7-alpha.2\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\lingdong-client-0.1.7-alpha.2.5-win-x64-unsigned.exe`

### 2026-09-24 预装插件版（`0.1.7-alpha.2.4`，未发布，已被 .2.5 取代）

- 预装 7 个第三方插件（dsh-web 聚合包、better-sidebar、at-file、find-plugin、modlens、context、browser bridge），
  随包一份闭包放 `resources/runtime/plugin-profile`，首次启动镜像成 profile 里的真实目录（硬链接，约 26 秒，之后跳过）
- `dsh-at-file@0.6.3` 与 DSH 0.1.7 的 settings API 不兼容（`settingsNamespace` 已换成 `SettingsForms`），
  宿主日志会打 `failed to import`，该插件的 @ 文件功能不生效；modlens 只丢设置页
- 修复 todo：`turn/end(completed)` 时把还挂着的 todo 收口，界面不再停在「N 进行中 · M 待处理」
- 发送次数：`used >= limit` 时客户端直接禁用发送按钮 + 拦住 Enter 提交（平台网关 429 仍是唯一门禁）
- 安装包 `490182000` 字节 / SHA256 `9E5C1A5A4AB70190A41A5FAB47E71171F453159BEC2F4DBDC5C19D320E05FF6D`
  （含插件闭包 388 MB；`.2.3` 是 396 MB）
- 产物：`.tmp\dsh-0.1.7-alpha.2\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\lingdong-client-0.1.7-alpha.2.4-win-x64-unsigned.exe`

### 2026-09-24 发布包

```text
E:\灵动ai客户端\.tmp\dsh-0.1.7-alpha.2\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\lingdong-client-0.1.7-alpha.2.3-win-x64-unsigned.exe
```

- 大小：`395987312` 字节
- SHA256：`61575D5D7108166EA4E8505250A3C450AE50E38CCB113F8BA49D1880D274EFF3`
- 状态：未签名、**已发布**（2026-09-24）
- 下载：<https://aicyld.com/downloads/lingdong-client-0.1.7-alpha.2.3-win-x64-unsigned.exe>
- 客户端版本独立于 DSH 基础版本；DSH 运行时为 `0.1.7-alpha.2`
- 平台 `client-context.models / defaultModel` 下发后，客户端动态渲染模型别名并同步默认模型
- 修复登录门窗口一直隐藏的问题（`.2.2` 起登录/等待/选课页会正常显示）
- 修复旧会话仍选择 `deepseek-official` 导致 `MISSING_CREDENTIAL`（`.2.3` 自动迁回平台网关）
- 服务器下载目录仅保留最新包，旧包 URL 已返回 404
- 关闭 `session-telemetry-otel` 与 `session-log-deepseek`
- 默认权限改为 `workspace-write`，不再默认完全权限
- 网关密钥只走环境变量，不再写 agent 可读的 `.credentials.yaml`
- 登录态使用 Electron `safeStorage` 加密；会话/缓存放到应用自己的 `userData/dsh-home`
- 侧栏和交作品按当前课堂工作区隔离
- 每个课堂用独立工作区标记，避免同名学生/同名课时复用旧目录
- 交作品识别更多文件类型；平台尚不支持的类型会显示但不可提交
- HTML 预览支持本地图片/媒体打包并禁止外部网络连接
- 更新器只接受平台同域 HTTPS 下载地址，校验固定文件名、大小和 SHA256
- 发布脚本禁止同版本覆盖发布，并核对远端 SHA256
- 卸载时可选清理本机登录凭据与聊天记录，学生作品目录不自动删除

当前状态详见 [`docs/交接-新对话-20260920.md`](docs/交接-新对话-20260920.md)。