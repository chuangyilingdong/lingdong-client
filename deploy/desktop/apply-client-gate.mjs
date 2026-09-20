#!/usr/bin/env node
/**
 * 把「灵动ai 登录门 + 只走我们网关」接进上游 deepseek-harness 的桌面端检出（2026-09-19）。
 *
 * 为什么是构建期打补丁：我们维护的是**一份钉住版本的上游检出**，改动集中在少数几处，
 * 上游升级时重跑这个脚本即可，冲突一眼可见。与 `deploy/dsh-student/rebrand.mjs` 同一套思路。
 *
 * 改了八处（都能在执行输出里看到是否命中）：
 *   ① apps/desktop/resources/gate/ ← 我们的三个页面 + 补丁层 YAML（随包分发）
 *   ② apps/desktop/src/platform-gate.ts ← 登录门主进程逻辑（新文件，含只读课堂上下文 IPC）
 *   ③ apps/desktop/src/preload-app.ts ← 暴露 window.lingdong.gate() 与 context()
 *   ④ apps/desktop/src/main.ts ← 在 `reconcileBackend()` **之前**插登录门
 *   ⑤ apps/desktop/scripts/electron-builder-config.mjs ← 把 gate/ 打进 extraResources
 *   ⑥ apps/desktop-host/src/index.ts ← `patchFiles` 挂上我们的补丁层
 *   ⑦ packages/client/ui-conversation ← 原生 `conversation.input.dock` 上显示课堂预设块
 *   ⑧ packages/client/ui-conversation ← 原生 `conversation.input.dock` 上显示作品提交与作品回显
 *      （⚠️ 桌面宿主显式传的是空数组，所以 profile 里的 cordis.patch.yml 永远不会被读 ——
 *        根因见 platform-gate.ts 文件头）
 *   ⑨ packages/client/ui-conversation ← 原生 `conversation.input.right` 上显示**发送次数**（`0/20`）：
 *      数字来自平台 `client-context.sends`，客户端只显示不自己计数（口径见 docs/平台接口契约.md）。
 *
 * 用法：node deploy/desktop/apply-client-gate.mjs --checkout .tmp/dsh-harness [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, 'client-patch')
function arg(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback
}
const dryRun = process.argv.includes('--dry-run')
const checkout = resolve(arg('--checkout', '.'))
if (!existsSync(join(checkout, 'apps/desktop/package.json'))) throw new Error(`这不像上游检出：${checkout}`)

const report = []
const write = (file, text) => { if (!dryRun) writeFileSync(join(checkout, file), text); }
/** 精确替换；命中 0 次或已改过都要看得见（上游升级后锚点可能漂）。
 *  ⚠️ `marker` 是**这条补丁的特征串**，用来判断是否已打过 —— 不能用"文件里有灵动ai"这种松散判断：
 *     加新补丁时会被误判成"已打过"而整个跳过（踩过）。 */
const patch = (file, anchor, replacement, note, marker = replacement.slice(0, 60)) => {
  const full = join(checkout, file)
  if (!existsSync(full)) { report.push(`!! ${file}：文件不存在`); return }
  const before = readFileSync(full, 'utf8')
  if (before.includes(marker)) {
    report.push(`·  ${file}：已打过（跳过）`)
    return
  }
  if (!before.includes(anchor)) { report.push(`!! ${file}：锚点没找到 —— ${note}`); return }
  write(file, before.replace(anchor, replacement))
  report.push(`✓  ${file}：${note}`)
}

// ① 随包分发的页面与补丁层
const gateSource = join(patchDir, 'gate')
const gateTarget = join(checkout, 'apps/desktop/resources/gate')
if (!dryRun) {
  mkdirSync(gateTarget, { recursive: true })
  for (const name of readdirSync(gateSource)) copyFileSync(join(gateSource, name), join(gateTarget, name))
  copyFileSync(join(patchDir, 'lingdong.patch.yml'), join(gateTarget, 'lingdong.patch.yml'))
}
report.push(`✓  apps/desktop/resources/gate/：${dryRun ? '（--dry-run 未写入）' : readdirSync(gateTarget).join(' ')}`)

