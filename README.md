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
| 提交 | `477b4f420553e8a52c2fbccc464d7561b239c443`（tag **`dsh-v0.1.7-rc.2`**） |
| 版本 | `0.1.7-rc.2` |
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
2026-09-24 完成 DSH 0.1.7 升级、模型清单适配、登录门窗口修复与旧会话模型迁移；最新**已发布**包 **0.1.7-alpha.2.3**；`0.1.7-alpha.2.9`（坏插件摘除 + 首启预热 + 交付文件绝对路径 + 数据目录改名）已出包、**未发布**。

2026-09-26 已完成 **0.1.7-rc.2 底座移植**（含 `dsh-better-sidebar@0.21.1` overrides）：补丁 dry-run、上游补丁校验、TypeScript 编译、正式出包与桩平台回归均通过。`0.1.7-rc.2.4` 已出包（已被 rc.2.5 取代）；安装包 `420801688` 字节 / SHA256 `D3346AA172172211ED968F7FE6515549364C0458DA8533E11BDF1414B26DAF89`。

本轮继续修复学生端：

- 交作品面板只列出可提交的 HTML/Word/Excel/PPT，JS、SVG、Markdown 等资源不再作为“不可提交文件”占列表（仍会随 HTML 自动收集提交）。
- 课堂过滤按“当前课堂目录 + 课堂开始时间”隐藏旧会话；学生自己新建工作区里的会话照常保留，切到新会话后可正常切回正在跑的任务。
- 移除 `@yuxianglin/dsh-bridge-browser`：桌面包只有桥服务，真正需要单独安装的 Chrome/Firefox 扩展没有随包，学生端会看到“连不上桥”；原生侧栏浏览器不受影响。
- 课堂工作区自动生成自包含网页约定（`AGENTS.md`）：不依赖扩展、外部 CDN 或本机预装库，资源和入口优先使用工作区相对路径。
- Windows 托盘图标改用全新灵动ai图标，不再沿用上游 DeepSeek 鲸鱼。
- 侧栏 HTML 预览修好了：插件的 `/sidebar/html` 路由把沙箱 iframe 读自己的相对资源（`styles.css` / `app.js` / 图片）也当成跨站请求 403 了，
  导致预览只剩一坨没有样式的 HTML；现在只放行“同一个预览路由的静态子资源”，沙箱与 CSP 不变。
  模型侧归因与实测记录在 `deploy/desktop/client-patch/lingdong-sidebar-html-route.mjs` 文件头（Chromium 对沙箱 iframe 子资源打的是 `sec-fetch-site: cross-site`）。
- 发送次数改为**客户端自己算**：按本堂课点击发送按钮的次数（Enter/按钮共用一个 submit 入口，工具轮不计），计数存在本机 `localStorage`、按课堂 id 分键，不再拿平台的 `sends.used` 当显示值（平台曾把 2 次显示成 1 次）。平台网关 429 仍然是最终门禁。

### 2026-09-27 学生端收口（`0.1.7-rc.2.5`，未发布）；安装包 `420751376` 字节 / SHA256 `AA214E62C96E3ECE6CA92CA44CD2ECAD54F32BFE111BC1684C072C0C4AE4DC59`。

体检（打包产物 + 今天真实学生会话日志 + Chromium 复现）后按风险清单做完四件事：

- **关掉插件市场 / 社区插件 / 插件管理器**：聚合包 `@linxin666/dsh-web-all` 插的 `web-ui-market`、`web-ui-community-plugins`、`web-ui-plugin-manager` 默认是开的 —— 学生能一键装 npm / git / dsh-market.com 的第三方插件，也能按行把 `web-ui-remote-web-ui`（手机配对＝完全控制凭据 + cloudflared 公网隧道）打开。现在三行都 `disabled: true`。
- **侧栏预览补齐「像真浏览器」**：除上一版放行相对资源外，再给 HTML 响应注入**内存 Storage 兜底**（不透明源里 `localStorage` 一读就抛，页面 JS 会整段挂掉），并放行预览页自己的 `fetch/XHR`（同路由 GET + `access-control-allow-origin`）。Chromium 沙箱实测：修前 `storage-threw:SecurityError | fetch-fail:TypeError`，修后 `storage-ok:v | fetch-ok:{"ok":true}`。
- **交作品不再漏素材**：扫 `.js/.mjs/.cjs/.jsx`（含内联脚本）里的字符串路径（`img.src='a.png'` / `fetch('data.json')`），只有真落盘的文件才收集与改写，取不到的字面量不进「本地缺失」；提交结果里再提示「主产物同目录还有哪些素材没随作品提交」（平台只存得下图片，音视频/字体会变空）。
- **打开文件没有冷启动窗口了**：新增同步 IPC `lingdong:classroom-context-sync`，`openFile` 在调用栈里就拿到课堂工作区根，不会再退回相对路径触发 `fs-error` / 「在文件管理器中显示」静默失败。
- 摘掉 `dsh-find-plugin`（只给模型加了个搜 GitHub 插件的工具，学生用不到，网络不通就是一次报错），并写进「已摘掉」名单以便升级时清掉旧 entry。

