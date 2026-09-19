import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'

/**
 * 灵动ai 创作客户端的「登录门」（2026-09-19）。
 *
 * 三件事，都必须在 **dsh 启动之前** 完成：
 *   ① 让学生用**我们的账号密码**登录 —— dsh 自己没有用户体系（只有一个进程级 cookie、没有 logout，
 *      官方注明 identity 包里的 UUID「Do not use it to identify a user」），账号体系只能是我们的；
 *   ② 向我们的服务端要这节课的上下文（`GET /api/student/runtime/client-context`）：
 *      **运行时密钥** + 网关地址 + 预设提示词 + 剩余发送次数；
 *   ③ **没有正在进行的课堂就不启动 dsh**（老师没点「立即上课」→ 学生只看到「等老师开始上课」）。
 *      这不只是"不让进"：没有密钥，dsh 就算起来了也调不动网关（网关每次调用重新过门禁）。
 *
 * 网关注入的三个落点：
 *   · **环境变量**（**承重的那一条**）：Electron 主进程的 `process.env` 会被
 *     `desktopNodeEnvironment()` 原样传给 dsh，所以这里把 `PLATFORM_GATEWAY_KEY` /
 *     `PLATFORM_GATEWAY_BASE_URL` 写进 `process.env`；而宿主进程的环境是 **spawn 那一刻**
 *     定下来的，所以过门之后还要 `resetHost()` 把可能已经起来的宿主停一次（见 runLingdongGate）。
 *   · **补丁层**：把随包的 `lingdong.patch.yml` 写到 `$DSH_HOME/lingdong.patch.yml`，由桌面宿主
 *     放进 `patchFiles`（见 apps/desktop-host/src/index.ts 的三行改动）。
 *     ⚠️ **不要写 profile 里的 `cordis.patch.yml`**：桌面宿主显式传的是 `patchFiles: []`，而
 *        `profile-context.ts` 是 `initialProfile?.patches ?? loadOptionalPatches(...)` ——
 *        空数组不是 undefined，所以那个文件**永远不会被读**；而且 app 的恢复流程还会把它重置并备份掉。
 *   · **凭据文件的 `refs`**：一并写上（见 writeGatewayCredential），但**别把它当承重的那一条** ——
 *     补丁层声明的是 `apiKeyEnv: PLATFORM_GATEWAY_KEY`（读环境变量），而不是 `apiKeyRef`，
 *     所以 `refs` 里那个键现在我们这条链路上**没有任何读方**。上一轮"写凭据文件也没用"的结论
 *     就来自这里，那是**实验设计的问题**，不是"宿主起太早"的证据。
 */
const GATE_DIR = app.isPackaged
  ? join(process.resourcesPath, 'gate')
  : join(app.getAppPath(), 'resources', 'gate')
const API_BASE = String(process.env.LINGDONG_API_BASE || 'https://iicili.cyou').replace(/\/$/, '')

interface LingdongUser { readonly displayName?: string; readonly login?: string }
interface LingdongSession { readonly token: string; readonly user?: LingdongUser }
interface LingdongContext {
  readonly classroom: { readonly id: string; readonly lessonId?: string; readonly title?: string } | null
  readonly gateway?: { readonly baseUrl?: string; readonly key?: string }
  readonly presets?: readonly { readonly title: string; readonly text: string }[]
  readonly sends?: { readonly limit: number | null; readonly used: number; readonly remaining: number | null } | null
  readonly message?: string
}
interface WorkFilePayload { readonly name: string; readonly content: string; readonly binary: boolean }
interface WorkBatchItem {
  readonly sessionId: string
  readonly sessionTitle: string
  readonly cwd: string
  readonly path: string
  readonly displayPath?: string
}
interface WorkAsset {
  readonly absolute: string
  readonly name: string
  readonly binary: boolean
  text?: string
  content: string
}
interface PreparedWork {
  readonly name: string
  readonly files: readonly WorkFilePayload[]
  readonly missing: readonly string[]
}
type GateAction = { action: 'login' } | { action: 'refresh' } | { action: 'logout' }
type GateOutcome = { kind: 'enter' } | { kind: 'quit' }