// ② 登录门主进程模块
if (!dryRun) mkdirSync(join(checkout, 'apps/desktop/src'), { recursive: true })
if (!dryRun) copyFileSync(join(patchDir, 'platform-gate.ts'), join(checkout, 'apps/desktop/src/platform-gate.ts'))
report.push('✓  apps/desktop/src/platform-gate.ts：已放入')

// ②b UI：侧栏预设/作品面板 + 会话输入隐藏桥。
// 旧版本把两个面板挂在输入框 dock 上；这里先原地清掉旧 import/plugin/文件，再写新结构。
const workspaceClientDir = join(checkout, 'packages/client/ui-workspace/src/client')
const conversationClientDir = join(checkout, 'packages/client/ui-conversation/src/client')
for (const name of ['LingdongPresetPanel.tsx', 'LingdongWorkPanel.tsx']) {
  const target = join(workspaceClientDir, name)
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(patchDir, name), target)
  }
  report.push(`✓  packages/client/ui-workspace/src/client/${name}：已放入`)
}
const presetBridgeTarget = join(conversationClientDir, 'LingdongPresetBridge.tsx')
if (!dryRun) {
  mkdirSync(dirname(presetBridgeTarget), { recursive: true })
  copyFileSync(join(patchDir, 'LingdongPresetBridge.tsx'), presetBridgeTarget)
}
report.push('✓  packages/client/ui-conversation/src/client/LingdongPresetBridge.tsx：已放入')
// ③d' 发送次数计数条：挂在原生 `conversation.input.right`（契约里写的是
//      「Compact controls before the composer submit action」，上游 InputBar 就在发送按钮前一行渲染它）。
const sendQuotaTarget = join(conversationClientDir, 'LingdongSendQuota.tsx')
if (!dryRun) {
  mkdirSync(dirname(sendQuotaTarget), { recursive: true })
  copyFileSync(join(patchDir, 'LingdongSendQuota.tsx'), sendQuotaTarget)
}
report.push('✓  packages/client/ui-conversation/src/client/LingdongSendQuota.tsx：已放入')
for (const oldName of ['LingdongPresetDock.tsx', 'LingdongWorkDock.tsx']) {
  const oldPath = join(conversationClientDir, oldName)
  if (existsSync(oldPath) && !dryRun) rmSync(oldPath, { force: true })
  if (existsSync(oldPath)) report.push(`✓  packages/client/ui-conversation/src/client/${oldName}：旧文件已清掉`)
}

const updateTextFile = (file, transform, note) => {
  const full = join(checkout, file)
  if (!existsSync(full)) { report.push(`!! ${file}：文件不存在`); return }
  const before = readFileSync(full, 'utf8')
  const after = transform(before)
  if (after === before) { report.push(`·  ${file}：已是最新（跳过）`); return }
  write(file, after)
  report.push(`✓  ${file}：${note}`)
}

// ③a HTML 预览引导层：opaque-origin 沙箱里补内存 localStorage/sessionStorage。
// 上游的 sandbox="allow-scripts" 不能打开同源权限；但生成的网页常把 localStorage
// 当启动前置条件（如打地鼠游戏），直接访问会抛 SecurityError 并让整个脚本白屏。
// 这份覆盖保留原隔离边界，只在沙箱内部提供同形态的内存 Storage。
const htmlPreviewBootstrapTarget = join(checkout, 'packages/client/ui-sidebar-documentpreview/src/client/html/bootstrap.ts')
if (!dryRun) {
  mkdirSync(dirname(htmlPreviewBootstrapTarget), { recursive: true })
  copyFileSync(join(patchDir, 'HtmlPreviewBootstrap.ts'), htmlPreviewBootstrapTarget)
}
report.push('✓  packages/client/ui-sidebar-documentpreview/src/client/html/bootstrap.ts：已补沙箱内存 Storage')

// ③a2 文件卡片：点击“在文件资源管理器中显示”优先直接走桌面 shell 的 reveal IPC。
// 上游默认还要经过本地 Host 路由；这里绕开那条链，避免误触发编辑工具/连接状态导致报错。
const presentedFileCardTarget = join(checkout, 'packages/client/ui-deliverables/src/client/PresentedFileCard.tsx')
if (!dryRun) {
  mkdirSync(dirname(presentedFileCardTarget), { recursive: true })
  copyFileSync(join(patchDir, 'PresentedFileCard.tsx'), presentedFileCardTarget)
}
report.push('✓  packages/client/ui-deliverables/src/client/PresentedFileCard.tsx：已接桌面文件管理器 IPC')