### 2026-09-27 交作品降噪 + 关客户端不再掉登录（`0.1.7-rc.2.9`，未发布）。安装包 `430369071` 字节 / SHA256 `B663DA6B84C9809F557C48925C5474F1C54A31C8DB78051C69C51301F9FAB6BA`。

**交作品面板不再“一次识别出好多好多”**（学生反馈）：

- 默认只看**本节课**（会话 cwd 落在当前课堂工作区里）；其它课堂 / 目录的历史作品收进「显示其它课堂的历史作品（N）」折叠，默认不展开、不勾选。
- 默认只勾**模型交付**（`present`）的文件；没有交付记录时只勾最近 1 份。模型写过的其它文件仍可手动勾选。
- 过滤中间产物：`backup/bak/old/copy/副本/草稿/draft/test/spec/tmp/wip`、`tmp/temp/backup/cache/node_modules/.git` 目录不进候选。
- 每条标「模型交付 / 生成的文件 / 工作区文件 + 相对时间」，历史项额外标「历史作品」；收起历史时自动取消勾选（避免“看不见却被提交”），另加「清空」。
- 修掉「已提交」误判：原来只按**文件名**匹配，同一节课里两份 `index.html` 会互相覆盖；现在按“标题（会话名 + 主产物名）+主产物名”匹配，老记录才退回文件名（且要求唯一）。
- 课堂 `AGENTS.md` 增加约定：作品完成后用 `present` 交付入口文件 —— 让“模型交付”这个信号稳定。

**关闭客户端不再要求重新登录**（学生反馈）：

- 根因三条：① `writeSession` 在系统加密不可用时**直接删掉**已保存的登录态；② `readSession` 在凭据库尚未就绪时把“解不开”当成“没登录”；
  ③ 启动时只要**一次网络抖动/超时**就 `writeSession(null)` 把学生踢回登录页。
- 还有一条：**下课**（平台说没有可进课堂 / 网关说没有可用课堂）时以前会 `clearLoginState()`，现在只重启回等待页，登录态保留。
- 现在：加密不可用时落一份 0600 的明文兜底（加密一恢复就自动升级回密文并删明文）；读登录态失败会重试 3 次（每次 600ms）；
  只有平台**明确**说凭据失效（401/403 或 SESSION_SUPERSEDED 等码）才清登录态；网络/超时/5xx 改跳「连不上平台」等待页，点「刷新」即可，不用重新输密码。
### 2026-09-27 交作品带上封面（`0.1.7-rc.2.8`，未发布）。安装包 `430365100` 字节 / SHA256 `288533F1890C91CC8AFBDA3B87AC49F6BCA53CB5F0E870E86CEF9D0F0CCE7B6B`。

平台（2026-09-27）新增可选字段 `cover: { content: "<base64 PNG>" }`，客户端现在会给**网页作品**自动截一张封面：

- 采集方式：**临时回环 HTTP 服务 + 隐藏离屏窗口**（1280×720）。为什么不用 `file://`：学生页面常带 ES Module / `fetch`，
  `file://` 下会被直接拒掉导致截出白屏；走回环服务就跟真正浏览器一致。
- 节奏：`load` 完成后再等 450ms（首帧为空会重试一次）；PNG 超 1.5MB 先缩到 1024×576，还超就**不传封面**。
- 三条纪律全部兑现：不传也能交；超限/拿不到/超过请求上限都只丢封面不拦提交（带 12s 采集超时，页面死循环也卡不住交作品）；
  Word / Excel / PPT 不截图（平台自己出预览）。
- 真机验证：用 Electron 44 跑了两个用例 —— 正常页面 790ms 拿到 1280×720 / 181KB PNG（CSS、中文字体、子资源均正常）；
  死循环页面 45ms 就放弃并返回 undefined（不会把提交卡死）。
### 2026-09-27 学生端收口第二轮（`0.1.7-rc.2.7`，未发布）。安装包 `430363963` 字节 / SHA256 `7FEF2E6729C0665099F3C0CB957953AA65B0741C77894BA5A9A101F48F274824`。

- **侧栏只看当前课堂的会话**：rc.2.3～2.6 只按「课堂开始时刻」过滤，别的课堂 / 别的目录（甚至另一个账号）的历史会话照样显示；现在只保留 cwd = 当前课堂工作区的会话（当前新会话、拿不到 cwd 的保留）。
- **同一台电脑换账号登录不再串号**：
  · 工作区按账号隔离 —— 课堂目录的 `.lingdong-classroom.json` 记 `accountId`，发现是别的账号在用就另开 `学生-登录名-课时` 目录（老目录不动、不迁移，学生旧作品不会看起来“消失”）；
  · 发送次数计数键 = **账号 + 课堂 id**（localStorage），B 账号不再继承 A 的次数（换账号后本地计数从 0 开始，平台网关 429 仍是最终门禁）。
- **登录门补一道预装插件清单保险**：`ensurePreinstalledBundles()`（防「插件包已经镜像进 profile、manifest 清单没更新」导致设计/PPT 视图不挂载）。
### 2026-09-27 设计 / PPT 插件预装（`0.1.7-rc.2.6`，未发布）。安装包 `430361930` 字节 / SHA256 `8B0046609ABE348F416E97D98A0CBF57C14D5FF679334F46FE1BFE17224EFF10`。