const MAX_WORK_FILES = 60
const MAX_WORK_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_WORK_REQUEST_BYTES = 24 * 1024 * 1024
const TEXT_WORK_EXTENSIONS = new Set([
  '.css', '.csv', '.htm', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.cjs', '.svg', '.text',
  '.ts', '.tsx', '.txt', '.webmanifest', '.xml', '.yaml', '.yml',
])
const SCANNABLE_WORK_EXTENSIONS = new Set(['.css', '.htm', '.html', '.svg'])
/** 平台错误要保留业务 code；界面上仍展示平台原始 message。 */
class PlatformRequestError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'PlatformRequestError'
    this.code = code
  }
}

/**
 * 深链 `lingdong://open` 的落点（官网点「进入课堂 / 打开客户端」时由系统拉起）。
 * 作用只有一个：**把客户端叫到前台并让等待页重新问一次"现在有没有课"** ——
 * 学生不用自己去点刷新。登录页时它什么都不做（得先把账号登进去）。
 */
let notifyDeepLink: (() => void) | null = null
export function lingdongDeepLink(): void {
  try { notifyDeepLink?.() } catch { /* 深链只是便利，出错不该影响客户端 */ }
}

/** 门当前用的那个窗口（`show()` 里更新），只给 `matchTitleBarToGate` 用。 */
let currentGateWindow: BrowserWindow | null = null

/**
 * Windows 的主窗口是无边框的（`titleBarStyle: 'hidden'` + `titleBarOverlay`）：
 * 最小化/最大化/关闭那三个系统按钮画在**一层纯色条**上，默认颜色是深灰 —— 压在我们这张
 * 深红页面顶上会是一条很明显的色带（参考图里那条正好是深红）。我们的三个页面
 * （登录 / 等老师开始上课 / 准备中）是同一支深红，所以过门时统一把它调成页面顶边的颜色。
 * 非 Windows 与「窗口不是无边框」的两种情况都会抛/无意义，一律忽略。
 */
function matchTitleBarToGate(): void {
  if (process.platform !== 'win32') return
  try {
    const window = currentGateWindow
    if (window === null || window.isDestroyed()) return
    window.setTitleBarOverlay({ color: '#5c0e1b', symbolColor: '#ffd9de', height: WINDOWS_TITLEBAR_HEIGHT })
  } catch { /* 非 frameless 窗口没有叠加层，忽略 */ }
}

const sessionFile = (): string => join(app.getPath('userData'), 'lingdong-session.json')

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8').trim()
    return text ? (JSON.parse(text) as T) : null
  } catch { return null }
}
function readSession(): LingdongSession | null {
  const session = readJson<LingdongSession>(sessionFile())
  return session && typeof session.token === 'string' && session.token ? session : null
}
function writeSession(session: LingdongSession | null): void {
  try { writeFileSync(sessionFile(), session === null ? '' : JSON.stringify(session, null, 2)) } catch { /* 存不下就当没登录 */ }
}

async function call(path: string, { method = 'GET', body, token }: { method?: string; body?: unknown; token?: string } = {}): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const init: RequestInit = { method, headers }
  // ⚠️ 上游开了 `exactOptionalPropertyTypes`：不能写成 `body: undefined`，要按需赋值。
  if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(`${API_BASE}${path}`, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : undefined
    throw new PlatformRequestError(
      String(payload?.error?.message || payload?.message || `平台请求失败（HTTP ${response.status}）`),
      code,
    )
  }
  return payload?.data ?? payload
}

/**
 * 把 dsh 的默认模型指到我们网关（写 `$DSH_HOME/settings.yaml`）。
 *
 * ⚠️ **必须改这里，不能只靠补丁层的 `agent-default-model`**：用户层设置盖过补丁层。
 *    学生机器上那份 settings 里存着**上游模型**（`deepseek-official/deepseek-v4-pro`），
 *    而官方渠道已被我们禁用 —— 一发就 `NO_ADAPTER: no adapter registered for provider "deepseek-official"`
 *    （实测报错）。这正是客户端界面显示「当前模型不可用」的原因。
 * ⚠️ **不能带 `reasoningEffort`**：手写声明的渠道不认它 —— 带上会报
 *    `UNSUPPORTED_REASONING_EFFORT: provider "platform-gateway" model "deepseek-flash"
 *     does not support reasoning effort "low"`（实测），去掉才回落到渠道默认。
 * 只改这一个键，其余设置原样保留；改前留一份 .lingdong-backup。
 */
