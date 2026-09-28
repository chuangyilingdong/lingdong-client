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
// --dry-run 必须在内存里模拟前序补丁，否则后面的锚点仍在读原始文件，会把
// 「依赖前一条补丁」误报成上游漂移。真实执行时同时写入磁盘并更新覆盖层。
const virtualCheckoutFiles = new Map()
const checkoutFile = file => resolve(checkout, file)
const checkoutHasFile = file => virtualCheckoutFiles.has(checkoutFile(file)) || existsSync(checkoutFile(file))
const readCheckoutText = (file) => {
  const virtual = virtualCheckoutFiles.get(checkoutFile(file))
  if (virtual !== undefined) return Buffer.isBuffer(virtual) ? virtual.toString('utf8') : virtual
  return readFileSync(checkoutFile(file), 'utf8')
}
const write = (file, text) => {
  virtualCheckoutFiles.set(checkoutFile(file), text)
  if (!dryRun) writeFileSync(checkoutFile(file), text)
}
/** Copy a file and expose its new contents to later dry-run patch reads. */
const copyIntoCheckout = (source, target) => {
  const destination = resolve(target)
  if (!dryRun) copyFileSync(source, destination)
  virtualCheckoutFiles.set(destination, readFileSync(source))
}
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
  if (!checkoutHasFile(file)) { report.push(`!! ${file}：文件不存在`); return }
  const before = readCheckoutText(file)
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
if (!dryRun) mkdirSync(gateTarget, { recursive: true })
for (const name of readdirSync(gateSource)) copyIntoCheckout(join(gateSource, name), join(gateTarget, name))
copyIntoCheckout(join(patchDir, 'lingdong.patch.yml'), join(gateTarget, 'lingdong.patch.yml'))
report.push(`✓  apps/desktop/resources/gate/：${dryRun ? '（--dry-run 未写入）' : readdirSync(gateTarget).join(' ')}`)

// ② 登录门主进程模块
if (!dryRun) mkdirSync(join(checkout, 'apps/desktop/src'), { recursive: true })
if (dryRun) copyIntoCheckout(join(patchDir, 'platform-gate.ts'), join(checkout, 'apps/desktop/src/platform-gate.ts'))
else copyFileSync(join(patchDir, 'platform-gate.ts'), join(checkout, 'apps/desktop/src/platform-gate.ts'))
report.push('✓  apps/desktop/src/platform-gate.ts：已放入')
if (!dryRun) copyFileSync(join(patchDir, 'LingdongUpdater.ts'), join(checkout, 'apps/desktop/src/LingdongUpdater.ts'))
report.push('✓  apps/desktop/src/LingdongUpdater.ts：已放入')
if (!dryRun) copyFileSync(join(patchDir, 'lingdong-office-engine.mjs'), join(checkout, 'apps/desktop/scripts/lingdong-office-engine.mjs'))
if (!dryRun) copyFileSync(join(patchDir, 'lingdong-office-engine.d.mts'), join(checkout, 'apps/desktop/scripts/lingdong-office-engine.d.mts'))
report.push('✓  apps/desktop/scripts/lingdong-office-engine.mjs：已放入（含类型声明）')
if (!dryRun) copyFileSync(join(patchDir, 'lingdong-sidebar-html-route.mjs'), join(checkout, 'apps/desktop/scripts/lingdong-sidebar-html-route.mjs'))
if (!dryRun) copyFileSync(join(patchDir, 'lingdong-sidebar-html-route.d.mts'), join(checkout, 'apps/desktop/scripts/lingdong-sidebar-html-route.d.mts'))
report.push('✓  apps/desktop/scripts/lingdong-sidebar-html-route.mjs：已放入（含类型声明）')
if (!dryRun) copyFileSync(join(patchDir, 'lingdong-design-rebrand.mjs'), join(checkout, 'apps/desktop/scripts/lingdong-design-rebrand.mjs'))
if (!dryRun) copyFileSync(join(patchDir, 'lingdong-design-rebrand.d.mts'), join(checkout, 'apps/desktop/scripts/lingdong-design-rebrand.d.mts'))
report.push('✓  apps/desktop/scripts/lingdong-design-rebrand.mjs：已放入（含类型声明）')

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
  if (!checkoutHasFile(file)) { report.push(`!! ${file}：文件不存在`); return }
  const before = readCheckoutText(file)
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

