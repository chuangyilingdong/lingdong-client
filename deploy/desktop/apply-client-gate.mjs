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
 *     加新补丁时会被误判成"已打过"而整个跳过（踩过）。
 *  ⚠️⚠️ 默认 marker 取的是**新增部分**，不是 `replacement` 的开头。
 *     很多补丁是「锚点原样保留 + 追加几行」，这时 `replacement.slice(0, 60)` 恰好就是锚点本身：
 *     锚点在文件里 → 判成"已打过" → 补丁**永远不生效**，而报告里只写"已打过（跳过）"，看着完全正常。
 *     2026-09-24 的 `gate/ 进 extraResources` 就是这么丢的：包缺 `resources/gate/`，
 *     学生一启动就 `ERR_FILE_NOT_FOUND`（gate/loading.html）。
 * @param file - 检出内相对路径。
 * @param anchor - 原文锚点（必须原样存在于未打补丁的文件）。
 * @param replacement - 替换后的文本。
 * @param note - 报告里显示的一句话。
 * @param marker - 可选的"已打过"特征串；默认从**新增部分**推导。
 */
const patch = (file, anchor, replacement, note, marker) => {
  const full = join(checkout, file)
  if (!existsSync(full)) { report.push(`!! ${file}：文件不存在`); return }
  const before = readFileSync(full, 'utf8')
  const added = replacement.startsWith(anchor) ? replacement.slice(anchor.length).trim() : replacement
  const effectiveMarker = marker ?? (added.length >= 12 ? added.slice(0, 60) : replacement)
  if (before.includes(effectiveMarker)) {
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
if (!dryRun) copyFileSync(join(patchDir, 'LingdongUpdater.ts'), join(checkout, 'apps/desktop/src/LingdongUpdater.ts'))
report.push('✓  apps/desktop/src/LingdongUpdater.ts：已放入')
if (!dryRun) copyFileSync(join(patchDir, 'lingdong-office-engine.mjs'), join(checkout, 'apps/desktop/scripts/lingdong-office-engine.mjs'))
if (!dryRun) copyFileSync(join(patchDir, 'lingdong-office-engine.d.mts'), join(checkout, 'apps/desktop/scripts/lingdong-office-engine.d.mts'))
report.push('✓  apps/desktop/scripts/lingdong-office-engine.mjs：已放入（含类型声明）')

// ②b UI：侧栏预设/作品面板 + 会话输入隐藏桥。
// 旧版本把两个面板挂在输入框 dock 上；这里先原地清掉旧 import/plugin/文件，再写新结构。
const workspaceClientDir = join(checkout, 'packages/client/ui-workspace/src/client')
const conversationClientDir = join(checkout, 'packages/client/ui-conversation/src/client')
for (const name of ['LingdongPresetPanel.tsx', 'LingdongWorkPanel.tsx', 'LingdongAccountPanel.tsx', 'LingdongClassroomWorkspace.ts']) {
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

// ③a0 模型清单锚点：模型名由平台 client-context 下发，登录门写补丁层时替换这两段。
// 源码模板已带锚点；这里再兜一道，避免后续编辑把锚点删掉后静默退回写死模型。
updateTextFile('apps/desktop/resources/gate/lingdong.patch.yml', (before) => {
  if (before.includes('# LINGDONG_MODELS_BEGIN') && before.includes('# LINGDONG_MODELS_END') && before.includes('# LINGDONG_DEFAULT_MODEL')) return before
  const eol = before.includes('\r\n') ? '\r\n' : '\n'
  const anchor = [
    '        models:',
    '          - id: deepseek-flash',
    '            name: DeepSeek Flash',
    '            input: [text, image]',
    '          - id: deepseek-pro',
    '            name: DeepSeek Pro',
    '            input: [text, image]',
    '',
    '# 默认模型必须指到我们网关，并把官方那条直连路由关掉 —— 否则学生一发消息就 MISSING_CREDENTIAL',
  ].join(eol)
  if (!before.includes(anchor)) {
    report.push('!! apps/desktop/resources/gate/lingdong.patch.yml：找不到模型清单锚点')
    return before
  }
  return before.replace(anchor, [
    '        models:',
    '          # LINGDONG_MODELS_BEGIN',
    '          - id: deepseek-flash',
    '            name: DeepSeek Flash',
    '            input: [text, image]',
    '          - id: deepseek-pro',
    '            name: DeepSeek Pro',
    '            input: [text, image]',
    '          # LINGDONG_MODELS_END',
    '',
    '# 默认模型必须指到我们网关，并把官方那条直连路由关掉 —— 否则学生一发消息就 MISSING_CREDENTIAL',
  ].join(eol))
}, '模型清单与默认模型替换锚点')

updateTextFile('apps/desktop/src/platform-gate.ts', (before) => {
  if (before.includes('function renderGatewayPatch(') && before.includes('LINGDONG_DEFAULT_MODEL_MARKER') && before.includes('context.models') && before.includes('context.defaultModel')) return before
  report.push('!! apps/desktop/src/platform-gate.ts：缺少 renderGatewayPatch 模型清单适配')
  return before
}, '模型清单渲染器已就位')

// ③a HTML 预览引导层：opaque-origin 沙箱里补内存 localStorage/sessionStorage。
// 上游的 sandbox="allow-scripts" 不能打开同源权限；但生成的网页常把 localStorage
// 当启动前置条件（如打地鼠游戏），直接访问会抛 SecurityError 并让整个脚本白屏。
// 这份覆盖保留原隔离边界，只在沙箱内部提供同形态的内存 Storage。
const htmlPreviewDir = join(checkout, 'packages/client/ui-sidebar-documentpreview/src/client/html')
for (const [source, target, note] of [
  ['HtmlPreviewBytes.ts', 'bytes.ts', '补二进制编码'],
  ['HtmlPreviewBootstrap.ts', 'bootstrap.ts', '补沙箱内存 Storage 与本地图片资源'],
  ['HtmlPreviewPack.ts', 'pack.ts', '补 HTML 本地图片/媒体打包'],
]) {
  if (!dryRun) {
    mkdirSync(htmlPreviewDir, { recursive: true })
    copyFileSync(join(patchDir, source), join(htmlPreviewDir, target))
  }
  report.push(`✓  packages/client/ui-sidebar-documentpreview/src/client/html/${target}：${note}`)
}

// ③a2 文件卡片：点击“在文件资源管理器中显示”优先直接走桌面 shell 的 reveal IPC。
// 上游默认还要经过本地 Host 路由；这里绕开那条链，避免误触发编辑工具/连接状态导致报错。
const presentedFileCardTarget = join(checkout, 'packages/client/ui-deliverables/src/client/PresentedFileCard.tsx')
if (!dryRun) {
  mkdirSync(dirname(presentedFileCardTarget), { recursive: true })
  copyFileSync(join(patchDir, 'PresentedFileCard.tsx'), presentedFileCardTarget)
}
report.push('✓  packages/client/ui-deliverables/src/client/PresentedFileCard.tsx：已接桌面文件管理器 IPC')

// ③a3 Office 预览：刚写完的文件偶发转换/版本竞争时自动重试一次，学生仍可手动重试。
const officePreviewTarget = join(checkout, 'packages/client/ui-sidebar-documentpreview/src/client/office/index.ts')
if (!dryRun) {
  mkdirSync(dirname(officePreviewTarget), { recursive: true })
  copyFileSync(join(patchDir, 'OfficePreview.ts'), officePreviewTarget)
}
report.push('✓  packages/client/ui-sidebar-documentpreview/src/client/office/index.ts：已加重试')

// ③a2b 文件卡片接线：Deliverables 既要 onAction（我们自绘菜单），也要把上游 slot 内容传下去。
// 与上游差异只有 PresentedFileCard 一处调用点，但用脚本拼字符串太脆（踩过转义坑），
// 所以整文件替换；verify-upstream-patches.mjs 会校验它与上游基线的对应关系。
const deliverablesTarget = join(checkout, 'packages/client/ui-deliverables/src/client/Deliverables.tsx')
if (!dryRun) {
  mkdirSync(dirname(deliverablesTarget), { recursive: true })
  copyFileSync(join(patchDir, 'Deliverables.tsx'), deliverablesTarget)
}
report.push('✓  packages/client/ui-deliverables/src/client/Deliverables.tsx：保留 slot 动作 + 接入自绘菜单')

// ③a2c 文件卡片样式：自绘「打开 / 更多」动作条需要的类，上游样式表里没有。
updateTextFile('packages/client/ui-deliverables/src/client/Deliverables.module.css', (before) => {
  if (before.includes('.menuActionIcon')) return before
  const css = {
    actionsRow: '.actionsRow { display: inline-flex; align-items: center; gap: 6px; flex: none; pointer-events: auto; }',
    split: '.split { display: inline-flex; flex: none; align-items: stretch; box-sizing: border-box; height: 28px; overflow: hidden; pointer-events: auto; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; background: var(--dsw-alias-button-floating-fill); }',
    anchor: '.menuAnchor { align-self: stretch; }',
    buttons: '.open, .chevron { display: inline-flex; align-items: center; justify-content: center; border: 0; background: none; color: var(--dsw-alias-label-primary); cursor: pointer; font-family: var(--dsw-font-family); }',
    open: '.open { padding: 4px 8px; font-size: 12px; line-height: 18px; }',
    chevron: '.chevron { padding: 4px 5px; border-left: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }',
    hover: '.open:hover, .open:focus-visible, .chevron:hover:not(:disabled), .chevron:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }',
    disabled: '.chevron:disabled { color: var(--dsw-alias-label-dimmed); cursor: not-allowed; }',
    icon: '.menuActionIcon { display: block; width: 16px; height: 16px; }',
  }
  const text = Object.values(css).join('\n')
  return before.replace(/\n?$/, '') + '\n' + text + '\n'
}, '补自绘动作样式')
// ③a2d 文件卡片文案：自绘动作菜单需要的几个 key，上游字典里没有。
updateTextFile('packages/client/ui-deliverables/src/client/locales.ts', (before) => {
  if (before.includes('presented.defaultApp')) return before
  const zhPairs = [
    ["presented.directory", '打开所在文件夹'],
    ["presented.explorer", '在文件资源管理器中显示'],
    ["presented.finder", '在 Finder 中显示'],
    ["presented.defaultApp", '用默认应用打开'],
    ["presented.more", '{name} 的更多文件操作'],
    ["presented.action", '打开'],
  ]
  const enPairs = [
    ["presented.directory", 'Open containing folder'],
    ["presented.explorer", 'Show in File Explorer'],
    ["presented.finder", 'Show in Finder'],
    ["presented.defaultApp", 'Open in default app'],
    ["presented.more", 'More file actions for {name}'],
    ["presented.action", 'Open'],
  ]
  const line = (key, value) => `  '${key}': '${value}',`
  let current = before
  const zhAnchor = "  'presented.preview': '在侧边栏预览',"
  const enAnchor = "  'presented.preview': 'Preview in sidebar',"
  if (!current.includes(zhAnchor) || !current.includes(enAnchor)) {
    report.push('!! packages/client/ui-deliverables/src/client/locales.ts：字典锚点没找到')
    return before
  }
  current = current.replace(zhAnchor, [zhAnchor, ...zhPairs.map(([k, v]) => line(k, v))].join('\n'))
  current = current.replace(enAnchor, [enAnchor, ...enPairs.map(([k, v]) => line(k, v))].join('\n'))
  return current
}, '补自绘动作文案')

// ③ preload：用一份确定的 window.lingdong 取代旧 gate/context/submitWork 的组合块。
updateTextFile('apps/desktop/src/preload-app.ts', (before) => {
  const block = `contextBridge.exposeInMainWorld('lingdong', {
  gate: (payload: unknown) => ipcRenderer.invoke('lingdong:gate', payload) as Promise<{ ok: boolean; message?: string }>,
  context: (options?: unknown) => ipcRenderer.invoke('lingdong:classroom-context', options) as Promise<unknown>,
  submitWorkBatch: (payload: unknown) => ipcRenderer.invoke('lingdong:submit-work-batch', payload) as Promise<unknown>,
  listWorks: () => ipcRenderer.invoke('lingdong:list-works') as Promise<unknown>,
  scanWorkFiles: () => ipcRenderer.invoke('lingdong:scan-work-files') as Promise<unknown>,
  showInFolder: (path: string) => ipcRenderer.invoke('lingdong:show-in-folder', path) as Promise<{ ok: boolean; message?: string }>,
  account: () => ipcRenderer.invoke('lingdong:account') as Promise<unknown>,
  logout: () => ipcRenderer.invoke('lingdong:logout') as Promise<{ ok: boolean }>,
})`
  if (before.includes(block)) return before
  const start = before.indexOf("contextBridge.exposeInMainWorld('lingdong', {")
  if (start >= 0) {
    const end = before.indexOf('\n})', start)
    if (end < 0) return before
    return `${before.slice(0, start)}${block}${before.slice(end + 3)}`
  }
  // 上游可能把 product 变量重构成 createProductApi()，这里兼容两种形态。
  const anchors = [
    "contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' ? createProductApi() : { protocolVersion: 1 })",
    "contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' ? product : { protocolVersion: 1 })",
  ]
  const anchor = anchors.find((candidate) => before.includes(candidate))
  if (anchor === undefined) {
    report.push('!! apps/desktop/src/preload-app.ts：找不到 dshDesktop 锚点，window.lingdong 未注入')
    return before
  }
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
  const union = "'sidebar.workspaces.directoryFlow' | 'sidebar.workspaces.session.menu.item' | 'sidebar.workspaces.session.row.action'"
  const extended = "'sidebar.workspaces.directoryFlow' | 'sidebar.workspaces.lingdongPresets' | 'sidebar.workspaces.lingdongWork' | 'sidebar.workspaces.session.menu.item' | 'sidebar.workspaces.session.row.action'"
  if (!text.includes(extended)) {
    if (text.includes(union)) text = text.replace(union, extended)
    else text = text.replace("  & PropsRenderSlots<'sidebar.workspaces.directoryFlow'>", "  & PropsRenderSlots<'sidebar.workspaces.directoryFlow' | 'sidebar.workspaces.lingdongPresets' | 'sidebar.workspaces.lingdongWork'>")
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
      "import { WorkspacePicker } from './WorkspacePicker.tsx'\nimport { lingdongPresetPanelEntry } from './LingdongPresetPanel.tsx'\nimport { lingdongWorkPanelEntry } from './LingdongWorkPanel.tsx'\nimport { lingdongAccountPanelEntry } from './LingdongAccountPanel.tsx'\nimport { lingdongClassroomWorkspaceEntry } from './LingdongClassroomWorkspace.ts'",
    )
  }
  if (!text.includes('lingdongAccountPanelEntry')) {
    text = text.replace(
      "import { lingdongWorkPanelEntry } from './LingdongWorkPanel.tsx'",
      "import { lingdongWorkPanelEntry } from './LingdongWorkPanel.tsx'\nimport { lingdongAccountPanelEntry } from './LingdongAccountPanel.tsx'",
    )
  }
  if (!text.includes("from './LingdongClassroomWorkspace.ts'")) {
    text = text.replace(
      "import { lingdongAccountPanelEntry } from './LingdongAccountPanel.tsx'",
      "import { lingdongAccountPanelEntry } from './LingdongAccountPanel.tsx'\nimport { lingdongClassroomWorkspaceEntry } from './LingdongClassroomWorkspace.ts'",
    )
  }
  if (!text.includes('sessions,\n    // Explicit group actions')) {
    text = text.replace(
      '  const browserInjected = (): WorkspaceBrowserInjected => ({\n',
      '  const browserInjected = (): WorkspaceBrowserInjected => ({\n    sessions,\n',
    )
  }
  if (!text.includes("'sidebar.workspaces.lingdongPresets': { kind: 'single', scope: 'root' }")) {
    const comment = "        // Every row entry reads the menu's open state through a hook bound"
    const oldChild = "        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },"
    const oldChildren = `${oldChild}\n${comment}`
    const newChildren = `${oldChild}\n        'sidebar.workspaces.lingdongPresets': { kind: 'single', scope: 'root' },\n        'sidebar.workspaces.lingdongWork': { kind: 'single', scope: 'root' },\n${comment}`
    const simple = "      children: { 'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' } },"
    const simpleReplacement = "      children: {\n        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },\n        'sidebar.workspaces.lingdongPresets': { kind: 'single', scope: 'root' },\n        'sidebar.workspaces.lingdongWork': { kind: 'single', scope: 'root' },\n      },"
    if (text.includes(oldChildren)) text = text.replace(oldChildren, newChildren)
    else if (text.includes(oldChild)) text = text.replace(oldChild, `${oldChild}\n        'sidebar.workspaces.lingdongPresets': { kind: 'single', scope: 'root' },\n        'sidebar.workspaces.lingdongWork': { kind: 'single', scope: 'root' },`)
    else if (text.includes(simple)) text = text.replace(simple, simpleReplacement)
  }
  const plugins = [
    'ctx.plugin(lingdongPresetPanelEntry)',
    'ctx.plugin(lingdongWorkPanelEntry)',
    'ctx.plugin(lingdongAccountPanelEntry)',
    'ctx.plugin(lingdongClassroomWorkspaceEntry)',
  ]
  const present = plugins.filter((line) => text.includes(line))
  if (present.length > 0 && present.length < plugins.length) {
    const lastPresent = present[present.length - 1]
    const missing = plugins.filter((line) => !text.includes(line)).join('\n  ')
    text = text.replace(lastPresent, `${lastPresent}\n  ${missing}`)
  } else if (present.length === 0) {
    text = text.replace('  // The shipped row actions take the same route as a plugin\'s', `  ${plugins.join('\n  ')}\n  // The shipped row actions take the same route as a plugin\'s`)
  }  return text
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
  const [classroomWorkspacePath, setClassroomWorkspacePath] = useState('')
  useEffect(() => {
    let alive = true
    const bridge = (window as Window & {
      readonly lingdong?: { readonly context?: () => Promise<{
        readonly classroom?: { readonly startedAt?: unknown } | null
        readonly workspacePath?: unknown
      } | undefined> }
    }).lingdong
    void bridge?.context?.().then(context => {
      if (!alive) return
      const raw = context?.classroom?.startedAt
      const value = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
      setClassroomStartedAt(Number.isFinite(value) ? value : undefined)
      setClassroomWorkspacePath(typeof context?.workspacePath === 'string' ? context.workspacePath.trim() : '')
    }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  // 只显示当前课堂工作区里的会话；浏览器测试没有 bridge 时保留上游列表行为。
  const list = useMemo(() => {
    if (typeof window === 'undefined') return rawList
    const bridge = (window as Window & { readonly lingdong?: { readonly context?: unknown } }).lingdong
    if (bridge?.context === undefined) return rawList
    if (classroomWorkspacePath === '') return { ...rawList, ids: [], byId: {} }
    const normalize = (value: string): string => {
      let path = value.split(String.fromCharCode(92)).join('/')
      while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
      return path.toLocaleLowerCase('en-US')
    }
  const samePath = (left: unknown, right: string): boolean => typeof left === 'string' && normalize(left) === normalize(right)
    const byId = Object.fromEntries(Object.entries(rawList.byId).filter(([, session]) => {
      const value = session as { readonly blank?: unknown; readonly updatedAt?: unknown; readonly cwd?: unknown }
      if (!samePath(value.cwd, classroomWorkspacePath)) return false
      return value.blank === true || typeof value.updatedAt !== 'number' || classroomStartedAt === undefined || value.updatedAt >= classroomStartedAt
    })) as typeof rawList.byId
    return { ...rawList, ids: rawList.ids.filter(id => byId[id] !== undefined), byId }
  }, [classroomStartedAt, classroomWorkspacePath, rawList])
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

// ④-0 Office 引擎短路径：Windows 下 LibreOffice 对长路径敏感；把 prepared engine 放到 resources/lo。
updateTextFile('apps/desktop/src/main.ts', (before) => {
  const source = '  const development = !app.isPackaged\n'
  const line = "  if (!development) process.env.LINGDONG_LIBREOFFICE_ENGINE_DIR = join(process.resourcesPath, 'lo')\n"
  return before.includes('LINGDONG_LIBREOFFICE_ENGINE_DIR') ? before : before.replace(source, source + line)
}, 'Office 引擎切到短路径')

updateTextFile('apps/desktop/scripts/prepare-dsh.ts', (before) => {
  let current = before
  const importAnchor = "import { selectOfficeEngine } from '../../../scripts/libreoffice-engine.ts'"
  if (!current.includes("from './lingdong-office-engine.mjs'")) {
    current = current.replace(importAnchor, importAnchor + "\nimport { patchLingdongOfficeEngine } from './lingdong-office-engine.mjs'")
  }
  const marker = "'node_modules', '@deepseek-ai', `libreoffice-kit-${officeEngine}`, 'prebuilds.json'"
  if (!current.includes('patchLingdongOfficeEngine(DSH_OUTPUT_ROOT')) {
    current = current.replace("    if (process.platform === 'darwin') {", "    patchLingdongOfficeEngine(DSH_OUTPUT_ROOT, target.platform, target.arch)\n    if (process.platform === 'darwin') {")
  }
  return current
}, 'prepared Office 引擎写入运行时描述前打补丁')

updateTextFile('apps/desktop/scripts/package-target.ts', (before) => {
  let current = before
  const importAnchor = "import { patchLingdongOfficeEngine } from './lingdong-office-engine.mjs'"
  if (!current.includes(importAnchor)) {
    const host = "import { withMacOSSigningKeychain } from './macos-signing-keychain.mjs'"
    if (current.includes(host)) current = current.replace(host, host + "\n" + importAnchor)
  }
  const runAnchor = "  await execute(['run', 'prepare:dsh', ...(signPrimaryRuntime ? ['--defer-runtime-smoke'] : [])], downloadEnv)"
  const plainRunAnchor = "  await execute(['run', 'prepare:dsh'], downloadEnv)"
  if (!current.includes('patchLingdongOfficeEngine(buildPaths.dsh')) {
    const anchor = current.includes(runAnchor) ? runAnchor : (current.includes(plainRunAnchor) ? plainRunAnchor : '')
    if (anchor !== '') current = current.replace(anchor, `${anchor}\n  await patchLingdongOfficeEngine(buildPaths.dsh, target.platform, target.arch)`)
  }
  if (!current.includes('patchLingdongOfficeEngine(buildPaths.dsh')) {
    current = current.replace(runAnchor, runAnchor + "\n  await patchLingdongOfficeEngine(buildPaths.dsh, target.platform, target.arch)")
  }
  return current
}, 'prepared Office 引擎后处理')

// ④a 客户端启动更新：在登录门前检查平台清单；用户确认后下载、校验、静默安装并重启。
updateTextFile('apps/desktop/src/main.ts', (before) => {
  let current = before
  const gateImport = "import { lingdongDeepLink, runLingdongGate } from './platform-gate.ts'"
  if (!current.includes("from './LingdongUpdater.ts'")) {
    current = current.replace(gateImport, gateImport + "\nimport { runLingdongUpdater } from './LingdongUpdater.ts'")
  }
  const gateCall = "  if ((await runLingdongGate(() => currentMainWindow() ?? createMainWindow(), isQuitting, () => backend.stop())).kind === 'quit') { app.quit(); return }"
  if (!current.includes('await runLingdongUpdater()') && current.includes(gateCall)) {
    current = current.replace(gateCall, "  if (await runLingdongUpdater()) { app.quit(); return }\n" + gateCall)
  }
  return current
}, '接入启动更新检查')

// ④a2 账号/欢迎门：新版上游自带 welcome + platform-account 登录窗，和我们的登录门重复。
// 这里把它的三个入口都摘掉，只保留上游的账号状态订阅（退出课堂后回登录页仍然走我们的门）。
updateTextFile('apps/desktop/src/main.ts', (before) => {
  let current = before
  const replaceOnce = (from, to, note) => {
    if (current.includes(to)) return
    if (!current.includes(from)) { report.push(`!! apps/desktop/src/main.ts：${note}：锚点没找到`); return }
    current = current.replace(from, to)
  }
  replaceOnce('  if (!value.hasApiKey && !quitting) { enteredWorkspace = false; return showWelcome() }', '  if (!value.hasApiKey && quitting) return undefined', '摘掉退出后的 welcome')
  replaceOnce('if (!enteredWorkspace && needsWelcome({ loggedIn: state.loggedIn, hasApiKey: state.hasApiKey })) {', 'if (false) {', '初始窗口直接进工作区')
  current = current.replace('{ WELCOME_IPC, needsWelcome }', '{ WELCOME_IPC }')

  return current
}, '摘掉上游 welcome/账号窗')

// ④a4 打包命名：新版上游已经认 LINGDONG_CLIENT_VERSION，但产物名与包内 version 仍走上游版本。
// electron-builder 的 artifactName 只认它自己的宏，所以版本号先在 JS 里定成 effectiveVersion。
updateTextFile('apps/desktop/scripts/electron-builder-config.mjs', (before) => {
  let text = before
  if (!text.includes('effectiveVersion = resolvedClientVersion')) {
    const anchor = '  const packaged = resolveDesktopBuildCommit(env)'
    const line = [
      '  // 产物文件名只能用 electron-builder 认识的宏，版本号先在这里定下来。',
      '  const effectiveVersion = resolvedClientVersion ?? buildVersion',
    ].join('\n')
    if (text.includes(anchor)) text = text.replace(anchor, line + '\n' + anchor)
    else report.push('!! apps/desktop/scripts/electron-builder-config.mjs：找不到 packaged 锚点')
  }
  const versionLine = '      ...buildVersion === productVersion ? {} : { version: buildVersion },'
  if (text.includes(versionLine)) text = text.replace(versionLine, '      version: effectiveVersion,')
  else if (!text.includes('version: effectiveVersion,')) report.push('!! apps/desktop/scripts/electron-builder-config.mjs：找不到 extraMetadata.version 锚点')
  const prefix = 'artifactName: ' + String.fromCharCode(96) + 'deepseek-harness-'
  const head = 'artifactName: ' + String.fromCharCode(96) + 'lingdong-client-'
  const start = text.indexOf(prefix)
  if (start >= 0) {
    const tailStart = text.indexOf(',', start)
    const oldLine = text.slice(start, tailStart + 1)
    text = text.replace(oldLine, 'artifactName: ' + String.fromCharCode(96) + 'lingdong-client-${effectiveVersion}-\\${os}-\\${arch}${unsigned ? \'-unsigned\' : \'\'}.\\${ext}' + String.fromCharCode(96) + ',')
  } else if (!text.includes(head)) {
    report.push('!! apps/desktop/scripts/electron-builder-config.mjs：找不到 artifactName 锚点')
  }
  return text
}, '产物文件名与包内版本用客户端版本')

// // ④a5 打包后 smoke：上游把可执行文件名写死成 DeepSeek Harness.exe，品牌换名后必然 ENOENT。
updateTextFile('apps/desktop/scripts/smoke-packaged-runtime.ts', (before) => {
  const exeName = process.env.LINGDONG_PRODUCT_NAME ?? '灵动ai创作客户端'
  let text = before
  text = text.split("'DeepSeek Harness.exe'").join(`'${exeName}.exe'`)
  text = text.split("'DeepSeek Harness.app'").join(`'${exeName}.app'`)
  text = text.split("'MacOS', 'DeepSeek Harness'").join(`'MacOS', '${exeName}'`)
  return text
}, 'smoke 脚本按品牌后的可执行名校验')

// smoke 直接跑 Host（不经过 Electron 主进程），所以要自己带上 main.ts 里设的短路径引擎变量；
// 否则它从 asar 深路径加载原生 LibreOffice，会报 Unknown LibreOfficeKit exception 的假失败。
updateTextFile('apps/desktop/scripts/smoke-prepared-runtime.ts', (before) => {
  if (before.includes('LINGDONG_LIBREOFFICE_ENGINE_DIR')) return before
  const envAnchor = "  const environment = { ...scrubWindowsSigningEnvironment(process.env), NODE_OPTIONS: '',"
  if (!before.includes(envAnchor)) {
    report.push('!! apps/desktop/scripts/smoke-prepared-runtime.ts：找不到 environment 锚点')
    return before
  }
  return before.replace(envAnchor, '  // resourcesRuntime 是 resources/runtime，短路径引擎在它的同级 lo/ 下。\n  process.env.LINGDONG_LIBREOFFICE_ENGINE_DIR = join(resourcesRuntime, \'..\', \'lo\')\n' + envAnchor)
}, 'smoke 用发布时的短路径加载 Office 引擎')

// ④a6 上游账号区：灵动ai 的登录门在宿主侧完成登录，上游那套账号态永远是「未登录」，
// 于是侧栏会出现「尚未登录」+ 一个多余的「登录」入口，和我们自己的账号区打架（2026-09-24 学生截图）。
// 这里让它在检测到我们的桥时：不显示「尚未登录」文案、也不再提供登录/退出入口（设置/联系我们保留）。
updateTextFile('packages/client/ui-settings-account/src/client/AccountMenu.tsx', (before) => {
  if (before.includes('LINGDONG_GATE_ACCOUNT')) return before
  let text = before
  const signedInAnchor = "  const signedIn = account.view?.status === 'credential-stored'"
  if (!text.includes(signedInAnchor)) {
    report.push('!! packages/client/ui-settings-account/src/client/AccountMenu.tsx：找不到 signedIn 锚点')
    return before
  }
  text = text.replace(signedInAnchor, signedInAnchor + [
    '',
    '  // LINGDONG_GATE_ACCOUNT：我们的登录门在宿主侧登录，上游账号态永远是「未登录」；',
    '  // 再渲染「尚未登录 / 登录」就会和学生看到的已登录面板自相矛盾。',
    "  const lingdongGate = typeof window !== 'undefined' && (window as Window & { readonly lingdong?: unknown }).lingdong !== undefined",
  ].join('\n'))
  text = text.replace(
    "{wide && <span className={css.label}>{signedIn ? label : t('signedOut')}</span>}",
    "{wide && !lingdongGate && <span className={css.label}>{signedIn ? label : t('signedOut')}</span>}",
  )
  text = text.replace(
    "        ...(signedIn ? [{ id: 'signout', label: t('signOut'), icon: <LogoutIcon />, disabled: busy }]",
    "        ...(lingdongGate ? [] : signedIn ? [{ id: 'signout', label: t('signOut'), icon: <LogoutIcon />, disabled: busy }]",
  )
  return text
}, '上游账号区不再重复显示未登录/登录')

// ④a3 主运行时下载：这台机器直连 GitHub release 会超时，允许用镜像前缀（仍按 lock 的 sha256 校验）。
updateTextFile('scripts/primary-runtime/prepare.ts', (before) => {
  if (before.includes('DSH_PRIMARY_RUNTIME_GITHUB_BASE')) return before
  const importAnchor = "import lock from './lock.json' with { type: 'json' }"
  if (!before.includes(importAnchor)) {
    report.push('!! scripts/primary-runtime/prepare.ts：找不到 lock.json 导入锚点')
    return before
  }
  let current = before.replace(importAnchor, importAnchor)
  const fetchAnchor = '    const response = await fetch(url)'
  if (!current.includes(fetchAnchor)) {
    report.push('!! scripts/primary-runtime/prepare.ts：找不到 fetch 锚点')
    return current
  }
  const mirrored = [
    "  // 国内/受限网络可用镜像前缀覆盖 GitHub release 直连；字节仍按 lock 校验。",
    "  const githubBase = process.env.DSH_PRIMARY_RUNTIME_GITHUB_BASE?.replace(/\\/+$/u, '') ?? ''",
    "  const effectiveUrl = githubBase !== '' && url.startsWith('https://github.com/') ? `${githubBase}/${url}` : url",
    '    const response = await fetch(effectiveUrl)',
  ].join('\n')
  return current.replace(fetchAnchor, mirrored)
}, '主运行时下载支持镜像前缀')

// ④b 打包：注册 lingdong:// 协议（安装器写进注册表，系统才知道怎么拉起客户端）
patch('apps/desktop/scripts/electron-builder-config.mjs',
  '    ],\n    mac: {',
  `    ],
    // 深链协议：官网「打开客户端」链接用 lingdong://open 拉起本客户端
    protocols: [{ name: '灵动ai创作客户端', schemes: ['lingdong'] }],
    mac: {`,
  '注册 lingdong:// 协议', 'protocols: [{ name: ')

// ④c 打包：LibreOffice 是原生程序，必须连同 ini/rdb/share 配置一起 unpack；只解 DLL 会导致 uno.ini 找不到。
updateTextFile('apps/desktop/scripts/electron-builder-config.mjs', (before) => {
  const marker = "'**/node_modules/@deepseek-ai/libreoffice-kit-*/**/*'"
  if (before.includes(marker)) return before
  const source = "      '**/*.{node,dylib,dll,so,exe}',"
  if (!before.includes(source)) return before
  return before.replace(source, source + "\n      // 原生 LibreOffice 需要完整 program/share 目录（uno.ini、services.rdb 等不能留在 asar 内）。\n      " + marker + ',')
}, '完整解包 LibreOffice 引擎')

// ④d 打包：把 LibreOffice 引擎搬到 resources/lo，并从深 asar 目录排除。
updateTextFile('apps/desktop/scripts/electron-builder-config.mjs', (before) => {
  let current = before
  const buildAnchor = '  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))'
  if (!current.includes('const officeEnginePackage')) {
    current = current.replace(buildAnchor, buildAnchor + "\n  const officeEnginePackage = resolvedPlatform === 'win32' || resolvedPlatform === 'darwin'\n    ? 'libreoffice-kit-' + (resolvedPlatform === 'win32' ? 'win32' : 'darwin') + '-' + resolvedArch\n    : undefined")
  }
  current = current.replace("? '@deepseek-ai/libreoffice-kit-' + (resolvedPlatform === 'win32' ? 'win32' : 'darwin') + '-' + resolvedArch", "? 'libreoffice-kit-' + (resolvedPlatform === 'win32' ? 'win32' : 'darwin') + '-' + resolvedArch")
  current = current.replace("filter: officeEnginePackage === undefined ? ['**/*'] : ['**/*', '!@deepseek-ai/' + officeEnginePackage + '/**/*']", "filter: ['**/*']")
  const resourcesAnchor = "      { from: buildPaths.runtime, to: 'runtime' },"
  if (!current.includes("to: 'lo'")) {
    current = current.replace(resourcesAnchor, "      ...(officeEnginePackage === undefined ? [] : [{ from: join(buildPaths.dsh, 'node_modules', '@deepseek-ai', officeEnginePackage), to: 'lo' }]),\n" + resourcesAnchor)
  }
  return current
}, 'Office 引擎短路径打包')

// ④e 打包：允许客户端独立版本号，并关闭与自研更新器冲突的上游强制更新策略。
updateTextFile('apps/desktop/scripts/electron-builder-config.mjs', (before) => {
  let text = before
  const versionLine = "  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'\n"
  const versionBlock = `  const clientVersion = env.LINGDONG_CLIENT_VERSION?.trim()
  if (clientVersion !== undefined && clientVersion !== '' && !/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/u.test(clientVersion)) {
    throw new Error('desktop package: LINGDONG_CLIENT_VERSION must be a semantic version')
  }
  const resolvedClientVersion = clientVersion === undefined || clientVersion === '' ? undefined : clientVersion
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
`
  if (!text.includes('const clientVersion = env.LINGDONG_CLIENT_VERSION')) text = text.replace(versionLine, versionBlock)
  text = text.replace("  const policy = resolveDesktopPolicyEnvironment(env)\n", "  const policy = env.LINGDONG_DISABLE_UPSTREAM_UPDATE === '1' ? undefined : resolveDesktopPolicyEnvironment(env)\n")
  text = text.replace("    extraMetadata: { dshDesktopAppId: appId, dshMandatoryUpdatePolicy: policy },", "    extraMetadata: { dshDesktopAppId: appId, author: { name: '灵动ai' }, companyName: '灵动ai', copyright: 'Copyright © 2026 灵动ai', ...(policy === undefined ? {} : { dshMandatoryUpdatePolicy: policy }), ...(resolvedClientVersion === undefined ? {} : { version: resolvedClientVersion }) },")
  return text
}, '客户端独立版本号并关闭上游强制更新策略')

// ④f 卸载清数据：新版上游把清理搬进了 installer/uninstall.nsh 的 un.CleanData（默认删除 Electron 用户数据），
// 而且 scripts/installer.nsh 已经自带 customUnInstall。我们再追加同名宏会 duplicate macro，
// 所以改成在 un.CleanData 开头询问一次：不答就保留本机凭据与聊天记录。
updateTextFile('apps/desktop/installer/uninstall.nsh', (before) => {
  if (before.includes('LINGDONG_CLEAN_OPT_IN')) return before
  const first = '  StrCpy $UnTarget "$APPDATA\\${PRODUCT_FILENAME}"' + '\n' + '  Call un.RemoveData'
  if (!before.includes(first)) {
    report.push('!! apps/desktop/installer/uninstall.nsh：找不到默认清理锚点')
    return before
  }
  const prompt = [
    '  ; LINGDONG_CLEAN_OPT_IN：默认保留本机凭据与聊天记录（学生作品目录不在这些路径内）',
    '  MessageBox MB_YESNO|MB_ICONQUESTION "是否删除本机登录凭据与聊天记录？学生作品文件夹不会删除。" /SD IDNO IDNO lingdong_skip_data',
    first,
  ].join('\n')
  let text = before.replace(first, prompt)
  const fnEnd = text.lastIndexOf('FunctionEnd')
  if (fnEnd < 0) {
    report.push('!! apps/desktop/installer/uninstall.nsh：找不到 FunctionEnd，跳过标签补写')
    return text
  }
  text = text.slice(0, fnEnd) + '  lingdong_skip_data:\n' + text.slice(fnEnd)
  return text
}, '卸载默认保留本机数据（改为询问）')

// ④g Windows 上 pnpm 11 由 Electron 24 运行时执行时会在退出阶段触发 0x80000003；安装阶段改用真实 Node。
updateTextFile('apps/desktop/scripts/prepare-dsh.ts', (before) => before.replace(
  'const child = spawn(NODE, [',
  'const child = spawn(process.execPath, [',
), 'pnpm 安装改用真实 Node 执行')

// ④h 客户端独立版本号允许与 DSH 基础运行时版本分离，但运行时完整性仍按 DSH 版本校验。
updateTextFile('apps/desktop/scripts/electron-builder-config.mjs', (before) => before
  .replaceAll('context.packager.appInfo.version', '(process.env.LINGDONG_DSH_BASE_VERSION || context.packager.appInfo.version)'), '运行时校验使用 DSH 基础版本')

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
if (failed.length > 0) process.exitCode = 1