function pointDefaultModelToGateway(home: string): void {
  const file = join(home, 'settings.yaml')
  let text = ''
  try { text = existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { return }
  const block = 'agent-default-model:\n  provider: platform-gateway\n  model: deepseek-flash\n'
  const next = /^agent-default-model:\n(?:[ \t]+.*\n)*/mu.test(text)
    ? text.replace(/^agent-default-model:\n(?:[ \t]+.*\n)*/mu, block)
    : block + text
  if (next === text) return
  try {
    const backup = `${file}.lingdong-backup`
    if (existsSync(file) && !existsSync(backup)) writeFileSync(backup, text)
    writeFileSync(file, next)
  } catch (error) { console.error('灵动ai：写入默认模型失败（不影响登录）', error) }
}

/**
 * 把运行时密钥写进 dsh 的**凭据文件**（`$DSH_HOME/.credentials.yaml` 的 `refs`）。
 *
 * ⚠️ **这不是承重的那一条**（承重的是 `process.env` + 过门后重启宿主，见文件头与
 *    runLingdongGate 的 @param resetHost）：补丁层声明的是 `apiKeyEnv: PLATFORM_GATEWAY_KEY`，
 *    读的是环境变量；`refs` 里这个键目前**没有读方**。留着它是零成本的保险 ——
 *    哪天有人把补丁层改成 `apiKeyRef`，这条链路就已经是通的。
 *    上一轮"写凭据文件也没用"的结论因此不能当成"宿主起太早"的证据（那是实验设计的问题）。
 *
 * 只动 `refs:` 段里的一个键，文件其余内容（如 `records` 里的浏览器会话授权）原样保留；
 * 改前留一份 .lingdong-backup。
 */
function writeGatewayCredential(home: string, key: string): void {
  const file = join(home, '.credentials.yaml')
  let text = ''
  try { text = existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { text = '' }
  const entry = `  PLATFORM_GATEWAY_KEY: ${key}`
  // `refs: {}` 也是一个合法文档。先把它展开，否则旧逻辑会以为没有 refs，
  // 再把第二个 `version/refs` 前缀拼上去，凭据插件会因 DUPLICATE_KEY 拒启。
  let next = text
  if (/^refs:\s*\{\}\s*$/mu.test(next)) {
    next = next.replace(/^refs:\s*\{\}\s*$/mu, 'refs:')
  }
  if (!/^refs:\s*/mu.test(next)) {
    next = /^version:\s*.*$/mu.test(next)
      ? next.replace(/^version:\s*.*$/mu, matched => `${matched}\nrefs:`)
      : `version: 1\nrefs:\n${next}`
  }
  if (/^ {2}PLATFORM_GATEWAY_KEY:.*$/mu.test(next)) {
    next = next.replace(/^ {2}PLATFORM_GATEWAY_KEY:.*$/mu, entry)
  } else if (/^refs:\s*$/mu.test(next)) {
    next = next.replace(/^refs:\s*$/mu, `refs:\n${entry}`)
  } else if (/^refs:\s*\{.*\}\s*$/mu.test(next)) {
    next = next.replace(/^refs:\s*\{.*\}\s*$/mu, `refs:\n${entry}`)
  }
  try {
    const backup = `${file}.lingdong-backup`
    if (existsSync(file) && !existsSync(backup)) writeFileSync(backup, text)
    writeFileSync(file, next)
  } catch (error) { console.error('灵动ai：写入凭据失败', error) }
}
function readClassroomContext(): LingdongContext {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'lingdong-classroom.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LingdongContext>
    return {
      classroom: parsed.classroom ?? null,
      presets: Array.isArray(parsed.presets) ? parsed.presets : [],
      sends: parsed.sends ?? null,
    }
  } catch {
    return { classroom: null, presets: [], sends: null }
  }
}


interface WorkFailure { readonly ok: false; readonly cancelled?: boolean; readonly code?: string; readonly message: string }
interface WorkBatchSuccess {
  readonly item: WorkBatchItem
  readonly data: unknown
  readonly warnings: readonly string[]
  readonly missing: readonly string[]
}
interface WorkBatchFailure {
  readonly item: WorkBatchItem
  readonly code?: string
  readonly message: string
}

function workFailure(message: string, options: { code?: string; cancelled?: boolean } = {}): WorkFailure {
  const result: { ok: false; cancelled?: boolean; code?: string; message: string } = { ok: false, message }
  if (options.code !== undefined) result.code = options.code
  if (options.cancelled === true) result.cancelled = true
  return result
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => typeof item === 'string' ? item : String(item ?? '').trim())
    .filter(item => item.length > 0)
}