// ③ preload：用一份确定的 window.lingdong 取代旧 gate/context/submitWork 的组合块。
updateTextFile('apps/desktop/src/preload-app.ts', (before) => {
  const block = `contextBridge.exposeInMainWorld('lingdong', {
  gate: (payload: unknown) => ipcRenderer.invoke('lingdong:gate', payload) as Promise<{ ok: boolean; message?: string }>,
  context: (options?: unknown) => ipcRenderer.invoke('lingdong:classroom-context', options) as Promise<unknown>,
  submitWorkBatch: (payload: unknown) => ipcRenderer.invoke('lingdong:submit-work-batch', payload) as Promise<unknown>,
  listWorks: () => ipcRenderer.invoke('lingdong:list-works') as Promise<unknown>,
  showInFolder: (path: string) => ipcRenderer.invoke('lingdong:show-in-folder', path) as Promise<{ ok: boolean; message?: string }>,
})`
  if (before.includes(block)) return before
  const start = before.indexOf("contextBridge.exposeInMainWorld('lingdong', {")
  if (start >= 0) {
    const end = before.indexOf('\n})', start)
    if (end < 0) return before
    return `${before.slice(0, start)}${block}${before.slice(end + 3)}`
  }
  const anchor = "contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' ? product : { protocolVersion: 1 })"
  if (!before.includes(anchor)) return before
  return before.replace(anchor, `${anchor}\n${block}`)
}, '合并为 gate / context / submitWorkBatch / listWorks 桥')