// ③a1 旧会话模型迁移：平台只允许 platform-gateway，旧会话若仍选中 deepseek-official，
// 登录后自动把 durable selection 改回平台默认模型，避免 MISSING_CREDENTIAL。
updateTextFile('packages/client/ui-model-selection/src/client/directory.ts', (before) => {
  if (before.includes('LINGDONG_PLATFORM_MODEL_MIGRATION')) return before
  let text = before
  const disposedAnchor = '  private disposed = false\n'
  if (!text.includes(disposedAnchor)) {
    report.push('!! packages/client/ui-model-selection/src/client/directory.ts：找不到 disposed 锚点')
    return before
  }
  text = text.replace(disposedAnchor, disposedAnchor + [
    '  /** LINGDONG_PLATFORM_MODEL_MIGRATION：旧会话的上游模型选择自动迁回平台网关。 */',
    '  private repairedSelection = false',
  ].join('\n') + '\n')
  const resetAnchor = '  resetConnected(): void {\n    if (this.disposed) return\n'
  if (!text.includes(resetAnchor)) {
    report.push('!! packages/client/ui-model-selection/src/client/directory.ts：找不到 resetConnected 锚点')
    return before
  }
  text = text.replace(resetAnchor, resetAnchor + '    this.repairedSelection = false\n')
  const intendedAnchor = [
    '    const projected = modelSelectionProjection(this.projected.getSnapshot())',
    '    const intended = projected?.next ?? catalog.value?.default',
  ].join('\n')
  if (!text.includes(intendedAnchor)) {
    report.push('!! packages/client/ui-model-selection/src/client/directory.ts：找不到 projected/intended 锚点')
    return before
  }
  text = text.replace(intendedAnchor, [
    '    const projected = modelSelectionProjection(this.projected.getSnapshot())',
    '    const catalogValue = catalog.value',
    '    const projectedSelection = projected?.next',
    '    const migrateToPlatform = catalogValue !== null && projectedSelection !== undefined && projectedSelection !== null',
    "      && projectedSelection.provider !== 'platform-gateway'",
    "      && catalogValue.default.provider === 'platform-gateway'",
    '    if (migrateToPlatform && !this.repairedSelection && this.available()) {',
    '      this.repairedSelection = true',
    '      void this.select(catalogValue.default).catch(() => undefined)',
    '    }',
    '    const intended = migrateToPlatform ? catalogValue.default : projectedSelection ?? catalogValue?.default',
  ].join('\n'))
  const selectionAnchor = '    const selection = projected.next ?? catalog.value.default\n'
  if (!text.includes(selectionAnchor)) {
    report.push('!! packages/client/ui-model-selection/src/client/directory.ts：找不到 selection 锚点')
    return before
  }
  return text.replace(selectionAnchor, '    const selection = migrateToPlatform ? catalog.value.default : projected.next ?? catalog.value.default\n')
}, '旧会话模型选择迁回 platform-gateway')


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
 contextSync: () => ipcRenderer.sendSync('lingdong:classroom-context-sync') as unknown,
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
    "contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' && process.isMainFrame ? createProductApi() : { protocolVersion: 1 })",
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
  const renderAnchor = `    | 'sidebar.workspaces.directoryFlow'${eol}`
  if (!text.includes(`    | 'sidebar.workspaces.lingdongPresets'`)) {
    if (text.includes(renderAnchor)) {
      text = text.replace(renderAnchor, renderAnchor
        + `    | 'sidebar.workspaces.lingdongPresets'${eol}`
        + `    | 'sidebar.workspaces.lingdongWork'${eol}`)
    } else {
      const union = "'sidebar.workspaces.directoryFlow' | 'sidebar.workspaces.session.menu.item' | 'sidebar.workspaces.session.row.action'"
      const extended = "'sidebar.workspaces.directoryFlow' | 'sidebar.workspaces.lingdongPresets' | 'sidebar.workspaces.lingdongWork' | 'sidebar.workspaces.session.menu.item' | 'sidebar.workspaces.session.row.action'"
      if (text.includes(union)) text = text.replace(union, extended)
      else text = text.replace("  & PropsRenderSlots<'sidebar.workspaces.directoryFlow'>", "  & PropsRenderSlots<'sidebar.workspaces.directoryFlow' | 'sidebar.workspaces.lingdongPresets' | 'sidebar.workspaces.lingdongWork'>")
    }
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
  const sessionState = `  // LINGDONG_CLASSROOM_SESSION_FILTER_V2：侧栏只看当前课堂工作区的会话。
  // 上一版只按“课堂开始时刻”过滤，结果把别的课堂 / 别的目录（甚至另一个账号）
  // 的历史会话也留在列表里——学生一进新课堂就能看到旧作业（学生 2026-09-27 反馈。
  const [classroomWorkspacePath, setClassroomWorkspacePath] = useState('')
  useEffect(() => {
    let alive = true
    const bridge = (window as Window & {
      readonly lingdong?: { readonly context?: () => Promise<{
        readonly workspacePath?: unknown
      } | undefined> }
    }).lingdong
    void bridge?.context?.().then(context => {
      if (!alive) return
      setClassroomWorkspacePath(typeof context?.workspacePath === 'string' ? context.workspacePath.trim() : '')
    }).catch(() => undefined)
    return () => { alive = false }
  }, [])`
  const sessionFilter = `  // LINGDONG_CLASSROOM_SESSION_FILTER_V2：只保留“当前课堂工作区”里的会话（+ 当前新会话 / 拿不到 cwd 的）。
  // 为什么不再留别的目录：学生反复反馈“新课堂里还有以前课堂的历史”，而且同一台电脑换账号登录时
  // 会继承前一个账号的会话组；工作区已经按账号隔离（见 platform-gate 的 ensureClassroomWorkspace）。
  const list = useMemo(() => {
    const bridge = (window as Window & { readonly lingdong?: { readonly context?: unknown } }).lingdong
    if (bridge?.context === undefined || classroomWorkspacePath === '') return rawList
    const normalize = (value: string): string => {
      let path = value.split(String.fromCharCode(92)).join('/')
      while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
      return path.toLocaleLowerCase('en-US')
    }
    const samePath = (left: unknown, right: string): boolean => typeof left === 'string' && normalize(left) === normalize(right)
    return {
      ...rawList,
      ids: rawList.ids.filter(id => {
        const value = rawList.byId[id] as { readonly blank?: unknown; readonly cwd?: unknown } | undefined
        if (value === undefined) return false
        if (value.blank === true) return true
        const cwd = typeof value.cwd === 'string' ? value.cwd.trim() : ''
        // 拿不到 cwd 的会话保留：宁可多显示一条，也不能把学生正在跑的会话藏掉。
        if (cwd === '') return true
        return samePath(cwd, classroomWorkspacePath)
      }),
    }
  }, [classroomWorkspacePath, rawList])`
  const oldFilterComment = '  // 只显示当前课堂工作区里的会话；浏览器测试没有 bridge 时保留上游列表行为。'
  const oldFilterStart = text.indexOf(oldFilterComment)
  if (text.includes('LINGDONG_CLASSROOM_SESSION_FILTER_V2')) {
    // 已经是最新形态。
  } else if (text.includes('LINGDONG_CLASSROOM_SESSION_FILTER')) {
    // v1（按课堂开始时刻）→ v2（只看当前课堂工作区）：两段一起换掉，避免留下未使用的 classroomStartedAt。
    const v1Start = text.indexOf('  // LINGDONG_CLASSROOM_SESSION_FILTER')
    const v1EndMarker = '  }, [classroomStartedAt, classroomWorkspacePath, rawList])'
    const v1End = v1Start < 0 ? -1 : text.indexOf(v1EndMarker, v1Start)
    if (v1Start >= 0 && v1End >= 0) {
      text = text.slice(0, v1Start) + sessionState + '\n' + sessionFilter + text.slice(v1End + v1EndMarker.length)
    }
  } else if (oldFilterStart >= 0) {
    const oldEndMarker = '  }, [classroomStartedAt, classroomWorkspacePath, rawList])'
    const oldFilterEnd = text.indexOf(oldEndMarker, oldFilterStart)
    if (oldFilterEnd >= 0) text = text.slice(0, oldFilterStart) + sessionFilter + text.slice(oldFilterEnd + oldEndMarker.length + 1)
  } else if (!text.includes('const rawList = useSessions(state => state)')) {
    text = text.replace(
      '  const list = useSessions(state => state)\n',
      '  const rawList = useSessions(state => state)\n' + sessionState + '\n' + sessionFilter + '\n',
    )
  } else if (text.includes('  const list = rawList\n')) {
    if (!text.includes('const [classroomWorkspacePath')) {
      text = text.replace('  const rawList = useSessions(state => state)\n', '  const rawList = useSessions(state => state)\n' + sessionState + '\n')
    }
    text = text.replace('  // 课堂过滤只收工作区行；其它工作区里的会话照常显示，避免切到新会话后回不去。\n  const list = rawList\n', sessionFilter + '\n')
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
  const importAnchor = [
    "import { selectOfficeEngine } from '../../../scripts/libreoffice-packages.mjs'",
    "import { selectOfficeEngine } from '../../../scripts/libreoffice-engine.ts'",
  ].find(anchor => current.includes(anchor))
  if (importAnchor === undefined) {
    report.push('!! apps/desktop/scripts/prepare-dsh.ts：找不到 Office engine import 锚点')
    return before
  }
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
  const signOutWelcome = [
    '              if (needsWelcome(value) && !quitting) {',
    '                enteredWorkspace = false',
    '                await showWelcome()',
    '                if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state)',
    '              }',
  ].join('\n')
  replaceOnce(signOutWelcome, '              if (!value.hasApiKey && quitting) return undefined', '摘掉退出后的 welcome')
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
// ④a5b macOS：品牌换名后上游 package-macos 仍按 DeepSeek Harness.app / deepseek-harness-* 找产物；
// 同时允许无 Apple 证书时出未签名 DMG/ZIP 做本机验收（正式分发仍必须签名+公证）。
updateTextFile('apps/desktop/scripts/package-macos.ts', (before) => {
  let text = before
  text = text.replace("arch === 'arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app'", "arch === 'arm64' ? 'mac-arm64' : 'mac', '灵动ai创作客户端.app'")
  text = text.replace('const base = `deepseek-harness-${version}-mac-${arch}`', 'const base = `lingdong-client-${version}-mac-${arch}`')
  return text
}, 'macOS DMG/ZIP 按灵动ai品牌命名')

updateTextFile('apps/desktop/scripts/package-target.ts', (before) => {
  let text = before
  text = text.replace(
    "if (values.unsigned && name !== 'win-x64') throw new Error('desktop package: --unsigned requires win-x64')",
    "if (values.unsigned && name !== 'win-x64' && name !== 'mac-arm64') throw new Error('desktop package: --unsigned requires win-x64 or mac-arm64')",
  )
  text = text.replace(
    "  if (target.platform === 'darwin' && !invocation.directory) {",
    "  if (target.platform === 'darwin' && !invocation.directory && !invocation.unsigned) {",
  )
  text = text.replace(
    "  } else if (target.platform === 'darwin') {",
    "  } else if (target.platform === 'darwin' && !invocation.unsigned) {",
  )
  const signedDirectoryAnchor = "    const appPath = join(buildPaths.artifacts, target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app')"
  const macVersionAnchor = "      version: resolveDesktopBuildVersion(environment, packageVersion(join(APP_ROOT, 'package.json'), 'desktop package')),"
  text = text.replace(
    [
      "      await packagingStep(run.directory, 'macos-package', () => withMacOSSigningKeychain(environment,",
      "        signingEnvironment => packageTarget(invocation, signingEnvironment, run)), secrets)",
    ].join('\n'),
    [
      "      await packagingStep(run.directory, 'macos-package', async () => {",
      '        if (invocation.unsigned) await packageTarget(invocation, environment, run)',
      '        else await withMacOSSigningKeychain(environment,',
      '          signingEnvironment => packageTarget(invocation, signingEnvironment, run))',
      '      }, secrets)',
    ].join('\n'),
  )

  const targetEnvAnchor = "    DSH_DESKTOP_TARGET_ARCH: target.arch,\n  }"
  text = text.replace(targetEnvAnchor,
    "    DSH_DESKTOP_TARGET_ARCH: target.arch,\n    DSH_DESKTOP_UNSIGNED: invocation.unsigned ? '1' : '0',\n  }")
  text = text.replace(macVersionAnchor,
    "      version: process.env.LINGDONG_CLIENT_VERSION?.trim() || resolveDesktopBuildVersion(environment, packageVersion(join(APP_ROOT, 'package.json'), 'desktop package')),")
  text = text.replace(signedDirectoryAnchor,
    "    const appPath = join(buildPaths.artifacts, target.arch === 'arm64' ? 'mac-arm64' : 'mac', '灵动ai创作客户端.app')")
  const unsignedAnchor = "  } else {\n    await signedStage('artifacts', () => execute(desktopElectronBuilderArguments(target, invocation.directory), electronBuilderEnv))"
  if (text.includes(unsignedAnchor) && !text.includes('// LINGDONG_MAC_UNSIGNED')) {
    text = text.replace(unsignedAnchor,
      "  } else if (target.platform === 'darwin') {\n    // LINGDONG_MAC_UNSIGNED：只用于本机验收，不能作为学生分发包。\n    await execute([...desktopElectronBuilderArguments(target, invocation.directory), '--config.mac.notarize=false'], electronBuilderEnv)\n    await execute(['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts', '--unsigned'], targetEnv)\n  } else {\n    await signedStage('artifacts', () => execute(desktopElectronBuilderArguments(target, invocation.directory), electronBuilderEnv))")
  }
  return text
}, 'macOS 支持品牌路径与未签名本地产物')

updateTextFile('apps/desktop/scripts/prepare-dsh.ts', (before) => before.replace(
  "    if (process.platform === 'darwin') {",
  "    if (process.platform === 'darwin' && process.env.DSH_DESKTOP_UNSIGNED !== '1') {",
), 'macOS 未签名准备阶段跳过原生运行时签名')

updateTextFile('apps/desktop/scripts/electron-builder-config.mjs', (before) => {
  let text = before
  text = text.replace(
    "  if (unsigned && resolvedPlatform !== 'win32') throw new Error('desktop package: unsigned builds require Windows')",
    "  if (unsigned && resolvedPlatform !== 'win32' && resolvedPlatform !== 'darwin') throw new Error('desktop package: unsigned builds require Windows or macOS')",
  )
  text = text.replace(
    '  const macOSSigning = packagesMacOS ? resolveMacOSSigningEnvironment(env) : undefined\n  if (packagesMacOS) resolveMacOSNotarizationEnvironment(env)',
    '  const macOSSigning = packagesMacOS && !unsigned ? resolveMacOSSigningEnvironment(env) : undefined\n  if (packagesMacOS && !unsigned) resolveMacOSNotarizationEnvironment(env)',
  )
  text = text.replace(
    "      forceCodeSigning: true,\n      hardenedRuntime: true,",
    "      forceCodeSigning: !unsigned,\n      hardenedRuntime: !unsigned,",
  )
  text = text.replace('      notarize: true,', '      notarize: !unsigned,')
  text = text.replace('    dmg: {\n      sign: true,', '    dmg: {\n      sign: !unsigned,')
  text = text.replace(
    "    artifactBuildCompleted: artifact => {\n      if (!artifact.file.endsWith('.dmg')) return",
    "    artifactBuildCompleted: artifact => {\n      if (unsigned || !artifact.file.endsWith('.dmg')) return",
  )
  text = text.replace(
    '      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))',
    '      if (!unsigned) verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))',
  )
  return text
}, 'macOS 支持未签名本地产物')

updateTextFile('apps/desktop/scripts/smoke-packaged-runtime.ts', (before) => before.replace(
  "if (values.unsigned && !windows) throw new Error('desktop smoke: unsigned artifacts require Windows')",
  "if (values.unsigned && !windows && target !== 'mac-arm64') throw new Error('desktop smoke: unsigned artifacts require Windows or macOS arm64')",
), 'smoke 允许 macOS 未签名产物')

// ④a5c：把动态 Web 端口从稳定 system 前缀移到运行时上下文快照，避免每轮变化导致 prefix cache 失效。
updateTextFile('packages/bundle/web-app/src/index.ts', (before) => before.replace(
  '      promptCtx.systemPrompt.section({',
  '      promptCtx.systemPrompt.context({',
), '动态 Web URL 移出稳定 system 前缀')

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

// ④i 课堂次数（2026-09-24，.2.4）：used >= limit 时**客户端直接禁用发送**，不再等第 6 次到网关才 429。
//    平台计数与网关拦截一直是对的（实测 5×200 → 第 6 次 429 SEND_LIMIT_EXCEEDED），缺的只是交互。
//    ⚠️ 不能只在按钮上禁用：Enter/快捷键走的是 InputShell.submit()（input/facade.ts），
//       两个入口必须读同一份快照；快照只存一份，见 client-patch/lingdong-send-state.ts 的文件头。
const sendStateTarget = join(conversationClientDir, 'lingdong-send-state.ts')
if (!dryRun) {
  mkdirSync(dirname(sendStateTarget), { recursive: true })
  copyFileSync(join(patchDir, 'lingdong-send-state.ts'), sendStateTarget)
}
report.push('✓  packages/client/ui-conversation/src/client/lingdong-send-state.ts：已放入')

updateTextFile('packages/client/ui-conversation/src/client/skeleton/InputBar.tsx', (before) => {
  let text = before
  if (!text.includes('LINGDONG_SEND_LIMIT_IMPORT')) {
    const anchor = "import css from './InputBar.module.css'"
    if (!text.includes(anchor)) {
      report.push('!! .../skeleton/InputBar.tsx：找不到 import 锚点')
      return before
    }
    text = text.replace(anchor, anchor + "\n// LINGDONG_SEND_LIMIT_IMPORT\nimport { useLingdongSendLimitReached } from '../lingdong-send-state.ts'")
  }
  if (!text.includes('LINGDONG_SEND_LIMIT_HOOK')) {
    const anchor = "  const machineBusy = input?.phase === 'adjudicating' || input?.phase === 'submitting'"
    if (!text.includes(anchor)) {
      report.push('!! .../skeleton/InputBar.tsx：找不到 machineBusy 锚点')
      return before
    }
    text = text.replace(anchor, anchor + "\n  // LINGDONG_SEND_LIMIT_HOOK：这节课次数用完 → 发送按钮直接禁用。\n  const lingdongExhausted = useLingdongSendLimitReached()")
  }
  if (!text.includes('|| lingdongExhausted')) {
    const anchor = 'empty || disabled || machineBusy || uploadsPending'
    if (!text.includes(anchor)) {
      report.push('!! .../skeleton/InputBar.tsx：找不到 primaryDisabled 锚点')
      return before
    }
    text = text.replace(anchor, 'empty || disabled || machineBusy || uploadsPending || lingdongExhausted')
  }
  return text
}, '发送按钮在次数用完时禁用')

updateTextFile('packages/client/ui-conversation/src/client/input/facade.ts', (before) => {
  let text = before
  const oldImport = "import { lingdongSendLimitNotice, lingdongSendLimitReached } from '../lingdong-send-state.ts'"
  const newImport = "import { lingdongSendLimitNotice, lingdongSendLimitReached, recordLingdongSend } from '../lingdong-send-state.ts'"
  if (text.includes(oldImport)) text = text.replace(oldImport, newImport)
  else if (!text.includes('recordLingdongSend')) {
    const anchor = "} from '@deepseek-ai/dsh-client-store'"
    if (!text.includes(anchor)) {
      report.push('!! .../input/facade.ts：找不到 client-store import 锚点')
      return before
    }
    text = text.replace(anchor, anchor + "\n// LINGDONG_SEND_LIMIT_IMPORT\n" + newImport)
  }
  const guard = [
    "    if (lingdongSendLimitReached()) {",
    "      this.notify('error', lingdongSendLimitNotice())",
    '      return',
    '    }',
  ].join('\n')
  // 一次真正的用户提交记一次：空回车（空草稿且没有附件）不是发送，不能计数。
  const counter = [
    '',
    "    // LINGDONG_SEND_COUNT_CLICK：一次真正的用户提交只记一次；空回车不算，工具轮不经过 submit。",
    "    if (this.snapshot.draft.trim() !== '' || this.attachmentIds.length > 0) recordLingdongSend()",
  ].join('\n')
  if (!text.includes('LINGDONG_SEND_LIMIT_GUARD')) {
    const anchor = "  submit(mode: InputSubmitMode = 'queue'): void {"
    if (!text.includes(anchor)) {
      report.push('!! .../input/facade.ts：找不到 submit 锚点')
      return before
    }
    text = text.replace(anchor, anchor + "\n    // LINGDONG_SEND_LIMIT_GUARD：次数用完时 Enter 与按钮都走这里，先拦住再发。\n    // 平台仍然是最终门禁（网关 429）；客户端这里只按本机点击次数显示与提前拦。\n" + guard + counter)
  } else if (!text.includes("if (this.snapshot.draft.trim() !== '' || this.attachmentIds.length > 0) recordLingdongSend()")) {
    const legacy = '\n    // LINGDONG_SEND_COUNT_CLICK：一次用户提交只记一次，工具轮不会经过 submit。\n    recordLingdongSend()'
    if (text.includes(legacy)) {
      // 旧形态（无条件计数）迁移到带内容判断的形态。
      text = text.replace(legacy, counter)
    } else if (text.includes('\n    recordLingdongSend()')) {
      text = text.replace('\n    recordLingdongSend()', counter)
    } else if (text.includes(guard)) {
      text = text.replace(guard, guard + counter)
    } else {
      report.push('!! .../input/facade.ts：找到旧闸门但找不到可迁移块')
      return before
    }
  }
  return text
}, '提交闸门在次数用完时拦住')
// ④j todo 收口（2026-09-24，.2.4）：任务已经结束、模型却没有再写一次 todo_write 时，
//    计划面板会一直停在「N 进行中 · M 待处理」（学生截图）。在 turn/end(completed) 把剩下的项收口。
updateTextFile('packages/todo/tool-todo/src/index.ts', (before) => {
  if (before.includes('LINGDONG_TODO_CLOSE')) return before
  const anchor = [
    '    apply: (state, event) => {',
    "      if (event.type === 'todo/write') return event.data.todos",
    "      if (event.type === 'turn/start') return null",
    '      return state',
    '    },',
  ].join('\n')
  if (!before.includes(anchor)) {
    report.push('!! packages/todo/tool-todo/src/index.ts：找不到 todos 投影锚点')
    return before
  }
  const replacement = [
    '    apply: (state, event) => {',
    "      if (event.type === 'todo/write') return event.data.todos",
    "      if (event.type === 'turn/start') return null",
    '      // LINGDONG_TODO_CLOSE：这一轮已经正常结束，模型却忘了把剩下的 todo 划掉。',
    '      // 计划面板读的就是这条投影，不收口就会一直停在「N 进行中 · M 待处理」。',
    "      // 只在 turn/end 且 reason.kind === 'completed' 时收；中断/报错的轮次保持原样。",
    "      if (event.type === 'turn/end') {",
    '        const reason = (event.data as { readonly reason?: { readonly kind?: unknown } }).reason',
    "        if (reason?.kind === 'completed' && state !== null && state.some(item => item.status !== 'completed')) {",
    "          return state.map(item => item.status === 'completed' ? item : { ...item, status: 'completed' as const })",
    '        }',
    '      }',
    '      return state',
    '    },',
  ].join('\n')
  let text = before.replace(anchor, replacement)
  if (text.includes('    stateVersion: 2,')) text = text.replace('    stateVersion: 2,', '    stateVersion: 3,')
  else if (!text.includes('    stateVersion: 3,')) report.push('!! packages/todo/tool-todo/src/index.ts：找不到 stateVersion 锚点')
  return text
}, 'todo 在回合正常结束时收口')

// ④k 插件预装（2026-09-24，.2.4）：7 个第三方插件随客户端分发。
//    做法：插件闭包单独装一份到 `<targets>/win-x64/runtime/plugin-profile/node_modules`
//    （resources/runtime 本来就是 extraResources，是**真目录**），desktop profile 里放
//    **指向它的 junction**。
//    ⚠️ 为什么不能把插件装进 desktop runtime 再链过去：那时 runtime 在 resources/app.asar 里，
//      app.asar 对 OS 是个**文件**，junction 的目标必须是真目录（实测：New-Item -ItemType Junction
//      指到 app.asar/... 直接 "Could not find item"）。
//    ⚠️ 为什么必须是 junction 而不是「靠 runtime 拦截层找」：实测 desktop 宿主里插件是按
//      bare specifier 从 profile 目录导入的，只落在 installation 里的包**不会**被拦截层补上
//      （21 个 entry 全部 failed to import）；闭包实体在 profile 里时，插件自己的依赖照常解析。
const vendorPluginsSource = join(patchDir, 'vendor-plugins')
const vendorPluginsTarget = join(checkout, 'apps/desktop/vendor-plugins')
if (!dryRun) {
  mkdirSync(vendorPluginsTarget, { recursive: true })
  for (const name of readdirSync(vendorPluginsSource)) {
    copyFileSync(join(vendorPluginsSource, name), join(vendorPluginsTarget, name))
  }
}
report.push(`✓  apps/desktop/vendor-plugins/：${dryRun ? '（--dry-run 未写入）' : readdirSync(vendorPluginsTarget).join(' ')}`)

updateTextFile('apps/desktop/scripts/prepare-dsh.ts', (before) => {
  if (before.includes('LINGDONG_VENDOR_PLUGINS')) return before
  const anchor = '      cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })'
  if (!before.includes(anchor)) {
    report.push('!! apps/desktop/scripts/prepare-dsh.ts：找不到 stage-packages 锚点')
    return before
  }
  const vendor = [
    '      // LINGDONG_VENDOR_PLUGINS：随客户端分发的第三方插件 tarball（本地构建的那份不在 npm 上）。',
    "      cpSync(join(APP_ROOT, 'vendor-plugins'), join(BUILD_ROOT, 'vendor-plugins'), { recursive: true })",
  ].join('\n')
  return before.replace(anchor, anchor + '\n' + vendor)
}, '把随包插件 tarball 放进 runtime 安装目录')

updateTextFile('apps/desktop/scripts/prepare-dsh.ts', (before) => {
  let text = before
  if (!text.includes('workingDirectory: string = BUILD_ROOT')) {
    const anchor = 'function runPnpm(args: readonly string[]): Promise<void> {'
    if (!text.includes(anchor)) {
      report.push('!! apps/desktop/scripts/prepare-dsh.ts：找不到 runPnpm 锚点')
      return before
    }
    text = text.replace(anchor, 'function runPnpm(args: readonly string[], workingDirectory: string = BUILD_ROOT): Promise<void> {')
    text = text.replace('      cwd: BUILD_ROOT,', '      cwd: workingDirectory,')
  }
  if (!text.includes('createRuntimeProjectMetadata, LINGDONG_PLUGIN_DEPENDENCIES')) {
    const anchor = "import { createRuntimeProjectMetadata } from '../src/project-manager.ts'"
    if (!text.includes(anchor)) {
      report.push('!! apps/desktop/scripts/prepare-dsh.ts：找不到 project-manager import 锚点')
      return before
    }
    text = text.replace(anchor, "import { createRuntimeProjectMetadata, LINGDONG_PLUGIN_DEPENDENCIES } from '../src/project-manager.ts'")
  }
  if (!text.includes('LINGDONG_PLUGIN_PROFILE')) {
    const anchor = "    if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', `libreoffice-kit-${officeEngine}`, 'prebuilds.json'))) {"
    if (!text.includes(anchor)) {
      report.push('!! apps/desktop/scripts/prepare-dsh.ts：找不到 LibreOffice 引擎检查锚点')
      return before
    }
    const stage = [
      "    // LINGDONG_PLUGIN_PROFILE：预装插件的闭包单独装一份，落在 resources/runtime 下（真目录，",
      '    // 运行时 profile 用 junction 指过去；见 deploy/desktop/apply-client-gate.mjs 的 ④k 注释）。',
      "    await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:plugin-profile', async () => {",
      "      const pluginDir = join(RUNTIME_ROOT, 'plugin-profile')",
      '      rmSync(pluginDir, { recursive: true, force: true })',
      '      mkdirSync(pluginDir, { recursive: true })',
      "      writeFileSync(join(pluginDir, 'package.json'), `${JSON.stringify({",
      "        name: 'lingdong-plugin-profile', private: true, dependencies: LINGDONG_PLUGIN_DEPENDENCIES,",
      '      }, undefined, 2)}\\n`)',
      '      // pnpm 11 对「有 install 脚本但没被批准」的依赖是硬失败（ERR_PNPM_IGNORED_BUILDS）。',
      '      // 这三个是插件带进来的可选原生加速/外部二进制下载，对孩子要跑的功能不是必须：显式列 false。',
      "      writeFileSync(join(pluginDir, 'pnpm-workspace.yaml'),",
      "        'packages:\\n  - .\\n\\noverrides:\\n  dsh-better-sidebar: 0.21.1\\n\\nnodeLinker: hoisted\\nautoInstallPeers: false\\nallowBuilds:\\n  cloudflared: false\\n  cpu-features: false\\n  ssh2: false\\n  node-pty: true\\n  koffi: true\\n  fs-ext: true\\n',",
      '        { mode: 0o600 })',
      "      cpSync(join(APP_ROOT, 'vendor-plugins'), join(pluginDir, 'vendor-plugins'), { recursive: true })",
      "      await runPnpm(['install', '--prod'], pluginDir)",
      '    })',
      '',
    ].join('\n')
    text = text.replace(anchor, stage + anchor)
  }
  return text
}, '预装插件闭包装进 resources/runtime/plugin-profile')

// ④l 侧栏 HTML 预览读得到自己的相对资源（2026-09-26，rc.2.4）。
//     症状：侧栏预览只剩没有样式的 HTML（链接是蓝紫色下划线、<ul> 带圆点、首屏挤成一列），
//     同一个文件在系统浏览器里完全正常。
//     根因：插件的 /sidebar/html 路由复用了自己的信任闸门，而沙箱 iframe 读
//     styles.css / app.js 时 Chromium 打的是 sec-fetch-site: cross-site（不透明源）—— 闸门 403。
//     实测与修法见 client-patch/lingdong-sidebar-html-route.mjs 文件头。
updateTextFile('apps/desktop/scripts/prepare-dsh.ts', (before) => {
  let text = before
  const importAnchor = "import { patchLingdongOfficeEngine } from './lingdong-office-engine.mjs'"
  if (!text.includes(importAnchor)) {
    report.push('!! apps/desktop/scripts/prepare-dsh.ts：找不到 lingdong-office-engine import 锚点')
    return before
  }
  if (!text.includes('lingdong-sidebar-html-route.mjs')) {
    text = text.replace(importAnchor, importAnchor + "\nimport { patchLingdongSidebarHtmlRoute } from './lingdong-sidebar-html-route.mjs'\nimport { patchLingdongDesignBranding } from './lingdong-design-rebrand.mjs'")
  }
  if (!text.includes('patchLingdongSidebarHtmlRoute(pluginDir)')) {
    const anchor = "      await runPnpm(['install', '--prod'], pluginDir)"
    if (!text.includes(anchor)) {
      report.push('!! apps/desktop/scripts/prepare-dsh.ts：找不到插件闭包 pnpm install 锚点')
      return before
    }
    text = text.replace(anchor, anchor + '\n      patchLingdongSidebarHtmlRoute(pluginDir)\n      // 设计 / PPT 两个插件把 iPolloWork 牌子换成灵动ai（显示层 + 模板 logo）。\n      patchLingdongDesignBranding(pluginDir)')
  }
  // 已经打过 rc.2.5 那条的检出：把“设计/PPT 换牌”补上（两步都幂等）。
  if (!text.includes('lingdong-design-rebrand.mjs')) {
    const rebrandImport = "import { patchLingdongSidebarHtmlRoute } from './lingdong-sidebar-html-route.mjs'"
    if (text.includes(rebrandImport)) {
      text = text.replace(rebrandImport, rebrandImport + "\nimport { patchLingdongDesignBranding } from './lingdong-design-rebrand.mjs'")
    }
  }
  if (!text.includes('patchLingdongDesignBranding(pluginDir)')) {
    const rebrandCall = '      patchLingdongSidebarHtmlRoute(pluginDir)'
    if (text.includes(rebrandCall)) {
      text = text.replace(rebrandCall, rebrandCall + '\n      // 设计 / PPT 两个插件把 iPolloWork 牌子换成灵动ai（显示层 + 模板 logo）。\n      patchLingdongDesignBranding(pluginDir)')
    }
  }
  return text
}, '侧栏 HTML 预览路由补丁接到预装插件闭包上')

updateTextFile('apps/desktop/src/project-manager.ts', (before) => {
  let text = before
  if (!text.includes('  linkSync,')) {
    const anchor = '  realpathSync,\n'
    if (!text.includes(anchor)) {
      report.push('!! apps/desktop/src/project-manager.ts：找不到 node:fs 锚点')
      return before
    }
    text = text.replace(anchor, anchor + '  copyFileSync,\n  linkSync,\n  readdirSync,\n  rmSync,\n  statSync,\n')
  }
  if (!text.includes('PROFILE_PATCH_FILENAME,')) {
    const anchor = '  initProfile, PROFILE_TEMPLATES, removeLinkProjections, sanitizeProfile, type ProfileTemplate,'
    if (!text.includes(anchor)) {
      report.push('!! apps/desktop/src/project-manager.ts：找不到 app-boot import 锚点')
      return before
    }
    text = text.replace(anchor, '  initProfile, PROFILE_PATCH_FILENAME, PROFILE_TEMPLATES, removeLinkProjections, sanitizeProfile, type ProfileTemplate,')
  }
  return text
}, 'project-manager 引入预装插件需要的 fs/path 符号')

patch('apps/desktop/src/project-manager.ts',
  'const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate',
  [
    'const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate',
    '// LINGDONG_PLUGIN_BUNDLES：随客户端预装的第三方插件（.2.4 起）。',
    '// 顺序有讲究：聚合包（@linxin666/dsh-web-all）必须排在 dsh-better-sidebar **前面** ——',
    '// 后者那条 disabled 表达式只在「前面已经有别的 entry 挂了 dsh-better-sidebar」时才退让，',
    '// 排反了会把 sidebar 挂两次（duplicate prefix route）。',
    'const LINGDONG_PLUGIN_BUNDLES = [',
    "  '@linxin666/dsh-web-all',",
    "  'dsh-better-sidebar',",
    "  'deepseek-idesign',",
    "  'deepseek-ippt',",
    "  'dsh-at-file',",
    "  '@liustack/modlens',",
    "  'dsh-context',",
    '] as const',
    '// 插件闭包的依赖清单：6 个走 registry。',
    '// 由 prepare:dsh 装进 resources/runtime/plugin-profile（见 apply-client-gate.mjs 的 ④k）。',
    'export const LINGDONG_PLUGIN_DEPENDENCIES: Readonly<Record<string, string>> = {',
    "  '@linxin666/dsh-web-all': '0.4.3',",
    "  'dsh-better-sidebar': '0.21.1',",
    "  'deepseek-idesign': '^0.2.2',",
    "  'deepseek-ippt': '^0.1.2',",
    "  'dsh-at-file': '^0.6.3',",
    "  '@liustack/modlens': '^3.26.3',",
    "  'dsh-context': '^0.55.0',",
    '}',
  ].join('\n'),
  '预装插件清单与依赖')

patch('apps/desktop/src/project-manager.ts',
  '      createPluginProfile(this.paths.profile)\n      removeLinkProjections(this.paths.profile)',
  '      createPluginProfile(this.paths.profile)\n      removeLinkProjections(this.paths.profile)\n      await materializePreinstalledPlugins(this.paths.profile, this.runtime.plugins)',
  'profile 里落预装插件（真实目录）')

patch('apps/desktop/src/project-manager.ts',
  '  readonly runtime: { readonly dsh: string },',
  '  readonly runtime: { readonly dsh: string; readonly plugins?: string },',
  'DesktopProjectManager 拿到预装插件目录')

patch('apps/desktop/src/project-manager.ts',
  'export function createPluginProfile(projectDir: string): void {\n  initProfile(projectDir, WEB_PROFILE.bundles)\n}',
  [
    'export function createPluginProfile(projectDir: string): void {',
    '  initProfile(projectDir, WEB_PROFILE.bundles)',
    '  enablePreinstalledPlugins(projectDir)',
    '}',
    '',
    '/**',
    ' * Enable the preinstalled plugin bundles inside an existing profile manifest.',
    ' *',
    ' * `initProfile` 只在**首次**写 manifest；升级学生的机器时那份 package.json 已经存在，',
    ' * 所以必须自己把清单补进去。收口规则：只在 profile 自己的 `cordis.patch.yml` 还在时才补 ——',
    ' * 「禁用第三方插件」那条恢复路径会把这个文件改名备份，补回去会让恢复失效、每次启动原地打转。',
    ' * @param projectDir - Desktop profile directory.',
    ' */',
    'function enablePreinstalledPlugins(projectDir: string): void {',
    "  const manifestPath = join(projectDir, 'package.json')",
    '  if (!existsSync(manifestPath) || !existsSync(join(projectDir, PROFILE_PATCH_FILENAME))) return',
    "  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {",
    '    dsh?: { profile?: { bundles?: string[] } }',
    '  }',
    '  const current = manifest.dsh?.profile?.bundles ?? []',
    '  const missing = LINGDONG_PLUGIN_BUNDLES.filter(name => !current.includes(name))',
    '  if (missing.length === 0) return',
    '  // 聚合包必须排在 dsh-better-sidebar 之前（见清单注释），所以按清单顺序重建尾段：',
    '  // 保留原有条目、去掉待插入项，再把清单整体接在末尾。',
    '  const kept = current.filter(name => !(LINGDONG_PLUGIN_BUNDLES as readonly string[]).includes(name))',
    '  const bundles = [...kept, ...LINGDONG_PLUGIN_BUNDLES]',
    '  writeJson(manifestPath, {',
    '    ...manifest,',
    '    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },',
    '  })',
    '}',
    '',
    '/**',
    " * Materialize the bundled plugin closure as real directories inside the profile.",
    ' *',
    ' * 插件闭包只随包一份（resources/runtime/plugin-profile，真目录），profile 里镜像成**真实目录**。',
    ' * ⚠️ 不能在这里用 junction：宿主按 bare specifier 从 profile 目录导入插件，Node 默认取 realpath，',
    ' *   junction 会把导入者变成 profile 之外的路径，DSH 的 runtime 拦截层就**不再给它补 `@deepseek-ai/*` 兄弟包**',
    ' *   （实测：打好的包里 web-ui-settings 直接 ERR_MODULE_NOT_FOUND）。真实目录才会落在 profile 作用域内。',
    ' * 文件用硬链接（同卷零拷贝，17k 文件 ~几秒）；跨卷或权限不允许时逐个退回复制。',
    ' * 指纹写进 node_modules/.lingdong-plugin-closure，一致就整段跳过 —— 只有随包闭包变了才重建。',
    ' * 失败只告警不抛出：少几个插件也不能让学生开不了客户端。',
    ' * @param projectDir - Desktop profile directory.',
    ' * @param pluginRoot - Bundled plugin closure directory (contains `node_modules`).',
    ' */',
    'export async function materializePreinstalledPlugins(projectDir: string, pluginRoot: string | undefined): Promise<void> {',
    '  if (pluginRoot === undefined) return',
    "  const source = join(pluginRoot, 'node_modules')",
    "  const manifest = join(pluginRoot, 'package.json')",
    '  if (!existsSync(source) || !existsSync(manifest)) return',
    "  const modules = join(projectDir, 'node_modules')",
    "  const marker = join(modules, '.lingdong-plugin-closure')",
    '  try {',
    '    const fingerprint = `${pluginRoot}|${String(statSync(manifest).mtimeMs)}|${readFileSync(manifest, \'utf8\')}`',
    '    if (existsSync(marker) && readFileSync(marker, \'utf8\') === fingerprint) return',
    '    rmSync(modules, { recursive: true, force: true })',
    '    mkdirSync(modules, { recursive: true })',
    '    const directories: string[] = []',
    '    const files: string[] = []',
    '    const collect = (relative: string): void => {',
    '      for (const entry of readdirSync(join(source, relative), { withFileTypes: true })) {',
    '        const child = relative === \'\' ? entry.name : `${relative}/${entry.name}`',
    '        if (entry.isDirectory()) { directories.push(child); collect(child); continue }',
    '        if (entry.isFile()) files.push(child)',
    '      }',
    '    }',
    '    collect(\'\')',
    '    for (const directory of directories) mkdirSync(join(modules, directory), { recursive: true })',
    '    let next = 0',
    '    const worker = async (): Promise<void> => {',
    '      for (let index = next++; index < files.length; index = next++) {',
    '        const relative = files[index]!',
    '        try { linkSync(join(source, relative), join(modules, relative)) } catch { copyFileSync(join(source, relative), join(modules, relative)) }',
    '      }',
    '    }',
    '    await Promise.all(Array.from({ length: Math.min(16, Math.max(1, files.length)) }, worker))',
    '    writeFileSync(marker, fingerprint, { mode: 0o600 })',
    '  } catch (error) {',
    "    console.warn('desktop project: preinstalled plugin materialization skipped:', error)",
    '  }',
    '}',
  ].join('\n'),
  'profile 创建/升级时启用预装插件，并把插件包链进来',
  'function enablePreinstalledPlugins(projectDir: string)')

updateTextFile('apps/desktop/src/main.ts', (before) => {
  if (before.includes('LINGDONG_PLUGIN_RESOURCE')) return before
  let text = before
  const iface = '  readonly dsh: string\n}'
  if (!text.includes(iface)) {
    report.push('!! apps/desktop/src/main.ts：找不到 RuntimeResources 锚点')
    return before
  }
  text = text.replace(iface, '  readonly dsh: string\n  // LINGDONG_PLUGIN_RESOURCE：随包预装的第三方插件闭包（真目录，不能放进 asar）。\n  readonly plugins: string\n}')
  const anchor = "    ?? (development ? join(app.getAppPath(), '.desktop-build', 'development', 'project') : join(app.getAppPath(), 'dsh'))"
  if (!text.includes(anchor)) {
    report.push('!! apps/desktop/src/main.ts：找不到 dsh 目录锚点')
    return before
  }
  text = text.replace(anchor, [
    anchor,
    '  // LINGDONG_PLUGIN_RESOURCE：预装插件闭包随 resources/runtime 分发（extraResources 是真目录；',
    '  // app.asar 对操作系统是个文件，junction 的目标不能落在里面）。',
    '  const plugins = (development ? process.env.DSH_DESKTOP_PLUGIN_ROOT : undefined)',
    "    ?? (development ? join(app.getAppPath(), '.desktop-build', 'development', 'plugin-profile') : join(process.resourcesPath, 'runtime', 'plugin-profile'))",
  ].join('\n'))
  const ret = '  return { node, nodeBin, pnpm, dsh }'
  if (!text.includes(ret)) {
    report.push('!! apps/desktop/src/main.ts：找不到 runtimeResources 返回锚点')
    return before
  }
  return text.replace(ret, '  return { node, nodeBin, pnpm, dsh, plugins }')
}, 'runtimeResources 暴露预装插件目录')
// applyRelease 的锁回调要能 await（预装插件是镜像文件，不是一条 junction）。
patch('apps/desktop/src/project-manager.ts',
  '    await this.withLock(() => {',
  '    await this.withLock(async () => {',
  'applyRelease 的 profile 准备改成异步')


// ④m 桌面壳的「应用源」改成回环形（2026-09-25，.2.4 修复）：`dsh-app://app/` → `dsh-app://127.0.0.1/`。
//    为什么：`@linxin666/dsh-web-all` 里的 `@linxin666/dsh-remote-web-ui` 会注入一个 boot 钩子
//    （`src/remote-channel-boot.ts`），把**同源**的 `/api`、`WebSocket`、`/sidebar`、`/git`、`/pet`
//    全部重写成 `/remote/...`（配对网关），并带设备头；只有 `location.hostname` 是回环
//    （`localhost`/`::1`/`127.x`）时才**跳过安装**。
//    桌面壳原来用 `dsh-app://app`（hostname=`app`）—— 在插件眼里就是「远程访问」，于是钩子装上，
//    所有本地 API 变成 403 `{code:"unpaired"}`：学生看到「新建会话失败…/api/session/create: HTTP 403」
//    与「技能中心 加载失败：HTTP 403」（2026-09-25 实机截图）。
//    改成回环形主机后：① 插件自己豁免、不再劫持；② `connection.isLoopback` 仍为 true
//    （它原本靠插件设的 `__DSH_TRANSPORT__.ownsHost` 才为 true，现在由 hostname 直接给出）。
//    实测：Electron 自定义协议（standard+secure）接受数字主机，`dsh-app://127.0.0.1/` 的
//    origin/hostname/fetch 转发都正常。
const SHELL_HOST = "'dsh-app://app'"
const SHELL_HOST_URL = "'dsh-app://app/'"
const SHELL_HOST_TPL = '`${SCHEME}://app/`'
updateTextFile('apps/desktop/src/main.ts', (before) => {
  let text = before
  for (const [from, to] of [
    [SHELL_HOST_TPL, '`${SCHEME}://127.0.0.1/`'],
    ["assertDesktopSender(event, ['app'])", "assertDesktopSender(event, ['127.0.0.1'])"],
    ["if (url.hostname === 'app') {", "if (url.hostname === '127.0.0.1') {"],
    [SHELL_HOST, "'dsh-app://127.0.0.1'"],
    [SHELL_HOST_URL, "'dsh-app://127.0.0.1/'"],
  ]) {
    if (!text.includes(from)) continue
    text = text.split(from).join(to)
  }
  return text
}, '桌面应用源改为回环形 dsh-app://127.0.0.1')

for (const file of [
  'apps/desktop/src/preload-app.ts',
  'apps/desktop/src/microphone-permissions.ts',
  'apps/desktop/src/mandatory-update-window.ts',
  'apps/desktop/src/directory-picker.ts',
]) {
  updateTextFile(file, (before) => before
    .split("location.hostname === 'app'").join("location.hostname === '127.0.0.1'")
    .split("parsed.hostname === 'app'").join("parsed.hostname === '127.0.0.1'")
    .split("assertDesktopSender(event, ['app'])").join("assertDesktopSender(event, ['127.0.0.1'])"),
  '桌面应用源改为回环形（preload/IPC 判定同步）')
}



// ⚠️ 转发层也要跟着改：`forwardWebRequest` 自己的同源闸门（origin 必须是应用源）。
updateTextFile('apps/desktop/src/web-document.ts', (before) => before
  .split("origin !== 'dsh-app://app'").join("origin !== 'dsh-app://127.0.0.1'"),
  '转发层接受新的应用源')

// ④n 学生端体验与兼容修补（2026-09-25，.2.6）。逐条对应反馈：
//   ① 技能中心（dsh-web 的 opt-in 行）打开；② 远程配对面板关掉（完全控制凭据，不该给孩子）。
//   ⑤ 去掉「上下文洞察」（dsh-context）；⑥⑦ 账号名/退出登录与底部头像合并成一行，顺带去掉「意见反馈」。
//   ⑧ 侧栏只留当前课堂的工作区与会话（同级旧课堂目录不再出现）。
//   ⑨ 「深度求索中」→「小灵VibeCoding中」。⑩ 旧图标名别名，修第三方插件从 primitives 取旧名的 React #130。
// ⑤ 去掉 dsh-context（「上下文洞察」）：清单与依赖一起摘。
updateTextFile('apps/desktop/src/project-manager.ts', (before) => before
  // ⚠️ 只在预装清单那一段里摘：下面的 LINGDONG_RETIRED_PLUGIN_BUNDLES 也有 'dsh-context' 这行，
  //    裸 split 会连它一起删（.2.9 踩过），锚点必须带上前后邻居。
  .split("  '@liustack/modlens',\n  'dsh-context',\n").join("  '@liustack/modlens',\n")
  .split("  'dsh-context': '^0.55.0',\n").join(''),
  '预装清单去掉 dsh-context（上下文洞察）')

// ⑧ 侧栏工作区树只留当前课堂：同级目录（= 其它课堂）一律不显示，用户自己挑的其它目录照旧保留。
updateTextFile('packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx', (before) => {
  if (before.includes('LINGDONG_CLASSROOM_WORKSPACES')) return before
  const anchor = '  const storedWorkspaces = useWorkspaces(state => state.items)\n'
  if (!before.includes(anchor)) {
    report.push('!! WorkspaceBrowser.tsx：找不到 storedWorkspaces 锚点')
    return before
  }
  const block = [
    '  const storedWorkspaces = useWorkspaces(state => state.items)',
    '  // LINGDONG_CLASSROOM_WORKSPACES：课堂工作区是同级的 `学生-课时名` 目录，旧课堂的就躺在旁边。',
    '  // 学生进新课堂时不该看见上一节课的工作区与会话（2026-09-25 反馈 ⑧）：',
    '  // 只保留当前课堂那一格，把它的**同级目录**滤掉，其它（学生自己挑的）目录不受影响。',
    '  const classroomWorkspaces = useMemo(() => {',
    '    const bridge = (window as Window & { readonly lingdong?: { readonly context?: unknown } }).lingdong',
    '    if (bridge?.context === undefined || classroomWorkspacePath === \'\') return storedWorkspaces',
    '    const normalizePath = (value: string): string => {',
    "      let path = value.split(String.fromCharCode(92)).join('/')",
    "      while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)",
    "      return path.toLocaleLowerCase('en-US')",
    '    }',
    "    const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))",
    '    const current = normalizePath(classroomWorkspacePath)',
    '    const parent = parentOf(current)',
    '    return storedWorkspaces.filter((workspace) => {',
    '      const path = normalizePath(workspace.path)',
    '      if (path === current) return true',
    '      return parentOf(path) !== parent',
    '    })',
    '  }, [classroomWorkspacePath, storedWorkspaces])',
    '',
  ].join('\n')
  return before
    .replace(anchor, block)
    .replace('    () => storedWorkspaces.map(workspace => ({', '    () => classroomWorkspaces.map(workspace => ({')
    .replace('    [storedWorkspaces, defaultWorkspaceName],', '    [classroomWorkspaces, defaultWorkspaceName],')
}, '侧栏工作区树只显示当前课堂')

// ⑥⑦ 账号区合并成一行：隐藏上游账号启动器（它的菜单只有「设置/意见反馈」），
//      身份+退出登录由我们自己的 footer 行承担。
updateTextFile('packages/client/ui-settings-account/src/client/AccountMenu.tsx', (before) => {
  if (before.includes('LINGDONG_ACCOUNT_MERGE')) return before
  const anchor = '  return <div ref={anchor} className={css.root}>'
  if (!before.includes(anchor)) {
    report.push('!! AccountMenu.tsx：找不到 return 锚点')
    return before
  }
  return before.replace(anchor, [
    '  // LINGDONG_ACCOUNT_MERGE：账号名/退出登录已经在侧栏 footer 那行（LingdongAccountPanel），',
    '  // 再留一个头像启动器就是同一件事出现两次，而且它的菜单只有「设置/意见反馈」——学生端都不要。',
    '  if (lingdongGate) return null',
    anchor,
  ].join('\n'))
}, '账号启动器与 footer 账号行合并（顺带去掉「意见反馈」）')

// ⑨ 运行中文案：深度求索中 → 小灵VibeCoding中
updateTextFile('packages/client/ui-chat/src/client/locale.ts', (before) => before
  .replace("'message.turnProcess.deepDivingFor': '深度求索中，用时{duration}'", "'message.turnProcess.deepDivingFor': '小灵VibeCoding中，用时{duration}'")
  .replace("'chat.deepDiving': '深度求索中'", "'chat.deepDiving': '小灵VibeCoding中'"),
  '运行文案改为「小灵VibeCoding中」')

// ⑩ 旧图标名别名：`@linxin666/dsh-web-all@0.4.3` 内的 git-graph / remote-web-ui 等还在用 `IconXxx16/14`，
//    0.1.7 已改名 `*Medium`；缺了就是 undefined，React 直接抛 #130（Element type is invalid），
//    右侧「侧边对话 / 浏览器」整块打不开（2026-09-25 反馈 ⑩）。
updateTextFile('packages/client/ui-primitives/src/index.ts', (before) => {
  if (before.includes('LINGDONG_LEGACY_ICON_ALIASES')) return before
  return before + [
    '',
    '// LINGDONG_LEGACY_ICON_ALIASES：0.1.6 时代的 `*14` / `*16` 图标名 → 0.1.7 的 `*Medium`。',
    '// 0.21.1 sidebar 已自带旧名图标；这里保留是给聚合包内仍从 primitives 导入旧名的插件兜底。',
    "export { IconApiOutlineMedium as IconApiOutline14 } from './icons/index.tsx'",
    "export { IconBrowseOutlineMedium as IconBrowseOutline16 } from './icons/index.tsx'",
    "export { IconCheckOutlineMedium as IconCheckOutline16 } from './icons/index.tsx'",
    "export { IconChevronDownOutlineMedium as IconChevronDownOutline14 } from './icons/index.tsx'",
    "export { IconChevronLeftOutlineMedium as IconChevronLeftOutline14 } from './icons/index.tsx'",
    "export { IconChevronRightOutlineMedium as IconChevronRightOutline14 } from './icons/index.tsx'",
    "export { IconCloseFillMedium as IconCloseFill14 } from './icons/index.tsx'",
    "export { IconCloseOutlineMedium as IconCloseOutline16 } from './icons/index.tsx'",
    "export { IconCodeOutlineMedium as IconCodeOutline16 } from './icons/index.tsx'",
    "export { IconCopyOutlineMedium as IconCopyOutline16 } from './icons/index.tsx'",
    "export { IconDownloadOutlineMedium as IconDownloadOutline16 } from './icons/index.tsx'",
    "export { IconEditOutlineMedium as IconEditOutline16 } from './icons/index.tsx'",
    "export { IconFolderOpenMedium as IconFolderOpen16 } from './icons/index.tsx'",
    "export { IconLinkOutlineMedium as IconLinkOutline14 } from './icons/index.tsx'",
    "export { IconLinkOutlineMedium as IconLinkOutline16 } from './icons/index.tsx'",
    "export { IconListPenOutlineMedium as IconListPenOutline16 } from './icons/index.tsx'",
    "export { IconNewChatOutlineMedium as IconNewChatOutline16 } from './icons/index.tsx'",
    "export { IconPanelLeftOutlineMedium as IconPanelLeftOutline16 } from './icons/index.tsx'",
    "export { IconPlusOutlineMedium as IconPlusOutline16 } from './icons/index.tsx'",
    "export { IconRefreshOutlineMedium as IconRefreshOutline14 } from './icons/index.tsx'",
    "export { IconRefreshOutlineMedium as IconRefreshOutline16 } from './icons/index.tsx'",
    "export { IconRightUpOutlineMedium as IconRightUpOutline16 } from './icons/index.tsx'",
    "export { IconSearchOutlineMedium as IconSearchOutline16 } from './icons/index.tsx'",
    "export { IconSendOutlineMedium as IconSendOutline16 } from './icons/index.tsx'",
    "export { IconSettingsOutlineMedium as IconSettingsOutline16 } from './icons/index.tsx'",
    "export { IconSparkleMedium as IconSparkle16 } from './icons/index.tsx'",
    "export { IconStopFillMedium as IconStopFill16 } from './icons/index.tsx'",
    "export { IconTrashOutlineMedium as IconTrashOutline16 } from './icons/index.tsx'",
    "export { IconWarningOutlineMedium as IconWarningOutline16 } from './icons/index.tsx'",
    '',
  ].join('\n')
}, '补齐旧图标名别名（修第三方插件 React #130）')

// ③ 数据目录：`resolveDesktopPaths()` 走 resolveDshHome()，必须在它之前把 DSH_HOME 定下来，
//    否则 profile 会落到共享的 %USERPROFILE%\.dsh（2026-09-25 反馈 ③）。
updateTextFile('apps/desktop/src/main.ts', (before) => {
  if (before.includes('LINGDONG_DSH_HOME')) return before
  const anchor = '  const paths = resolveDesktopPaths()\n'
  if (!before.includes(anchor)) {
    report.push('!! apps/desktop/src/main.ts：找不到 resolveDesktopPaths 锚点')
    return before
  }
  return before.replace(anchor, [
    '  // LINGDONG_DSH_HOME：桌面端自己的数据目录。必须在任何 resolveDshHome() 之前设好 ——',
    '  // 登录门里那句 `process.env.DSH_HOME = home` 跑在这之后，profile 会落到共享的 ~/.dsh，',
    '  // 和 sessions/storages/lingdong.patch.yml（都在 userData/dsh-home）分家。',
    "  process.env.DSH_HOME = (process.env.DSH_HOME ?? '').trim() !== '' ? process.env.DSH_HOME : join(app.getPath('userData'), 'dsh-home')",
    anchor.trimEnd(),
    '',
  ].join('\n'))
}, 'profile 与其它数据同用 userData/dsh-home')



// ④r 「打开文件」咽喉点兜底（2026-09-26，.2.10）：DSH 的 `fileAddressFor()` 会把工作区内的绝对路径
//     降级成相对拼写，本意由侧栏插件用会话 cwd 还原；而 dsh-better-sidebar@0.19.1 在 0.1.7 上拿不到
//     cwd，于是相对路径送到宿主被解析成盘根 —— 侧栏预览 fs-error（学生图3）、reveal 静默失败（图2）。
//     在 ui-chat 的 openFile 唯一咽喉处改成「先拼绝对 + sessionFileAddress」，绕开降级，
//     工具行 / 变更行 / @ 提及 这些入口一并覆盖。实现与取舍见 client-patch/lingdong-open-path.ts。
const openPathHelperTarget = join(checkout, 'packages/client/ui-chat/src/client/lingdong-open-path.ts')
if (!dryRun) {
  mkdirSync(dirname(openPathHelperTarget), { recursive: true })
  copyFileSync(join(patchDir, 'lingdong-open-path.ts'), openPathHelperTarget)
}
report.push('✓  packages/client/ui-chat/src/client/lingdong-open-path.ts：已放入')

updateTextFile('packages/client/ui-chat/src/client/apply.ts', (before) => {
  if (before.includes('lingdongFileAddress')) return before
  let text = before
  const importLine = "import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'"
  if (!text.includes(importLine)) {
    report.push('!! packages/client/ui-chat/src/client/apply.ts：找不到 workspace-path import 锚点')
    return before
  }
  text = text.replace(importLine, "import { lingdongFileAddress } from './lingdong-open-path.ts'")
  const callLine = 'const url = fileAddressFor(sessionId, cwd, path)'
  if (!text.includes(callLine)) {
    report.push('!! packages/client/ui-chat/src/client/apply.ts：找不到 fileAddressFor 调用锚点')
    return before
  }
  return text.replace(callLine, 'const url = lingdongFileAddress(sessionId, cwd, path)')
}, '交付/文件打开的地址改为绝对路径（绕开降级）')

// ④q 数据目录改名 + 老机器迁移（2026-09-25，.2.9）：Electron 的 userData 一直跟着**上游包名**
//     走 —— `%APPDATA%\@deepseek-ai\dsh-desktop`；产品却叫「灵动ai创作客户端」。学生的登录态、
//     会话、388MB 插件镜像全在那个"看不出是谁"的目录里，老师找数据 / 卸载清理都对不上。
//     改成产品名，并在**任何 getPath('userData') 之前**做一次性迁移；迁移失败原地退回老目录
//     （绝不让学生丢登录态）。实现与取舍见 client-patch/lingdong-user-data.ts 文件头。
const userDataHelperTarget = join(checkout, 'apps/desktop/src/lingdong-user-data.ts')
if (!dryRun) {
  mkdirSync(dirname(userDataHelperTarget), { recursive: true })
  copyFileSync(join(patchDir, 'lingdong-user-data.ts'), userDataHelperTarget)
}
report.push('✓  apps/desktop/src/lingdong-user-data.ts：已放入')

patch('apps/desktop/src/main.ts',
  "import { join } from 'node:path'",
  "import { adoptLingdongUserData } from './lingdong-user-data.ts'\nimport { join } from 'node:path'",
  '数据目录改名：引入')

patch('apps/desktop/src/main.ts',
  'let focusPrimaryWindow = (): void => {}',
  "// ⚠️ 必须在任何 app.getPath('userData') 之前跑（见 lingdong-user-data.ts 文件头）。\nadoptLingdongUserData()\nlet focusPrimaryWindow = (): void => {}",
  '数据目录改名：落地')

// ④p 学生端可用性收口（2026-09-25，.2.9）。逐条对应这一轮学生实机反馈：
//   ① dsh-at-file@0.6.3 用的是 0.1.5/0.1.6 的 settingsNamespace，在 DSH 0.1.7 上宿主日志直接
//      failed to import（@ 文件功能本来就是坏的）。产品口径「坏功能先移除」→ 从预装清单摘掉；
//      并且升级时要把旧机器 profile manifest 里的那条**也删掉**（enablePreinstalledPlugins
//      原来只会补、不会删，旧机器会一直留着一条已经不随包分发的 entry）。
//   ② 首启要把插件闭包（~388MB / 1.7 万文件）镜像进 profile，实测 26-28 秒，卡在「登录之后、
//      宿主起来之前」——学生看到的是点完登录干等半分钟。改成提前预热：在更新检查与登录门之前就
//      开跑，把这段等待藏进那几屏；真正要起宿主时再 await（见 main.ts 里那段注记）。
//   ③ 交付文件的预览与「在文件管理器中显示」都必须拿绝对路径。DSH 的 file-address 是「相对会话
//      工作区的路径」，dsh-better-sidebar 在渲染端用会话摘要的 cwd 把它拼成绝对路径；cwd 一缺
//      就退化成 /index.html，宿主的 requireAbsolute 又把它解析成 C:\index.html —— 于是侧栏预览
//      报 fs-error: cannot resolve target，reveal 静默失败（两处都见过）。我们在调用点用课堂
//      工作区兜底，见 client-patch/LingdongWorkspacePath.ts。
const workspacePathHelperTarget = join(checkout, 'packages/client/ui-deliverables/src/client/LingdongWorkspacePath.ts')
if (!dryRun) {
  mkdirSync(dirname(workspacePathHelperTarget), { recursive: true })
  copyFileSync(join(patchDir, 'LingdongWorkspacePath.ts'), workspacePathHelperTarget)
}
report.push('✓  packages/client/ui-deliverables/src/client/LingdongWorkspacePath.ts：已放入')

updateTextFile('apps/desktop/src/project-manager.ts', (before) => {
  let text = before
  // 只从 LINGDONG_PLUGIN_BUNDLES 数组块里摘 dsh-at-file；不能裸 split 全文件，否则会把下面的
  // LINGDONG_RETIRED_PLUGIN_BUNDLES 里同名保留项一起删掉。也不能只匹配某个邻居：后续补丁会在
  // dsh-better-sidebar 和 dsh-at-file 之间插入设计 / PPT 插件。
  const atFileBundleHead = text.indexOf('const LINGDONG_PLUGIN_BUNDLES = [')
  const atFileBundleTail = atFileBundleHead >= 0 ? text.indexOf('] as const', atFileBundleHead) : -1
  if (atFileBundleHead >= 0 && atFileBundleTail > atFileBundleHead) {
    const bundleBlock = text.slice(atFileBundleHead, atFileBundleTail)
    text = text.slice(0, atFileBundleHead)
      + bundleBlock.split("  'dsh-at-file',\n").join('')
      + text.slice(atFileBundleTail)
  }
  // 2026-09-27：dsh-find-plugin 也从预装里摘掉 —— 它只给模型加了一个搜 GitHub 插件的工具
  // （find_dsh_plugin），学生用不到，网络不通就是一次报错。
  text = text.split("  'dsh-better-sidebar',\n  'dsh-find-plugin',\n").join("  'dsh-better-sidebar',\n")
  text = text.split("  'dsh-find-plugin': '^0.3.7',\n").join('')
  // 2026-09-27（rc.2.6）：预装 iPolloWork 的「设计 / PPT」两个插件（视频插件不预装，它带一堆原生依赖）。
  // 学生端不需要插件市场，走预装 + profile 镜像这条路。
  if (!text.includes("  'deepseek-idesign',")) {
    text = text.split("  'dsh-better-sidebar',\n").join("  'dsh-better-sidebar',\n  'deepseek-idesign',\n  'deepseek-ippt',\n")
  }
  if (!text.includes("'deepseek-idesign':")) {
    text = text.split("  '@liustack/modlens': '^3.26.3',\n").join("  'deepseek-idesign': '^0.2.2',\n  'deepseek-ippt': '^0.1.2',\n  '@liustack/modlens': '^3.26.3',\n")
  }
  text = text.split("  'dsh-at-file': '^0.6.3',\n").join('')
  text = text.split("  '@liustack/modlens',\n  '@yuxianglin/dsh-bridge-browser',\n").join("  '@liustack/modlens',\n")
  text = text.split("  '@yuxianglin/dsh-bridge-browser': 'file:./vendor-plugins/yuxianglin-dsh-bridge-browser-0.0.5.tgz',\n").join('')
  const comments = [
    '// LINGDONG_RETIRED_PLUGIN_BUNDLES：**已经**从预装清单里摘掉的插件，升级时顺手从 profile',
    '// manifest 里删名 —— 只加不减的话，旧机器会留着一条已经不随包分发的 entry，宿主每轮都',
    '// failed to import（那正是学生看到的报错来源）。',
    '//   · dsh-context：.2.6 起删（「上下文洞察」产品取舍）；',
    '//   · dsh-at-file：.2.9 起删（0.6.3 的 settingsNamespace 在 0.1.7 上不兼容）；',
    '//   · @yuxianglin/dsh-bridge-browser：rc.2.1 起删（真正的 Chrome 扩展未随包，学生端会出现“连不上桥”）。',
    '//   · dsh-find-plugin：rc.2.5 起删（只给模型加了个搜 GitHub 插件的工具，学生用不到）。',
  ].join('\n')
  const list = [
    'const LINGDONG_RETIRED_PLUGIN_BUNDLES = [',
    "  'dsh-context',",
    "  'dsh-at-file',",
    "  '@yuxianglin/dsh-bridge-browser',",
    "  'dsh-find-plugin',",
    '] as const',
    '',
  ].join('\n')
  const head = 'const LINGDONG_RETIRED_PLUGIN_BUNDLES = ['
  const tail = '] as const\n'
  const at = text.indexOf(head)
  if (at >= 0) {
    // 自愈：名单被别的补丁动过（条目丢了）就整块重写，保证两条都在。
    const commentAt = text.indexOf('// LINGDONG_RETIRED_PLUGIN_BUNDLES：')
    const start = commentAt >= 0 && commentAt < at ? commentAt : at
    const end = text.indexOf(tail, at)
    if (end >= 0) text = text.slice(0, start) + comments + '\n' + list + text.slice(end + tail.length)
  } else {
    const anchor = '] as const\n// 插件闭包的依赖清单'
    if (!text.includes(anchor)) {
      report.push('!! apps/desktop/src/project-manager.ts：找不到预装清单锚点')
      return before
    }
    text = text.replace(anchor, '] as const\n' + comments + '\n' + list + '// 插件闭包的依赖清单')
  }
  return text
}, '预装清单摘掉 dsh-at-file、补上设计/PPT 插件')

updateTextFile('apps/desktop/src/project-manager.ts', (before) => {
  // 幂等：已经改过的机器直接跳过（旧写法里没有 LINGDONG_RETIRED_PLUGIN_BUNDLES 这一句）。
  if (before.includes('LINGDONG_RETIRED_PLUGIN_BUNDLES as readonly string[]')) return before
  const anchor = [
    '  const current = manifest.dsh?.profile?.bundles ?? []',
    '  const missing = LINGDONG_PLUGIN_BUNDLES.filter(name => !current.includes(name))',
    '  if (missing.length === 0) return',
    '  // 聚合包必须排在 dsh-better-sidebar 之前（见清单注释），所以按清单顺序重建尾段：',
    '  // 保留原有条目、去掉待插入项，再把清单整体接在末尾。',
    '  const kept = current.filter(name => !(LINGDONG_PLUGIN_BUNDLES as readonly string[]).includes(name))',
    '  const bundles = [...kept, ...LINGDONG_PLUGIN_BUNDLES]',
  ].join('\n')
  const replacement = [
    '  const current = manifest.dsh?.profile?.bundles ?? []',
    '  // 聚合包必须排在 dsh-better-sidebar 之前（见清单注释），所以按清单顺序重建尾段：',
    '  // 保留原有条目、去掉待插入项（含已摘掉的 LINGDONG_RETIRED_PLUGIN_BUNDLES），再把清单接在末尾。',
    '  const kept = current.filter(name => !(LINGDONG_PLUGIN_BUNDLES as readonly string[]).includes(name)',
    '    && !(LINGDONG_RETIRED_PLUGIN_BUNDLES as readonly string[]).includes(name))',
    '  const bundles = [...kept, ...LINGDONG_PLUGIN_BUNDLES]',
    '  if (bundles.length === current.length && bundles.every((name, index) => name === current[index])) return',
  ].join('\n')
  if (!before.includes(anchor)) {
    report.push('!! apps/desktop/src/project-manager.ts：找不到 enablePreinstalledPlugins 锚点')
    return before
  }
  return before.replace(anchor, replacement)
}, '升级时把摘掉的插件从旧清单里删除')

patch('apps/desktop/src/main.ts',
  '  if (await runLingdongUpdater()) { app.quit(); return }',
  [
    '  // 灵动ai 预装插件预热（2026-09-25，.2.9）：首启要把插件闭包镜像进 profile，实测 26-28 秒，',
    '  // 而且卡在「登录之后、宿主起来之前」。这段时间学生本来就在更新检查/登录页/等上课页上，',
    '  // 所以这里提前开跑把等待藏起来；真正要起宿主时（reconcileBackend）再 await 它。',
    '  // 为什么要有这个包装：applyRelease 用的是**进程级 profile 文件锁**，同一个进程里再调一次',
    '  // 会直接抛「another profile operation is active」——所以进程内只跑一次，失败则不缓存以便重试。',
    '  let lingdongProfilePrepare: Promise<void> | undefined',
    '  const lingdongPrepareProfile = (): Promise<void> => {',
    '    lingdongProfilePrepare ??= manager.applyRelease().catch((error: unknown) => {',
    '      lingdongProfilePrepare = undefined',
    '      throw error',
    '    })',
    '    return lingdongProfilePrepare',
    '  }',
    '  // 失败只记一行：预热不是启动的必要条件，正常启动路径会重试并把真正的错误暴露出来。',
    '  void lingdongPrepareProfile().catch((error: unknown) => {',
    "    console.warn('[lingdong] 预装插件预热失败，交给正常启动路径重试', error)",
    '  })',
    '  if (await runLingdongUpdater()) { app.quit(); return }',
  ].join('\n'),
  '④p 预装插件预热')

patch('apps/desktop/src/main.ts',
  '        await manager.applyRelease()',
  '        await lingdongPrepareProfile()',
  '④p 启动路径复用预热结果')
console.log(`检出：${checkout}${dryRun ? '（--dry-run）' : ''}`)
for (const line of report) console.log('  ' + line)

const failed = report.filter((line) => line.startsWith('!!'))
console.log(failed.length ? `\n!! ${failed.length} 处需要人工看一眼（多半是上游漂了）` : '\n登录门已接入。')
if (failed.length > 0) process.exitCode = 1