function normalizeBatchItem(value: unknown): WorkBatchItem | null {
  const raw = asRecord(value)
  if (raw === null) return null
  const sessionId = asString(raw.sessionId)
  const sessionTitle = asString(raw.sessionTitle)
  const cwd = asString(raw.cwd)
  const path = asString(raw.path)
  const displayPath = asString(raw.displayPath)
  if (sessionId === '' || cwd === '' || path === '') return null
  return {
    sessionId,
    sessionTitle,
    cwd,
    path,
    ...(displayPath === '' ? {} : { displayPath }),
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function resolveInside(root: string, input: string): Promise<string> {
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input)
  const real = await realpath(candidate)
  if (!isInside(root, real)) throw new PlatformRequestError('文件不在当前会话工作区里，已拒绝读取。')
  const info = await stat(real)
  if (!info.isFile()) throw new PlatformRequestError(`只能提交文件：${basename(real)}`)
  return real
}

function safeFlatName(input: string): string {
  let name = basename(String(input || '')).trim()
  name = name.replace(/[\\/\0]/g, '_').replace(/\.\./g, '_').replace(/^\.+/u, '')
  if (name === '') name = 'asset'
  if (name.length > 100) {
    const extension = extname(name)
    const head = extension === '' ? name : name.slice(0, -extension.length)
    name = `${head.slice(0, Math.max(1, 100 - extension.length))}${extension}`
  }
  return name
}

function uniqueFlatName(input: string, reserved: Set<string>): string {
  const base = safeFlatName(input)
  const extension = extname(base)
  const stem = extension === '' ? base : base.slice(0, -extension.length)
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    const next = `${stem.slice(0, Math.max(1, 100 - extension.length - suffix.length))}${suffix}${extension}`
    const key = next.toLocaleLowerCase('en-US')
    if (!reserved.has(key)) {
      reserved.add(key)
      return next
    }
  }
  throw new PlatformRequestError('作品里的文件名重复太多，无法自动整理。')
}

function ignoredLocalReference(value: string): boolean {
  const raw = value.trim()
  return raw === '' || raw.startsWith('#') || raw.startsWith('//') || raw.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/iu.test(raw)
}