// ③b ui-workspace 契约：新增两个 sidebar 子 slot 与它们的 owner 数据。
updateTextFile('packages/client/ui-workspace/src/client/contract/slots.ts', (before) => {
  let text = before
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (!text.includes('ISessions, SessionListState, SessionSearchResultItem')) {
    text = text.replace(
      "import type { SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'",
      "import type { ISessions, SessionListState, SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'",
    )
  }
  text = text.replace(/  readonly sessions\??: ISessions(?: \| undefined)?/u, '  readonly sessions: ISessions | undefined')
  if (!text.includes('interface LingdongSidebarOwnerProps')) {
    const owner = `${eol}/** 灵动ai 侧栏插件需要的只读会话数据；面板只消费，不接管会话导航。 */${eol}export interface LingdongSidebarOwnerProps {${eol}  readonly sessionId: SessionId | undefined${eol}  readonly sessions: ISessions | undefined${eol}  readonly sessionList: SessionListState${eol}}${eol}`
    text = text.replace('/** The two directory-flow holes;', `${owner}${eol}/** The two directory-flow holes;`)
  }
  const directoryLine = "    'sidebar.workspaces.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }"
  const presetLine = "    /** 灵动ai 平台下发的课堂预设标题区。 */"
  const presetSlot = "    'sidebar.workspaces.lingdongPresets': { kind: 'single'; scope: 'root'; owner: LingdongSidebarOwnerProps }"
  const workLine = "    /** 灵动ai 从有效会话历史里勾选 HTML 的交作品区。 */"
  const workSlot = "    'sidebar.workspaces.lingdongWork': { kind: 'single'; scope: 'root'; owner: LingdongSidebarOwnerProps }"
  const addon = `${presetLine}${eol}${presetSlot}${eol}${workLine}${eol}${workSlot}`
  // 修掉上一版重复执行留下的重复槽位，再按需补一次。
  let duplicated = `${directoryLine}${eol}${addon}${eol}${addon}`
  const single = `${directoryLine}${eol}${addon}`
  while (text.includes(duplicated)) text = text.replace(duplicated, single)
  if (!text.includes("'sidebar.workspaces.lingdongPresets'")) {
    text = text.replace(directoryLine, single)
  }
  if (!text.includes("PropsRenderSlots<'sidebar.workspaces.lingdongPresets'")) {
    text = text.replace(
      "  & PropsRenderSlots<'sidebar.workspaces.directoryFlow'>",
      "  & PropsRenderSlots<'sidebar.workspaces.directoryFlow' | 'sidebar.workspaces.lingdongPresets' | 'sidebar.workspaces.lingdongWork'>",
    )
  }
  if (!/  sessions\?: ISessions \| undefined\r?\n/u.test(text)) {
    if (/  sessions\??: ISessions(?: \| undefined)?\r?\n/u.test(text)) {
      text = text.replace(/  sessions\??: ISessions(?: \| undefined)?\r?\n/u, '  sessions?: ISessions | undefined\n')
    } else {
      text = text.replace(
        /export type WorkspaceBrowserInjected = \{\r?\n/u,
        (match) => `${match}  /** Session service passed to the Lingdong sidebar panels (root-scope slots cannot read it from a hook). */${eol}  sessions?: ISessions | undefined${eol}`,
      )
    }
  }
  return text
}, '新增 Lingdong sidebar slots / owner / injected sessions')
// ③c ui-workspace：把两个面板挂到新 slot，child 声明与 renderSlot 的 slot 名保持一致。
updateTextFile('packages/client/ui-workspace/src/client/index.ts', (before) => {
  let text = before
  if (!text.includes('lingdongPresetPanelEntry')) {
    text = text.replace(
      "import { WorkspacePicker } from './WorkspacePicker.tsx'",
      "import { WorkspacePicker } from './WorkspacePicker.tsx'\nimport { lingdongPresetPanelEntry } from './LingdongPresetPanel.tsx'\nimport { lingdongWorkPanelEntry } from './LingdongWorkPanel.tsx'",
    )
  }
  if (!text.includes('sessions,\n    // Explicit group actions')) {
    text = text.replace(
      '  const browserInjected = (): WorkspaceBrowserInjected => ({\n',
      '  const browserInjected = (): WorkspaceBrowserInjected => ({\n    sessions,\n',
    )
  }
  text = text.replace(
    "      children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },",
    `      children: {
        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
        'sidebar.workspaces.lingdongPresets': { kind: 'single', scope: 'root' },
        'sidebar.workspaces.lingdongWork': { kind: 'single', scope: 'root' },
      },`,
  )
  if (!text.includes('ctx.plugin(lingdongPresetPanelEntry)')) {
    text = text.replace(
      '  ctx.slots.inject(\'conversation.hero.workspace\', () => ctx.slots.register(',
      `  ctx.plugin(lingdongPresetPanelEntry)
  ctx.plugin(lingdongWorkPanelEntry)
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(`,
    )
  }
  return text
}, '挂载 Lingdong 侧栏面板并声明子 slot')

// ③d WorkspaceBrowser：把 owner 数据传给两个面板；renderSlot 必须在工作区列表之前。
updateTextFile('packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx', (before) => {
  let text = before
  // 修掉上一版误把 sessions 插进 SearchResults 的残留。
  const searchStart = text.indexOf('function SearchResults({')
  const searchEnd = text.indexOf('}: Pick<WorkspaceBrowserProps', searchStart)
  if (searchStart >= 0 && searchEnd > searchStart) {
    const searchSignature = text.slice(searchStart, searchEnd)
    const cleaned = searchSignature.replace(/^  sessions,\r?\n/mu, '')
    text = `${text.slice(0, searchStart)}${cleaned}${text.slice(searchEnd)}`
  }
  const start = text.indexOf('export function WorkspaceBrowser({')
  const end = text.indexOf('}: WorkspaceBrowserProps)', start)
  if (start >= 0 && end > start) {
    const signature = text.slice(start, end)
    if (!/\bsessions,\r?\n/u.test(signature)) {
      const next = signature.replace(/  useSessions,\r?\n/u, (match) => `${match}  sessions,${match.endsWith('\r\n') ? '\r\n' : '\n'}`)
      text = `${text.slice(0, start)}${next}${text.slice(end)}`
    }
  }
  if (!text.includes('const rawList = useSessions(state => state)')) {
    text = text.replace(
      '  const list = useSessions(state => state)\n',
      `  const rawList = useSessions(state => state)
  const [classroomStartedAt, setClassroomStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const bridge = (window as Window & {
      readonly lingdong?: { readonly context?: () => Promise<{ readonly classroom?: { readonly startedAt?: unknown } | null } | undefined> }
    }).lingdong
    void bridge?.context?.().then(context => {
      if (!alive) return
      const raw = context?.classroom?.startedAt
      const value = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
      setClassroomStartedAt(Number.isFinite(value) ? value : undefined)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  // 每个新课堂从开始时刻之后算起；旧课堂的本地会话不再出现在侧栏，但磁盘历史不删除。
  const list = useMemo(() => {
    if (classroomStartedAt === undefined) return rawList
    const byId = Object.fromEntries(Object.entries(rawList.byId).filter(([, session]) => {
      const value = session as { readonly blank?: unknown; readonly updatedAt?: unknown }
      return value.blank === true || typeof value.updatedAt !== 'number' || value.updatedAt >= classroomStartedAt
    })) as typeof rawList.byId
    return { ...rawList, ids: rawList.ids.filter(id => byId[id] !== undefined), byId }
  }, [classroomStartedAt, rawList])
`,
    )
  }
  if (!text.includes('const sidebarOwner = {')) {
    text = text.replace(
      '  const currentBlank = mainSessionId !== undefined',
      `  const sidebarOwner = { sessionId: mainSessionId, sessions, sessionList: list }
  const currentBlank = mainSessionId !== undefined`,
    )
  }
  if (!text.includes("renderSlot('sidebar.workspaces.lingdongPresets', sidebarOwner)")) {
    text = text.replace(
      '      <div className={css.listArea}>\n        {wide && (',
      `      <div className={css.listArea}>
        {wide && renderSlot('sidebar.workspaces.lingdongPresets', sidebarOwner)}
        {wide && renderSlot('sidebar.workspaces.lingdongWork', sidebarOwner)}
        {wide && (`,
    )
  }
  return text
}, '传入 session/sessionList 并渲染两个侧栏面板')
// ③f ui-settings-models：学生端移除上游「内测声明」欢迎弹层。
const welcomeNoticeTarget = join(checkout, 'packages/client/ui-settings-models/src/client/WelcomeNotice.tsx')
if (!dryRun) {
  mkdirSync(dirname(welcomeNoticeTarget), { recursive: true })
  copyFileSync(join(patchDir, 'LingdongWelcomeNotice.tsx'), welcomeNoticeTarget)
}
report.push('✓  packages/client/ui-settings-models/src/client/WelcomeNotice.tsx：已替换为无内测声明版本')
// ③e ui-conversation：只保留隐藏桥；清掉旧输入 dock 面板的 import / plugin。
updateTextFile('packages/client/ui-conversation/src/client/apply.ts', (before) => {
  let text = before
  text = text.replace(/\nimport \{ lingdongPresetDockEntry \} from '\.\/LingdongPresetDock\.tsx'/g, '')
  text = text.replace(/\nimport \{ lingdongWorkDockEntry \} from '\.\/LingdongWorkDock\.tsx'/g, '')
  text = text.replace(/\n  \/\/ 灵动ai 课堂预设[\s\S]*?ctx\.plugin\(lingdongPresetDockEntry\)/g, '')
  text = text.replace(/\n  \/\/ 灵动ai 作品[\s\S]*?ctx\.plugin\(lingdongWorkDockEntry\)/g, '')
  if (!text.includes('lingdongPresetBridgeEntry')) {
    text = text.replace(
      "import { queueDockEntry } from './queue/QueueDock.tsx'",
      "import { queueDockEntry } from './queue/QueueDock.tsx'\nimport { lingdongPresetBridgeEntry } from './LingdongPresetBridge.tsx'",
    )
  }
  if (!text.includes('ctx.plugin(lingdongPresetBridgeEntry)')) {
    text = text.replace(
      '  ctx.plugin(queueDockEntry)',
      `  ctx.plugin(queueDockEntry)
  // 灵动ai 隐藏桥：侧栏预设标题点击后写入当前会话输入框，不自动发送。
  ctx.plugin(lingdongPresetBridgeEntry)`,
    )
  }
  if (!text.includes('lingdongSendQuotaEntry')) {
    text = text.replace(
      "import { lingdongPresetBridgeEntry } from './LingdongPresetBridge.tsx'",
      "import { lingdongPresetBridgeEntry } from './LingdongPresetBridge.tsx'\nimport { lingdongSendQuotaEntry } from './LingdongSendQuota.tsx'",
    )
  }
  if (!text.includes('ctx.plugin(lingdongSendQuotaEntry)')) {
    text = text.replace(
      '  ctx.plugin(lingdongPresetBridgeEntry)',
      `  ctx.plugin(lingdongPresetBridgeEntry)
  // 灵动ai 发送次数：输入区发送按钮前的「0/20」（数字来自平台 client-context，客户端不自己计数）。
  ctx.plugin(lingdongSendQuotaEntry)`,
    )
  }
  return text
}, '切换为隐藏输入桥 + 发送次数计数条，清理旧 dock')
// ④ main.ts：在启动后端之前过登录门 + 注册深链协议
// 先去重（两类，都实测踩过）：
//   (a) 早期版本只插过 `import { runLingdongGate }`，加 deepLink 后会与新的那条并存；
//   (b) 早期版本的登录门**没有第三个参数**（`resetHost`：过门后把可能已经起来的宿主停一次，
//       见 platform-gate.ts 的 @param resetHost）。这里必须**原地换掉那一行**：
//       若走下面那条按锚点插入的路，旧的那一行会留在上面 —— 登录门会弹两次。
const mainFile = join(checkout, 'apps/desktop/src/main.ts')
const LEGACY_GATE = "if ((await runLingdongGate(createMainWindow, isQuitting)).kind === 'quit') { app.quit(); return }"
const PREVIOUS_GATE = "if ((await runLingdongGate(createMainWindow, isQuitting, () => backend.stop())).kind === 'quit') { app.quit(); return }"
const GATE_CALL = "if ((await runLingdongGate(() => currentMainWindow() ?? createMainWindow(), isQuitting, () => backend.stop())).kind === 'quit') { app.quit(); return }"
let gateInstalled = false
if (existsSync(mainFile)) {
  let current = readFileSync(mainFile, 'utf8')
  const stale = "import { runLingdongGate } from './platform-gate.ts'\n"
  if (current.includes(stale)) {
    current = current.replace(stale, '')
    report.push('✓  apps/desktop/src/main.ts：清掉重复的旧 import')
  }
  if (current.includes(PREVIOUS_GATE)) {
    current = current.replace(PREVIOUS_GATE, GATE_CALL)
    report.push('✓  apps/desktop/src/main.ts：登录门改为复用已创建的主窗口')
  } else if (current.includes(LEGACY_GATE)) {
    current = current.replace(LEGACY_GATE, GATE_CALL)
    report.push('✓  apps/desktop/src/main.ts：登录门升级到复用主窗口并重启宿主')
  }
  gateInstalled = current.includes(GATE_CALL)   // 升级过 / 本来就是新版
  if (current !== readFileSync(mainFile, 'utf8')) write('apps/desktop/src/main.ts', current)
}
// 只有**全新检出**（既没有旧那行、也没有新那行）才走这里按锚点插入。
// ⚠️ 不能无条件插：旧的那行还在时这样插会**多出一行登录门**（过门两次）。
if (!gateInstalled) {
  patch('apps/desktop/src/main.ts',
  "import { fileURLToPath } from 'node:url'",
  "import { fileURLToPath } from 'node:url'\nimport { lingdongDeepLink, runLingdongGate } from './platform-gate.ts'",
  '引入登录门模块', 'lingdongDeepLink, runLingdongGate')
  patch('apps/desktop/src/main.ts',
  '  automaticCheck()\n  await reconcileBackend().catch(() => undefined)',
  `  // 灵动ai 登录门：没有我们的账号、或这节课还没开始上课，就**不启动**创作环境。
  // 学生登录后这里会向平台要这节课的运行时密钥与预设提示词（见 src/platform-gate.ts 文件头）。
  // ⚠️ 必须在 automaticCheck() **之前**跑完：更新/恢复流程在它里面就可能把宿主起起来，
  //    那一刻 process.env 里还没有网关密钥 —— 宿主起来后再补环境变量没用，每一轮都会
  //    「API 密钥无效」（AUTH）。实测对照：密钥预置在进程环境里 → 成功；只靠登录门事后注入 → 失败。
  // ⚠️ 第三个参数 () => backend.stop() 是**兜底**：宿主可能已经从别的路径（更新/恢复、
  //    策略检查）起来了，过门后停一次，让下面的 reconcileBackend() 用刚写好的密钥重新起。
  if ((await runLingdongGate(() => currentMainWindow() ?? createMainWindow(), isQuitting, () => backend.stop())).kind === 'quit') { app.quit(); return }
  automaticCheck()
  await reconcileBackend().catch(() => undefined)`,
  '在 automaticCheck 之前插登录门（复用主窗口，含过门后重启宿主）', 'runLingdongGate(() => currentMainWindow() ?? createMainWindow()')
}
// 深链协议：安装器写进注册表，系统才知道怎么用 lingdong:// 拉起本客户端。
// ⚠️ 单独一条、挂在 automaticCheck() 上 —— 挂在上面那个锚点上的话，登录门一插好锚点就没了。
patch('apps/desktop/src/main.ts',
  '  automaticCheck()\n',
  `  automaticCheck()
  // 深链协议（2026-09-19）：官网点「打开客户端」→ 系统拉起 lingdong://open → second-instance
  // → focusPrimaryWindow() 里调 lingdongDeepLink()，让「等老师开始上课」那一页立刻重问一次。
  app.setAsDefaultProtocolClient('lingdong')
`,
  '注册 lingdong://（main）', "setAsDefaultProtocolClient('lingdong')")
patch('apps/desktop/src/main.ts',
  '  focusPrimaryWindow = () => {\n    if (quitting) return\n',
  '  focusPrimaryWindow = () => {\n    if (quitting) return\n    // 深链/第二次启动都走到这里：让等待页立刻重问一次「现在有没有课」\n    lingdongDeepLink()\n',
  '深链落到 focusPrimaryWindow', '深链/第二次启动都走到这里')

// ④b 打包：注册 lingdong:// 协议（安装器写进注册表，系统才知道怎么拉起客户端）
patch('apps/desktop/scripts/electron-builder-config.mjs',
  '    ],\n    mac: {',
  `    ],
    // 深链协议：官网「打开客户端」链接用 lingdong://open 拉起本客户端
    protocols: [{ name: '灵动ai创作客户端', schemes: ['lingdong'] }],
    mac: {`,
  '注册 lingdong:// 协议', 'protocols: [{ name: ')

// ⑤ 打包：把 gate/ 打进 extraResources
patch('apps/desktop/scripts/electron-builder-config.mjs',
  "      { from: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)), to: 'icon.png' },",
  `      { from: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)), to: 'icon.png' },
      // 灵动ai 登录门的页面与补丁层（运行时从 process.resourcesPath/gate 读）
      { from: fileURLToPath(new URL('../resources/gate', import.meta.url)), to: 'gate' },`,
  'gate/ 进 extraResources')

// ⑥ 桌面宿主：patchFiles 挂上我们的补丁层
patch('apps/desktop-host/src/index.ts',
  "import { delimiter, join } from 'node:path'",
  "import { existsSync } from 'node:fs'\nimport { delimiter, join } from 'node:path'",
  '引入 existsSync')
patch('apps/desktop-host/src/index.ts',
  '    patchFiles: [],',
  `    patchFiles: ((): string[] => {
      // 灵动ai：随客户端分发的补丁层（模型调用只走我们自己的网关）。登录门在拿到运行时密钥后
      // 把它写到 $DSH_HOME/lingdong.patch.yml；这里只在文件存在时挂上。
      // ⚠️ 不能改成"让 profile 的 cordis.patch.yml 生效"：那是空数组与 undefined 的区别，
      //    见 src/platform-gate.ts 文件头（initialProfile?.patches ?? loadOptionalPatches(...)）。
      const lingdong = join(resolveDshHome(), 'lingdong.patch.yml')
      return existsSync(lingdong) ? [lingdong] : []
    })(),`,
  'patchFiles 挂上 lingdong.patch.yml')

console.log(`检出：${checkout}${dryRun ? '（--dry-run）' : ''}`)
for (const line of report) console.log('  ' + line)
const failed = report.filter((line) => line.startsWith('!!'))
console.log(failed.length ? `\n!! ${failed.length} 处需要人工看一眼（多半是上游漂了）` : '\n登录门已接入。')