把（自家的）iPolloWork DeepSeek Design 套件接进学生端，**只装设计 + PPT**：

- 预装 `deepseek-idesign@0.2.2` + `deepseek-ippt@0.1.2`（进 plugin-profile 闭包，学生端不需要插件市场）；`deepseek-ivideo` 不装 —— 它是唯一带 puppeteer-core / onnxruntime-node / sharp 原生依赖的重包。
- 品牌统一成灵动ai：显示层 `iPolloWork` → `灵动ai`、`DeepSeek iDesign / iPPT` → `灵动ai 设计 / 灵动ai PPT`、`DeepSeek Harness` → `灵动ai`，视图标签 `Design` → `设计`；模板里 21 + 4 个 `assets/ipollowork-logo.svg` 换成灵动ai 标记。只改显示层：路由 `/ipollowork-*`、频道名、模板 id `ipollowork.*`、CSS 变量 `--ipw-*`、代码标识符（`iPolloWorkState` 等）与 LICENSE / README 原文都不动。
- 兼容性核查（基线 = 0.1.7-rc.2）：宿主半区 `inject: ["webServer", "workspaceRegistry"]` 两个服务都在；
  宿主只依赖 Node 内置模块；客户端半区只注册 `conversation.view` 槽位；
  Ask AI 只调 `setDraft()` 把提示词填进输入框 → 仍走我们的 `submit` 闸门（发送次数不会被绕过）；
  PPT 的 PDF / PPTX 导出是浏览器端（自带 jspdf / pptxgenjs / html2canvas），不依赖 LibreOffice。
### 2026-09-25 可用性收口（`0.1.7-alpha.2.9`，未发布）

学生实机反馈（图1 次数 8/8、图2「在文件管理器中显示」点了没反应、图3 侧栏预览报 `fs-error`）逐条落地：

- **交付文件预览 / 「在文件管理器中显示」（图2、图3 同一根因）**：DSH 的
  `dsh-resource://file/session/<id>/<相对路径>` 要由渲染端用会话 cwd 拼绝对路径，
  `dsh-better-sidebar@0.19.1` 拿不到 cwd 时把相对路径原样往下送，宿主把 `/index.html`
  按盘根解析成 `C:\index.html` → 预览 400、reveal 静默失败（对运行中的宿主 curl 复核：
  同一 sessionId 相对 400 / 绝对 200）。修法：调用点拼绝对路径（会话 cwd 优先、课堂工作区兜底，
  `client-patch/LingdongWorkspacePath.ts`），reveal 直接走我们的 `lingdong:show-in-folder` IPC。
- **摘掉 `dsh-at-file`**（0.6.3 的 settingsNamespace 在 0.1.7 上 `failed to import`，@ 文件本来就是坏的），
  并让 `enablePreinstalledPlugins()` 会**删**旧 entry（`LINGDONG_RETIRED_PLUGIN_BUNDLES`），
  升级机器上不再每轮刷 failed to import。
- **首启 26–28 秒插件镜像改预热**：在更新检查/登录门之前就开跑，起宿主时再 await，别再让学生干等。
- **数据目录改名**：`%APPDATA%\@deepseek-ai\dsh-desktop` → `%APPDATA%\灵动ai创作客户端`
  （`client-patch/lingdong-user-data.ts`），老机器一次性**原子 rename** 迁移，失败原地退回老目录。
- ✅ **底座升级（0.1.7-alpha.2 → 0.1.7-rc.2 + better-sidebar 0.21.1）**：rc.2 的补丁锚点已全部移植，
  `apply-client-gate.mjs --dry-run`、上游补丁校验、TypeScript 编译和正式出包全部通过；0.21.1 使用
  0.1.7 的 `SettingsForms`，旧 `patchSidebarPrefs()` 兜底已删除。桩平台已验证登录门 → 课堂上下文 →
  `showInFolder(absolute)` → 工具行文件打开（iframe 使用盘符绝对路径、正文 `LINGDONG-RC2-PREVIEW-OK`）
  与旧会话模型 `deepseek-flash`（无 `MISSING_CREDENTIAL`）。
- 安装包 `489513794` 字节 / SHA256 `AA974EE5D2C0FE49B557D404B1D5C54032F169863D38269036961C965C4CD690`
  （比 .2.8 小 ~443KB：摘掉 `dsh-at-file` 的闭包），**未发布**；产物在
  `.tmp\dsh-0.1.7-alpha.2\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\lingdong-client-0.1.7-alpha.2.9-win-x64-unsigned.exe`
- ⚠️ 真机回归未做：首次启动会迁移数据目录（见下），净机器 + 覆盖升级各跑一次再说发布。
- 平台侧「发送次数虚高」的根因与改动清单见 [`docs/平台侧改动清单-发送次数计数-20260925.md`](docs/平台侧改动清单-发送次数计数-20260925.md)（客户端只显示平台给的数，这条要平台仓改）。
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