function splitReference(value: string): { readonly path: string; readonly suffix: string } {
  const match = /^([^?#]*)([\s\S]*)$/u.exec(value.trim())
  const path = match?.[1] ?? value.trim()
  const suffix = match?.[2] ?? ''
  try {
    return { path: decodeURIComponent(path), suffix }
  } catch {
    return { path, suffix }
  }
}

async function localReference(root: string, referrer: string, raw: string): Promise<{ readonly absolute: string; readonly suffix: string } | null> {
  if (ignoredLocalReference(raw)) return null
  const parts = splitReference(raw)
  if (parts.path === '') return null
  const candidate = resolve(dirname(referrer), parts.path)
  try {
    const real = await realpath(candidate)
    if (!isInside(root, real)) return null
    const info = await stat(real)
    if (!info.isFile()) return null
    return { absolute: real, suffix: parts.suffix }
  } catch {
    return null
  }
}

function collectReferenceValues(content: string, extension: string): string[] {
  const values = new Set<string>()
  if (extension === '.html' || extension === '.htm' || extension === '.svg') {
    for (const match of content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/giu)) {
      const value = match[1]
      if (value !== undefined) values.add(value)
    }
  }
  if (extension === '.html' || extension === '.htm' || extension === '.css' || extension === '.svg') {
    for (const match of content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
      const value = match[1]
      if (value !== undefined) values.add(value)
    }
    for (const match of content.matchAll(/@import\s+["']([^"']+)["']/giu)) {
      const value = match[1]
      if (value !== undefined) values.add(value)
    }
  }
  return [...values]
}

function rewriteReferenceValues(content: string, extension: string, replacement: (value: string) => string | undefined): string {
  let next = content
  if (extension === '.html' || extension === '.htm' || extension === '.svg') {
    next = next.replace(/(\b(?:src|href)\s*=\s*)(["'])([^"']+)(\2)/giu, (_whole, head: string, quote: string, value: string) =>
      `${head}${quote}${replacement(value) ?? value}${quote}`)
  }
  if (extension === '.html' || extension === '.htm' || extension === '.css' || extension === '.svg') {
    next = next.replace(/(url\(\s*)(["']?)([^"')]+)(\2\s*\))/giu, (_whole, head: string, quote: string, value: string) =>
      `${head}${quote}${replacement(value) ?? value}${quote})`)
    next = next.replace(/(@import\s+)(["'])([^"']+)(\2)/giu, (_whole, head: string, quote: string, value: string) =>
      `${head}${quote}${replacement(value) ?? value}${quote}`)
  }
  return next
}

async function prepareWork(item: WorkBatchItem): Promise<PreparedWork> {
  const root = await realpath(resolve(item.cwd))
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new PlatformRequestError('会话工作区不是目录。')
  const entryPath = await resolveInside(root, item.path)
  const entryExtension = extname(entryPath).toLocaleLowerCase('en-US')
  if (entryExtension !== '.html' && entryExtension !== '.htm') {
    throw new PlatformRequestError('交作品入口只提交网页 HTML 文件。')
  }

  const assets = new Map<string, WorkAsset>()
  const reserved = new Set<string>()
  const queue: WorkAsset[] = []
  const missing = new Set<string>()
  let totalBytes = 0

  const addAsset = async (absolutePath: string, preferredName: string): Promise<WorkAsset> => {
    const real = await resolveInside(root, absolutePath)
    const existing = assets.get(real)
    if (existing !== undefined) return existing
    const info = await stat(real)
    if (totalBytes + info.size > MAX_WORK_TOTAL_BYTES) {
      throw new PlatformRequestError('这个作品太大了（单次最多 16MB）。')
    }
    if (assets.size + 1 > MAX_WORK_FILES) {
      throw new PlatformRequestError(`这个作品引用了太多文件（单次最多 ${MAX_WORK_FILES} 个）。`)
    }
    totalBytes += info.size
    const extension = extname(real).toLocaleLowerCase('en-US')
    const binary = !TEXT_WORK_EXTENSIONS.has(extension)
    const bytes = await readFile(real)
    const content = binary ? bytes.toString('base64') : bytes.toString('utf8')
    const asset: WorkAsset = {
      absolute: real,
      name: uniqueFlatName(preferredName, reserved),
      binary,
      content,
      ...(binary ? {} : { text: content }),
    }
    assets.set(real, asset)
    queue.push(asset)
    return asset
  }

  const entry = await addAsset(entryPath, basename(entryPath))
  while (queue.length > 0) {
    const asset = queue.shift()
    if (asset === undefined || asset.binary || asset.text === undefined) continue
    const extension = extname(asset.absolute).toLocaleLowerCase('en-US')
    if (!SCANNABLE_WORK_EXTENSIONS.has(extension)) continue
    const replacements = new Map<string, string>()
    for (const raw of collectReferenceValues(asset.text, extension)) {
      const target = await localReference(root, asset.absolute, raw)
      if (target === null) {
        if (!ignoredLocalReference(raw)) missing.add(raw)
        continue
      }
      const referenced = assets.get(target.absolute) ?? await addAsset(target.absolute, basename(target.absolute))
      replacements.set(raw, `${referenced.name}${target.suffix}`)
    }
    if (replacements.size > 0) {
      asset.text = rewriteReferenceValues(asset.text, extension, value => replacements.get(value))
      asset.content = asset.text
    }
  }

  return {
    name: entry.name,
    files: [...assets.values()].map(asset => ({ name: asset.name, content: asset.content, binary: asset.binary })),
    missing: [...missing],
  }
}

function titleForWork(item: WorkBatchItem): string {
  const title = item.sessionTitle.trim()
  return (title === '' ? basename(item.path) : `${title} · ${basename(item.path)}`).slice(0, 60)
}

async function submitWork(token: string, item: WorkBatchItem): Promise<WorkBatchSuccess> {
  const prepared = await prepareWork(item)
  const body = {
    name: prepared.name,
    title: titleForWork(item),
    copyrightConfirmed: true as const,
    files: prepared.files,
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_WORK_REQUEST_BYTES) {
    throw new PlatformRequestError('这个作品编码后太大了，请减少素材后再交。')
  }
  const data = await call('/api/student/runtime/submit-upload', { method: 'POST', token, body })
  const record = asRecord(data)
  return {
    item,
    data,
    warnings: stringArray(record?.warnings),
    missing: [...new Set([...prepared.missing, ...stringArray(record?.missing)])],
  }
}

function pushUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value)
  }
}

// 预设在侧栏面板渲染时读它；handler 常驻应用生命周期。
ipcMain.handle('lingdong:classroom-context', () => readClassroomContext())

/** 作品相关 IPC：只从主进程读磁盘、拿 session token，不把 token 交给页面。 */
ipcMain.handle('lingdong:list-works', async () => {
  const session = readSession()
  if (session === null) return workFailure('登录已失效，请重新登录客户端。')
  try {
    const works = await call('/api/student/works?page=1&limit=20', { token: session.token })
    return { ok: true, works }
  } catch (error) {
    return workFailure(
      error instanceof Error ? error.message : String(error),
      error instanceof PlatformRequestError && error.code !== undefined ? { code: error.code } : {},
    )
  }
})

ipcMain.handle('lingdong:submit-work-batch', async (_event, payload: unknown) => {
  const request = asRecord(payload)
  if (request?.copyrightConfirmed !== true) {
    return workFailure('提交前请确认作品版权与展示授权', { code: 'WORK_COPYRIGHT_CONFIRMATION_REQUIRED' })
  }
  const rawItems = Array.isArray(request.items) ? request.items : []
  const items = rawItems.map(normalizeBatchItem)
  if (items.length === 0 || items.some(item => item === null)) {
    return workFailure('没有收到要提交的 HTML 作品，请重新勾选。')
  }
  const session = readSession()
  if (session === null) return workFailure('登录已失效，请重新登录客户端。')

  const submitted: WorkBatchSuccess[] = []
  const failures: WorkBatchFailure[] = []
  const warnings: string[] = []
  const missing: string[] = []
  for (const item of items as WorkBatchItem[]) {
    try {
      const result = await submitWork(session.token, item)
      submitted.push(result)
      pushUnique(warnings, result.warnings)
      pushUnique(missing, result.missing)
    } catch (error) {
      const failure: { item: WorkBatchItem; code?: string; message: string } = {
        item,
        message: error instanceof Error ? error.message : String(error),
      }
      if (error instanceof PlatformRequestError && error.code !== undefined) failure.code = error.code
      failures.push(failure)
    }
  }

  // 无论上面成功几份，批量动作结束后只查一次「我交过什么」。
  let works: unknown = null
  let worksError: string | null = null
  try {
    works = await call('/api/student/works?page=1&limit=20', { token: session.token })
  } catch (error) {
    worksError = error instanceof Error ? error.message : String(error)
  }
  return { ok: true, submitted, failures, warnings, missing, works, worksError }
})
/** 铺好网关密钥与补丁层。**只有这节课真的在进行时**才会走到这里。 */
function applyGateway(context: LingdongContext): void {
  const key = context.gateway?.key
  const baseUrl = context.gateway?.baseUrl
  if (!key || !baseUrl) throw new Error('平台没有下发网关密钥，无法启动创作环境')
  process.env.PLATFORM_GATEWAY_KEY = String(key)
  process.env.PLATFORM_GATEWAY_BASE_URL = String(baseUrl)
  const home = String(process.env.DSH_HOME || '').trim() || join(app.getPath('home'), '.dsh')
  const patch = join(GATE_DIR, 'lingdong.patch.yml')
  if (existsSync(patch)) {
    try { writeFileSync(join(home, 'lingdong.patch.yml'), readFileSync(patch, 'utf8')) } catch (error) { console.error('灵动ai：写入补丁层失败', error) }
  }
  writeGatewayCredential(home, String(key))
  pointDefaultModelToGateway(home)
  try {
    writeFileSync(join(app.getPath('userData'), 'lingdong-classroom.json'), JSON.stringify({
      classroom: context.classroom, presets: context.presets ?? [], sends: context.sends ?? null,
      updatedAt: new Date().toISOString(),
    }, null, 2))
  } catch { /* 诊断用，写不下不影响使用 */ }
}

/**
 * 跑完登录门：返回 `enter` 才继续启动 dsh；返回 `quit` 表示该退出应用。
 * @param createWindow 应用自己的主窗口工厂（借它显示我们的页面）
 * @param isQuitting 应用是否正在退出
 * @param resetHost **把已经起来的创作环境停掉**（宿主控制器 `backend.stop()`）。
 *   为什么需要它：密钥必须赶在宿主**起进程的那一刻**就已经在环境里（宿主进程的环境是
 *   spawn 时定下来的，事后写 `process.env` 到不了它那一侧）。门跑在 `reconcileBackend()`
 *   之前，按理说天然赶得上 —— 但实测对不上（密钥预置在进程环境里 → 消息成功、用量进账；
 *   只靠登录门注入 → 每轮「API 密钥无效」，而平台一条用量都没有）。说明宿主还在**别的路径**
 *   上先起来过（更新/恢复、策略检查都会走到 `backend.start`）。与其去赌"哪条路径先起"，
 *   不如在过门之后**明确停一次**：后面那条 `reconcileBackend()` 会用刚写好密钥的环境
 *   重新起一个。宿主本来没起过时 `stop()` 是安全的空操作。
 */
export async function runLingdongGate(
  createWindow: () => BrowserWindow,
  isQuitting: () => boolean,
  resetHost: () => Promise<void>,
): Promise<GateOutcome> {
  let waiting: ((action: GateAction) => void) | null = null
  const nextAction = (): Promise<GateAction> => new Promise((resolve) => { waiting = resolve })

  ipcMain.handle('lingdong:gate', async (_event, payload: unknown) => {
    const request = (payload ?? {}) as { action?: string; login?: string; password?: string }
    if (request.action === 'refresh' || request.action === 'logout') { waiting?.(request as GateAction); return { ok: true } }
    if (request.action !== 'login') return { ok: false, message: '未知操作' }
    const login = String(request.login || '').trim()
    const password = String(request.password || '')
    if (!login || !password) return { ok: false, message: '请输入账号和密码' }
    try {
      const session = await call('/api/auth/login', { method: 'POST', body: { login, password } })
      if (!session?.token) return { ok: false, message: '账号或密码不正确' }
      writeSession({ token: session.token, user: session.user })
      waiting?.({ action: 'login' })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  const window = createWindow()
  currentGateWindow = window
  const show = async (page: string, state: Record<string, unknown> = {}): Promise<void> => {
    await window.loadFile(join(GATE_DIR, page))
    // 页面换好了才调：三个页面同一支深红，所以只在进门前调一次也够，但每次都调更省心
    //（万一以后某一页换了底色，这里就是唯一的落点）。
    matchTitleBarToGate()
    // 页面里的脚本读这个全局拿到「谁登录了 / 为什么在这等」；不经过 IPC，避免多一轮握手。
    await window.webContents.executeJavaScript(`window.__LINGDONG_STATE__ = ${JSON.stringify(state)}; window.__lingdongRender && window.__lingdongRender();`).catch(() => undefined)
  }

  try {
    for (;;) {
      if (isQuitting()) return { kind: 'quit' }
      const session = readSession()
      if (session === null) {
        const action = await show('login.html').then(nextAction)
        if (action.action === 'logout') return { kind: 'quit' }
        continue
      }
      await show('loading.html', { name: session.user?.displayName || '' })
      let context: LingdongContext
      try {
        context = await call('/api/student/runtime/client-context', { token: session.token })
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法连接平台'
        writeSession(null)
        const action = await show('login.html', { message }).then(nextAction)
        if (action.action === 'logout') return { kind: 'quit' }
        continue
      }
      if (!context.classroom) {
        // 等老师开始上课：这里挂上深链回调 —— 官网拉起的客户端会立刻重问一次（学生不用自己点刷新）
        notifyDeepLink = () => waiting?.({ action: 'refresh' })
        const action = await show('waiting.html', { message: context.message || '老师还没有开始上课', name: session.user?.displayName || '' }).then(nextAction)
        if (action.action === 'logout') { writeSession(null); continue }
        continue // refresh：回循环顶部重新问一次「现在有没有课」
      }
      applyGateway(context)
      // 到这一步密钥已经写进 process.env 与凭据文件，但**宿主可能已经用旧环境起来了** ——
      // 停掉它，让下面那条 reconcileBackend() 用新环境重起（见本函数 @param resetHost）。
      // 失败不拦人：真起不来时 reconcileBackend 自己会报错，这里只留一行日志。
      await resetHost().catch((error: unknown) => { console.error('灵动ai：重启创作环境失败（继续走后面的 reconcile）', error) })
      return { kind: 'enter' }
    }
  } finally {
    notifyDeepLink = null
    currentGateWindow = null
    ipcMain.removeHandler('lingdong:gate')
  }
}
