import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
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
 *   · **不要写凭据文件**：补丁层声明的是 `apiKeyEnv: PLATFORM_GATEWAY_KEY`，只读环境变量；
 *     历史版本曾把 key 写进 `$DSH_HOME/.credentials.yaml`，那是 agent 可读的泄密路径，现已移除并在登录/退出时清理。
 */
const GATE_DIR = app.isPackaged
  ? join(process.resourcesPath, 'gate')
  : join(app.getAppPath(), 'resources', 'gate')
const API_BASE = String(process.env.LINGDONG_API_BASE || 'https://aicyld.com').replace(/\/$/, '')

interface LingdongUser { readonly id?: string; readonly displayName?: string; readonly login?: string }
interface LingdongSession { readonly token: string; readonly user?: LingdongUser }
interface LingdongClassroom {
  readonly id: string
  readonly lessonId?: string
  readonly title?: string
  readonly seriesTitle?: string
  readonly lessonTitle?: string
  readonly teacherName?: string
  readonly startedAt?: string
}
interface LingdongContext {
  readonly classroom: LingdongClassroom | null
  readonly classrooms: readonly LingdongClassroom[]
  readonly reason: string | null
  readonly upcoming: LingdongClassroom | null
  readonly gateway?: { readonly baseUrl?: string; readonly key?: string }
  readonly presets: readonly { readonly title: string; readonly text: string }[]
  readonly models?: readonly { readonly id?: unknown; readonly displayName?: unknown }[]
  readonly defaultModel?: unknown
  readonly sends: { readonly limit: number | null; readonly used: number; readonly remaining: number | null } | null
  readonly message: string
  /** Classroom workspace prepared before the DSH host comes up. */
  readonly workspacePath?: string
  /** Historical/exception libraries can expose more than one active classroom; this is the chosen query key. */
  readonly sessionId: string
  /** 登录账号（rc.2.7 起落盘）：同一台电脑换账号登录时，本地计数与工作区要能分开。 */
  readonly userId?: string
  readonly userLogin?: string
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
  /** 主产物同目录、没被引用也没随作品提交的素材（只作提示）。 */
  readonly nearby: readonly string[]
}
interface WorkspaceFileCandidate {
  readonly path: string
  readonly displayPath: string
  readonly title: string
  readonly updatedAt: number
  readonly size: number
}
type GateAction =
  | { action: 'login' }
  | { action: 'refresh' }
  | { action: 'logout' }
  | { action: 'select-classroom'; sessionId: string }
type GateOutcome = { kind: 'enter' } | { kind: 'quit' }

const MAX_WORK_FILES = 60
const MAX_WORK_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_WORK_REQUEST_BYTES = 24 * 1024 * 1024
const TEXT_WORK_EXTENSIONS = new Set([
  '.css', '.csv', '.htm', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.cjs', '.svg', '.text',
  '.ts', '.tsx', '.txt', '.webmanifest', '.xml', '.yaml', '.yml',
])
const SUBMITTABLE_WORK_EXTENSIONS = new Set(['.htm', '.html', '.docx', '.xlsx', '.pptx'])
const RECOGNIZED_WORK_EXTENSIONS = new Set([
  ...SUBMITTABLE_WORK_EXTENSIONS,
  '.pdf', '.md', '.txt', '.csv', '.json', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.lua', '.rb', '.php', '.sql',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.mp3', '.wav', '.mp4', '.webm', '.mov', '.zip',
])
const SCANNABLE_WORK_EXTENSIONS = new Set(['.cjs', '.css', '.htm', '.html', '.js', '.jsx', '.mjs', '.svg'])
/** 脚本 / 内联脚本里的 'a.png'、"data.json"、`bg.webp` 这类字面量。 */
const SCRIPT_REFERENCE_PATTERN = /(['"`])([^'"`\n\r]{1,200}?\.[A-Za-z0-9]{1,6})\1/gu
/** 这些扩展名的文件里，字符串常量也可能是素材路径。 */
const SCRIPT_WORK_EXTENSIONS = new Set(['.cjs', '.htm', '.html', '.js', '.jsx', '.mjs', '.svg'])
/** 脚本字面量只有落在这些扩展名上才当成素材路径（避免把 'v1.2' 之类当成缺失文件）。 */
const SCRIPT_REFERENCE_EXTENSIONS = new Set([
  '.bmp', '.cjs', '.css', '.csv', '.gif', '.htm', '.html', '.ico', '.jpeg', '.jpg', '.js', '.json',
  '.mjs', '.mp3', '.mp4', '.ogg', '.otf', '.png', '.svg', '.ttf', '.txt', '.wav', '.webm', '.webp', '.woff', '.woff2',
])
/** 「主产物同目录还有这些素材」提示的扩展名（平台只存得下图片，其它会变空）。 */
const NEARBY_HINT_EXTENSIONS = new Set([
  '.bmp', '.css', '.gif', '.ico', '.jpeg', '.jpg', '.json', '.mp3', '.mp4', '.ogg', '.otf', '.png',
  '.svg', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2',
])
const NEARBY_HINT_LIMIT = 6
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
interface StoredSession extends Partial<LingdongSession> {
  readonly version?: number
  readonly encrypted?: boolean
  readonly value?: string
}

function dshHome(): string {
  const configured = String(process.env.DSH_HOME || '').trim()
  return configured || join(app.getPath('userData'), 'dsh-home')
}

function readSession(): LingdongSession | null {
  const stored = readJson<StoredSession>(sessionFile())
  if (stored === null) return null
  // Migrate the old plaintext session on first read.
  if (typeof stored.token === 'string' && stored.token) {
    const legacy: LingdongSession = stored.user === undefined ? { token: stored.token } : { token: stored.token, user: stored.user }
    writeSession(legacy)
    return legacy
  }
  if (stored.encrypted !== true || typeof stored.value !== 'string' || !safeStorage.isEncryptionAvailable()) return null
  try {
    const decoded = safeStorage.decryptString(Buffer.from(stored.value, 'base64'))
    const session = JSON.parse(decoded) as LingdongSession
    return typeof session?.token === 'string' && session.token ? session : null
  } catch { return null }
}

function writeSession(session: LingdongSession | null): void {
  const file = sessionFile()
  try {
    if (session === null) { rmSync(file, { force: true }); return }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用')
    const encrypted = safeStorage.encryptString(JSON.stringify(session)).toString('base64')
    writeFileSync(file, JSON.stringify({ version: 1, encrypted: true, value: encrypted }))
  } catch (error) {
    console.error('灵动ai：保存登录态失败', error)
    try { rmSync(file, { force: true }) } catch { /* best effort */ }
  }
}

async function call(path: string, { method = 'GET', body, token, timeoutMs = 15_000 }: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {}): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const init: RequestInit = { method, headers }
  // ⚠️ 上游开了 `exactOptionalPropertyTypes`：不能写成 `body: undefined`，要按需赋值。
  if (body !== undefined) init.body = JSON.stringify(body)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal }).catch((error: unknown) => {
    if (controller.signal.aborted) throw new PlatformRequestError('平台连接超时，请稍后重试。')
    throw error
  }).finally(() => clearTimeout(timer))
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

const LINGDONG_MODELS_BEGIN = '# LINGDONG_MODELS_BEGIN'
const LINGDONG_MODELS_END = '# LINGDONG_MODELS_END'
const LINGDONG_DEFAULT_MODEL_MARKER = '# LINGDONG_DEFAULT_MODEL'
const LINGDONG_FALLBACK_MODEL = 'deepseek-flash'

interface LingdongGatewayModel {
  readonly id: string
  readonly name: string
  readonly input: readonly ['text', 'image']
}

/** Normalize platform data into DSH's hand-declared provider model shape. */
function gatewayModels(context: LingdongContext): readonly LingdongGatewayModel[] {
  if (!Array.isArray(context.models)) return []
  const seen = new Set<string>()
  const models: LingdongGatewayModel[] = []
  for (const item of context.models) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    const displayName = typeof item?.displayName === 'string' ? item.displayName.trim() : ''
    seen.add(id)
    models.push({ id, name: displayName || id, input: ['text', 'image'] as const })
  }
  return models
}

function gatewayDefaultModel(context: LingdongContext, models: readonly LingdongGatewayModel[]): string {
  const requested = typeof context.defaultModel === 'string' ? context.defaultModel.trim() : ''
  return models.some(model => model.id === requested) ? requested : (models[0]?.id || LINGDONG_FALLBACK_MODEL)
}

/**
 * 把平台下发的模型清单渲染进 DSH 补丁层模板。
 * 平台没给 models（旧平台/渠道未配置）时原样返回模板，继续走内置兜底。
 * JSON.stringify() 的输出同时是合法 YAML/JSON 标量，中文、冒号、引号都不用手写转义。
 */
function renderGatewayPatch(template: string, context: LingdongContext): string {
  if (!Array.isArray(context.models) || context.models.length === 0) return template
  const models = gatewayModels(context)
  if (models.length === 0) return template
  const begin = template.indexOf(LINGDONG_MODELS_BEGIN)
  const end = template.indexOf(LINGDONG_MODELS_END)
  if (begin < 0 || end < begin || !template.includes(LINGDONG_DEFAULT_MODEL_MARKER)) {
    console.error('灵动ai：补丁层缺少模型清单锚点，沿用内置模型')
    return template
  }
  const defaultModel = gatewayDefaultModel(context, models)
  const lineStart = template.lastIndexOf('\n', begin - 1) + 1
  const indent = template.slice(lineStart, begin)
  const eol = template.includes('\r\n') ? '\r\n' : '\n'
  const block = [
    LINGDONG_MODELS_BEGIN,
    ...models.map(model => `${indent}- ${JSON.stringify(model)}`),
    LINGDONG_MODELS_END,
  ].join(eol)
  let rendered = template.slice(0, begin) + block + template.slice(end + LINGDONG_MODELS_END.length)
  rendered = rendered.replace(
    /^([ \t]*)model:[^\r\n]*# LINGDONG_DEFAULT_MODEL[^\r\n]*/mu,
    (_line, indent: string) => `${indent}model: ${JSON.stringify(defaultModel)} # LINGDONG_DEFAULT_MODEL`,
  )
  return rendered
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
function pointDefaultModelToGateway(home: string, model: string): void {
  const file = join(home, 'settings.yaml')
  let text = ''
  try { text = existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { return }
  const block = `agent-default-model:\n  provider: platform-gateway\n  model: ${JSON.stringify(model)}\n`
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
function removeGatewayCredential(home: string): void {
  const file = join(home, '.credentials.yaml')
  try {
    if (!existsSync(file)) return
    const before = readFileSync(file, 'utf8')
    const next = before.replace(/^ {2}PLATFORM_GATEWAY_KEY:.*(?:\r?\n|$)/gmu, '')
    if (next !== before) writeFileSync(file, next)
    const backup = `${file}.lingdong-backup`
    if (existsSync(backup)) rmSync(backup, { force: true })
  } catch (error) {
    console.error('灵动ai：清理旧网关凭据失败（不影响环境变量注入）', error)
  }
}
function contextPath(sessionId = ''): string {
  return `/api/student/runtime/client-context${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`
}

function writeClassroomContext(context: LingdongContext, sessionId?: string, user?: LingdongUser): void {
  const selected = String(sessionId || context.sessionId || context.classroom?.id || '')
  try {
    writeFileSync(join(app.getPath('userData'), 'lingdong-classroom.json'), JSON.stringify({
      classroom: context.classroom ?? null,
      classrooms: Array.isArray(context.classrooms) ? context.classrooms : [],
      reason: context.reason ?? null,
      upcoming: context.upcoming ?? null,
      presets: context.presets ?? [],
      sends: context.sends ?? null,
      message: context.message ?? '',
      workspacePath: context.workspacePath ?? '',
      userId: context.userId ?? user?.id ?? '',
      userLogin: context.userLogin ?? user?.login ?? '',
      sessionId: selected,
      updatedAt: new Date().toISOString(),
    }, null, 2))
  } catch { /* 诊断用，写不下不影响使用 */ }
}

function readClassroomContext(): LingdongContext {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'lingdong-classroom.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LingdongContext>
    return {
      classroom: parsed.classroom ?? null,
      classrooms: Array.isArray(parsed.classrooms) ? parsed.classrooms : [],
      reason: parsed.reason ?? null,
      upcoming: parsed.upcoming ?? null,
      presets: Array.isArray(parsed.presets) ? parsed.presets : [],
      sends: parsed.sends ?? null,
      message: typeof parsed.message === 'string' ? parsed.message : '',
      workspacePath: typeof parsed.workspacePath === 'string' ? parsed.workspacePath : '',
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
      userLogin: typeof parsed.userLogin === 'string' ? parsed.userLogin : '',
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
    }
  } catch {
    return { classroom: null, classrooms: [], reason: null, upcoming: null, presets: [], sends: null, message: '', sessionId: '', userId: '', userLogin: '' }
  }
}

/**
 * 重新向平台问一次课堂上下文（含**发送次数** `sends` 和**当前课包/课时**），并更新本地缓存后返回。
 * 只做展示刷新，不做本地计数；问不到就退回缓存。
 */
async function refreshClassroomContext(): Promise<LingdongContext> {
  const cached = readClassroomContext()
  const session = readSession()
  if (session === null) return cached
  try {
    const fresh = await call(contextPath(cached.sessionId), { token: session.token }) as Partial<LingdongContext>
    const hasClassroom = fresh.classroom !== null && fresh.classroom !== undefined
    const gateway = hasClassroom ? fresh.gateway : undefined
    const next: LingdongContext = {
      classroom: hasClassroom ? fresh.classroom : null,
      classrooms: Array.isArray(fresh.classrooms) ? fresh.classrooms : cached.classrooms,
      reason: fresh.reason ?? null,
      upcoming: fresh.upcoming ?? null,
      ...(gateway === undefined ? {} : { gateway }),
      presets: hasClassroom && Array.isArray(fresh.presets) ? fresh.presets : [],
      sends: hasClassroom ? (fresh.sends ?? null) : null,
      message: typeof fresh.message === 'string' ? fresh.message : '',
      workspacePath: cached.workspacePath || '',
      userId: cached.userId || '',
      userLogin: cached.userLogin || '',
      sessionId: cached.sessionId || fresh.classroom?.id || '',
    }
    writeClassroomContext(next)
    return next
  } catch {
    return cached
  }
}

function clearLoginState(): void {
  delete process.env.PLATFORM_GATEWAY_KEY
  delete process.env.PLATFORM_GATEWAY_BASE_URL
  writeSession(null)
  removeGatewayCredential(dshHome())
  writeClassroomContext({ classroom: null, classrooms: [], reason: null, upcoming: null, presets: [], sends: null, message: '', sessionId: '' })
}

function restartAtLogin(): void {
  clearLoginState()
  setImmediate(() => { app.relaunch(); app.quit() })
}

/**
 * 课堂结束/账号被顶时强制回到登录页。只在平台明确说“没有可进课堂”或密钥身份失效时触发，
 * 网络抖动不会把学生踢出去。
 */
function watchClassroom(sessionId: string): void {
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    const session = readSession()
    if (session === null) return
    try {
      const context = await call(contextPath(sessionId), { token: session.token }) as Partial<LingdongContext>
      if (!context.classroom) { stopped = true; restartAtLogin(); return }
    } catch (error) {
      const code = error instanceof PlatformRequestError ? error.code : undefined
      if (code === 'SESSION_SUPERSEDED' || code === 'RUNTIME_KEY_INVALID' || code === 'RUNTIME_KEY_EXPIRED'
        || code === 'RUNTIME_NO_ACTIVE_CLASSROOM') {
        stopped = true
        restartAtLogin()
        return
      }
    }
    setTimeout(() => { void tick() }, 5000).unref()
  }
  void tick()
}

interface WorkFailure { readonly ok: false; readonly cancelled?: boolean; readonly code?: string; readonly message: string }
interface WorkBatchSuccess {
  readonly item: WorkBatchItem
  readonly data: unknown
  readonly warnings: readonly string[]
  readonly missing: readonly string[]
  readonly nearby: readonly string[]
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

/** 一处待解析的引用：`strict` 为假时只“能取到就打包”，取不到不进「本地缺失」提示。 */
interface CollectedReference {
  readonly value: string
  readonly strict: boolean
}

function collectReferences(content: string, extension: string): CollectedReference[] {
  const values = new Map<string, boolean>()
  const add = (value: string, strict: boolean): void => {
    if (values.get(value) !== true) values.set(value, strict)
  }
  if (extension === '.html' || extension === '.htm' || extension === '.svg') {
    for (const match of content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/giu)) {
      const value = match[1]
      if (value !== undefined) add(value, true)
    }
  }
  if (extension === '.html' || extension === '.htm' || extension === '.css' || extension === '.svg') {
    for (const match of content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
      const value = match[1]
      if (value !== undefined) add(value, true)
    }
    for (const match of content.matchAll(/@import\s+["']([^"']+)["']/giu)) {
      const value = match[1]
      if (value !== undefined) add(value, true)
    }
  }
  // 脚本里用字符串拼出来的素材路径（打地鼠这类游戏常见的写法）。只有真的落在工作区里、
  // 文件也存在的值才会被改写，所以顺手扫一遍不会误伤普通字符串。
  if (SCRIPT_WORK_EXTENSIONS.has(extension)) {
    for (const match of content.matchAll(SCRIPT_REFERENCE_PATTERN)) {
      const value = match[2]
      if (value === undefined || value.includes('${')) continue
      if (!SCRIPT_REFERENCE_EXTENSIONS.has(value.slice(value.lastIndexOf('.')).toLocaleLowerCase('en-US'))) continue
      // 脚本里的字面量只做“能取到就打包”，取不到不报缺失 —— 否则 'node.js' 这种普通字符串会刷屏。
      add(value, false)
    }
  }
  return [...values].map(([value, strict]) => ({ value, strict }))
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
  if (SCRIPT_WORK_EXTENSIONS.has(extension)) {
    next = next.replace(SCRIPT_REFERENCE_PATTERN, (whole: string, quote: string, value: string) => {
      const replaced = replacement(value)
      return replaced === undefined ? whole : `${quote}${replaced}${quote}`
    })
  }
  return next
}

async function prepareWork(item: WorkBatchItem): Promise<PreparedWork> {
  const root = await realpath(resolve(item.cwd))
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new PlatformRequestError('会话工作区不是目录。')
  const entryPath = await resolveInside(root, item.path)
  const entryExtension = extname(entryPath).toLocaleLowerCase('en-US')
  if (!SUBMITTABLE_WORK_EXTENSIONS.has(entryExtension)) {
    throw new PlatformRequestError('交作品目前支持 HTML、Word、Excel 和 PPT。')
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
    for (const reference of collectReferences(asset.text, extension)) {
      const target = await localReference(root, asset.absolute, reference.value)
      if (target === null) {
        if (reference.strict && !ignoredLocalReference(reference.value)) missing.add(reference.value)
        continue
      }
      const referenced = assets.get(target.absolute) ?? await addAsset(target.absolute, basename(target.absolute))
      replacements.set(reference.value, `${referenced.name}${target.suffix}`)
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
    nearby: await nearbyAssets(dirname(entryPath), assets, reserved),
  }
}

/**
 * 主产物同目录里「没被引用、也没随作品提交」的素材。
 *
 * 学生的作品里如果有 JS 拼出来的路径、或者干脆是手工放的图，客户端扫不到 —— 平台那边只会
 * 存下图片，音视频/字体会变成空文件。与其让学生交完才发现图裂，不如在提交结果里点出来。
 * @param directory - 主产物所在目录。
 * @param assets - 已经随作品收集的素材（按真实路径）。
 * @param reserved - 已用过的扁平文件名（提示里排除，避免和作品内文件混淆）。
 * @returns 最多 {@link NEARBY_HINT_LIMIT} 个文件名。
 */
async function nearbyAssets(directory: string, assets: Map<string, WorkAsset>, reserved: Set<string>): Promise<string[]> {
  const names = await readdir(directory).catch(() => [] as string[])
  const found: string[] = []
  for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
    if (found.length >= NEARBY_HINT_LIMIT) break
    if (name.startsWith('.') || name === 'node_modules') continue
    const extension = extname(name).toLocaleLowerCase('en-US')
    if (!NEARBY_HINT_EXTENSIONS.has(extension)) continue
    const real = await realpath(join(directory, name)).catch(() => '')
    if (real === '' || assets.has(real)) continue
    const info = await stat(real).catch(() => null)
    if (info === null || !info.isFile()) continue
    if (reserved.has(safeFlatName(name).toLocaleLowerCase('en-US'))) continue
    found.push(name)
  }
  return found
}

/** rc.2.8：交给平台的封面（`cover.content` 是 base64 PNG）。 */
const COVER_WIDTH = 1280
const COVER_HEIGHT = 720
/** 平台约定：封面最大 1.5MB；超了就不传（作品照常提交）。 */
const COVER_MAX_BYTES = Math.floor(1.5 * 1024 * 1024)
/** 采集超时：页面里有死循环 / 挂住的外部资源时，绝不能把“交作品”卡死。 */
const COVER_TIMEOUT_MS = 12_000

/** 交作品时附带的封面，拿不到就返回 undefined（绝不拦提交）。 */
async function captureWorkCover(item: WorkBatchItem): Promise<{ readonly content: string } | undefined> {
  try {
    const root = await realpath(resolve(item.cwd))
    const entry = await resolveInside(root, item.path)
    const extension = extname(entry).toLocaleLowerCase('en-US')
    // 只有网页作品有"封面"可言；Word / Excel / PPT 交给平台自己出图。
    if (extension !== '.html' && extension !== '.htm') return undefined
    const png = await renderCoverPng(root, entry)
    if (png === undefined) return undefined
    if (png.byteLength > COVER_MAX_BYTES) {
      console.warn(`[lingdong] 作品封面 ${png.byteLength} 字节，超过 1.5MB，跳过（作品照常提交）`)
      return undefined
    }
    return { content: png.toString('base64') }
  } catch (error) {
    console.warn('[lingdong] 生成作品封面失败（作品照常提交）', error)
    return undefined
  }
}

/**
 * 把作品页面渲染成 1280×720 PNG。
 *
 * 走**临时回环 HTTP 服务**而不是 file://：学生的页面常带 ES Module / fetch，
 * file:// 下这些会被浏览器直接拒掉，截出来就是白屏或半成品。
 * 采集用隐藏窗口（offscreen），等 load 完再等 450ms 让首屏动画/字体稳定。
 */
async function renderCoverPng(root: string, entry: string): Promise<Buffer | undefined> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
        const candidate = resolve(root, relativePath === '' ? basename(entry) : relativePath)
        if (candidate !== root && !isInside(root, candidate)) {
          response.writeHead(403)
          response.end()
          return
        }
        const data = await readFile(candidate)
        response.writeHead(200, { 'content-type': coverMimeType(candidate), 'cache-control': 'no-store' })
        response.end(data)
      } catch {
        response.writeHead(404)
        response.end()
      }
    })()
  })
  await new Promise<void>(resolveListen => { server.listen(0, '127.0.0.1', () => resolveListen()) })
  const port = (server.address() as AddressInfo).port
  const window = new BrowserWindow({
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  // 采集本身自己吾错（报错只打日志），这样超时丢下它也不会产生未处理的 promise。
  const capture = (async (): Promise<Buffer | undefined> => {
    try {
      await window.loadURL(`http://127.0.0.1:${port}/${encodeURIComponent(basename(entry))}`)
      await delayMilliseconds(450)
      let image = await window.webContents.capturePage()
      if (image.isEmpty()) {
        // 离屏首帧偶尔是空的：再给一次机会。
        await delayMilliseconds(350)
        image = await window.webContents.capturePage()
      }
      if (image.isEmpty()) return undefined
      const size = image.getSize()
      if (size.width !== COVER_WIDTH || size.height !== COVER_HEIGHT) {
        image = image.resize({ width: COVER_WIDTH, height: COVER_HEIGHT })
      }
      let png = image.toPNG()
      if (png.byteLength > COVER_MAX_BYTES) {
        png = image.resize({ width: 1024, height: 576 }).toPNG()
      }
      return png.byteLength > COVER_MAX_BYTES ? undefined : png
    } catch (error) {
      console.warn('[lingdong] 封面渲染失败（作品照常提交）', error)
      return undefined
    }
  })()
  try {
    const raced = await Promise.race([
      capture,
      delayMilliseconds(COVER_TIMEOUT_MS).then(() => undefined),
    ])
    if (raced === undefined) console.warn('[lingdong] 封面采集超时，这次不带封面（作品照常提交）')
    return raced
  } finally {
    window.destroy()
    await new Promise<void>(resolveClose => { server.close(() => resolveClose()) })
  }
}

function delayMilliseconds(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

/** 临时预览服务的最小 MIME 表（够学生作品用）。 */
function coverMimeType(path: string): string {
  const extension = extname(path).toLocaleLowerCase('en-US')
  return ({
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  } as Record<string, string>)[extension] ?? 'application/octet-stream'
}

function titleForWork(item: WorkBatchItem): string {
  const title = item.sessionTitle.trim()
  return (title === '' ? basename(item.path) : `${title} · ${basename(item.path)}`).slice(0, 60)
}

async function submitWork(token: string, item: WorkBatchItem): Promise<WorkBatchSuccess> {
  const prepared = await prepareWork(item)
  const base = {
    name: prepared.name,
    title: titleForWork(item),
    copyrightConfirmed: true as const,
    files: prepared.files,
  }
  // 平台 2026-09-27 起的可选字段：`cover.content` = base64 PNG。
  // 封面是“有就更好”：拿不到、超 1.5MB、或者加上它会超过请求上限时，都丢掉封面而不拦提交。
  const cover = await captureWorkCover(item)
  let body: Record<string, unknown> = cover === undefined ? { ...base } : { ...base, cover }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_WORK_REQUEST_BYTES) {
    if (cover === undefined || Buffer.byteLength(JSON.stringify(base), 'utf8') > MAX_WORK_REQUEST_BYTES) {
      throw new PlatformRequestError('这个作品编码后太大了，请减少素材后再交。')
    }
    console.warn('[lingdong] 加上封面会超过请求上限，这次不带封面（作品照常提交）')
    body = { ...base }
  }
  const selectedSessionId = readClassroomContext().sessionId || ''
  const data = await call(`/api/student/runtime/submit-upload${selectedSessionId ? `?sessionId=${encodeURIComponent(selectedSessionId)}` : ''}`, { method: 'POST', token, body, timeoutMs: 60_000 })
  const record = asRecord(data)
  return {
    item,
    data,
    warnings: stringArray(record?.warnings),
    missing: [...new Set([...prepared.missing, ...stringArray(record?.missing)])],
    nearby: prepared.nearby,
  }
}

function pushUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value)
  }
}

function scanWorkspaceFiles(context: LingdongContext, limit = 500): WorkspaceFileCandidate[] {
  const root = String(context.workspacePath || '').trim()
  if (root === '' || !existsSync(root)) return []
  const found: WorkspaceFileCandidate[] = []
  const queue: Array<{ readonly directory: string; readonly depth: number }> = [{ directory: root, depth: 0 }]
  while (queue.length > 0 && found.length < limit) {
    const current = queue.shift()
    if (current === undefined || current.depth > 6) continue
    let names: string[] = []
    try { names = readdirSync(current.directory) } catch { continue }
    for (const name of names) {
      if (found.length >= limit) break
      if (name.startsWith('.') || name === 'node_modules' || (name === 'dist' && current.depth > 0)) continue
      const absolute = join(current.directory, name)
      let info: ReturnType<typeof statSync>
      try { info = statSync(absolute) } catch { continue }
      if (info.isDirectory()) { queue.push({ directory: absolute, depth: current.depth + 1 }); continue }
      if (!info.isFile() || info.size > MAX_WORK_TOTAL_BYTES) continue
      const extension = extname(name).toLocaleLowerCase('en-US')
      if (!RECOGNIZED_WORK_EXTENSIONS.has(extension)) continue
      found.push({
        path: absolute,
        displayPath: relative(root, absolute).replaceAll('\\', '/'),
        title: basename(absolute),
        updatedAt: info.mtimeMs,
        size: info.size,
      })
    }
  }
  return found.sort((left, right) => right.updatedAt - left.updatedAt)
}


// 预设、发送次数在渲染时读它；handler 常驻应用生命周期。
// ⚠️ 传 `{ refresh: true }` = **再去问一次平台**（发送次数得这么拿才准，见 refreshClassroomContext）。
// LINGDONG_CONTEXT_SYNC：同步读本地缓存的课堂上下文。打开文件的地址要在**调用栈里**就拿到
// 工作区根（openFile 是同步 API），异步问一次会留一个「还没问到 → 退回相对路径」的窗口，
// 落在宿主那边就是把 /index.html 解析成 C:\index.html 的 fs-error。
ipcMain.on('lingdong:classroom-context-sync', (event) => {
  try {
    event.returnValue = readClassroomContext()
  } catch {
    event.returnValue = null
  }
})
ipcMain.handle('lingdong:classroom-context', async (_event, payload: unknown) => {
  const wantsRefresh = payload !== null && typeof payload === 'object' && (payload as { refresh?: unknown }).refresh === true
  return wantsRefresh ? await refreshClassroomContext() : readClassroomContext()
})
ipcMain.handle('lingdong:scan-work-files', () => {
  try {
    const context = readClassroomContext()
    return { ok: true, root: context.workspacePath || '', files: scanWorkspaceFiles(context) }
  } catch (error) {
    return workFailure(error instanceof Error ? error.message : String(error))
  }
})
ipcMain.handle('lingdong:account', () => readSession()?.user ?? null)
ipcMain.handle('lingdong:logout', async () => {
  const session = readSession()
  // 本地先不删，确保平台能按这台设备当前 token 注销；平台失败也不把学生卡在应用里。
  if (session) await call('/api/auth/logout', { method: 'POST', token: session.token }).catch(() => undefined)
  restartAtLogin()
  return { ok: true }
})
ipcMain.handle('lingdong:show-in-folder', async (_event, payload: unknown) => {
  const filePath = typeof payload === 'string' ? payload.trim() : ''
  if (filePath === '') return { ok: false, message: '文件路径为空。' }
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return { ok: false, message: '目标不是文件。' }
    shell.showItemInFolder(filePath)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})

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
    return workFailure('没有收到要提交的作品，请重新勾选。')
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
function safeWorkspaceSegment(value: unknown, fallback: string, maxChars: number): string {
  const cleaned = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .trim()
  const source = cleaned || fallback
  return Array.from(source).slice(0, maxChars).join('') || fallback
}

function shortClassId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/** One physical workspace per class session; friendly name, unique marker. */
function ensureClassroomWorkspace(context: LingdongContext, user?: LingdongUser): string | undefined {
  if (!context.classroom) return undefined
  try {
    const student = safeWorkspaceSegment(user?.displayName || user?.login, '学生', 24)
    const lesson = safeWorkspaceSegment(context.classroom.lessonTitle || context.classroom.title, '课堂', 28)
    const classroomId = String(context.classroom.id || context.sessionId || '').trim() || shortClassId(JSON.stringify(context.classroom))
    const root = join(app.getPath('documents'), '灵动ai创作')
    // rc.2.7：同一台电脑上换账号登录时，工作区必须分开 —— 否则后一个账号会看到
    // 前一个账号的会话与作品（会话库是按机器共享的，只能靠 cwd 区分）。老注记（没有 accountId）保持原样，
    // 不迁移已有目录，避免学生的作品看起来“消失”。
    const accountId = String(user?.id || '').trim() || String(user?.login || '').trim()
    const account = safeWorkspaceSegment(user?.login || accountId, '', 20)
    const base = join(root, `${student}-${lesson}`)
    const markerName = '.lingdong-classroom.json'
    let workspacePath = base
    if (existsSync(base)) {
      const marker = readJson<{ readonly classroomId?: unknown; readonly accountId?: unknown }>(join(base, markerName))
      const entries = readdirSync(base).filter(name => name !== markerName)
      const sameClass = marker !== null && String(marker.classroomId || '') === classroomId
      const owner = marker === null ? '' : String(marker.accountId || '')
      if (accountId !== '' && owner !== '' && owner !== accountId) {
        workspacePath = join(root, `${student}-${account === '' ? shortClassId(accountId) : account}-${lesson}`)
      } else if (!sameClass && entries.length > 0) {
        workspacePath = join(root, `${student}-${lesson}-${shortClassId(classroomId)}`)
      }
    }
    mkdirSync(workspacePath, { recursive: true })
    writeFileSync(join(workspacePath, markerName), JSON.stringify({
      classroomId, student: user?.displayName || user?.login || '', accountId, account: user?.login || '',
      lesson, createdAt: new Date().toISOString(),
    }, null, 2))
    // 课堂页面的生成约定：学生端的浏览器预览不应依赖任何 Chrome 扩展 / 浏览器桥 / 外部 CDN。
    // 只在工作区没有自己的 AGENTS.md 时铺一份，避免覆盖学生或老师已有的项目规则。
    const instructions = join(workspacePath, 'AGENTS.md')
    if (!existsSync(instructions)) {
      writeFileSync(instructions, [
        '# 灵动ai 课堂作品约定',
        '',
        '- 生成网页时优先做成自包含项目：HTML、CSS、JS、图片、字体等资源都放在工作区内，并用相对路径引用。',
        '- 不依赖 Chrome/Edge 扩展、浏览器自动化桥、外部 CDN 或本机预装的第三方库；学生端必须打开就能运行。',
        '- 如果使用 ES Module、fetch 或本地预览，必须配套说明并优先使用 127.0.0.1/localhost；不要假设 file:// 下模块和网络请求可用。',
        '- 交付入口默认使用 index.html；不要引用工作区以外的绝对路径。',
      ].join('\n'), 'utf8')
    }
    return workspacePath
  } catch (error) {
    console.error('灵动ai：创建课堂工作区失败（继续使用原工作区）', error)
    return undefined
  }
}

/** 铺好网关密钥与补丁层。**只有这节课真的在进行时**才会走到这里。 */
/** rc.2.7：预装插件清单的**第二道保险**。
 *
 * 正常路径是 `project-manager.enablePreinstalledPlugins()`（在 applyRelease 里，登录之后、
 * 宿主起来之前跑）。实测有机器出现过「插件闭包已经镜像进 profile、但 manifest 的
 * bundles 清单没更新」→ 插件不挂载 → 学生看不到设计/PPT 视图。这里在**登录门**里再补一次：
 * 只做增补（把该有的加上）与清理（把已摘掉的删掉），其它条目一律不动，失败也不拦启动。
 *
 * ⚠️ 这两个清单要与 `apps/desktop/src/project-manager.ts` 里的
 *    LINGDONG_PLUGIN_BUNDLES / LINGDONG_RETIRED_PLUGIN_BUNDLES 保持一致。
 */
const LINGDONG_GATE_BUNDLES = ['deepseek-idesign', 'deepseek-ippt']
const LINGDONG_GATE_RETIRED = ['dsh-context', 'dsh-at-file', '@yuxianglin/dsh-bridge-browser', 'dsh-find-plugin']

/** 见 {@link LINGDONG_GATE_BUNDLES}：补齐桌面 profile 的预装插件清单。 */
function ensurePreinstalledBundles(): void {
  try {
    const manifestPath = join(dshHome(), 'profiles', 'desktop', 'package.json')
    if (!existsSync(manifestPath)) return
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
    const rawBundles = manifest.dsh?.profile?.bundles
    const current = Array.isArray(rawBundles) ? rawBundles.filter((name): name is string => typeof name === 'string') : []
    const missing = LINGDONG_GATE_BUNDLES.filter(name => !current.includes(name))
    const kept = current.filter(name => !LINGDONG_GATE_RETIRED.includes(name))
    const bundles = [...kept, ...missing]
    if (bundles.length === current.length && bundles.every((name, index) => name === current[index])) return
    writeFileSync(manifestPath, `${JSON.stringify({
      ...manifest,
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
    }, undefined, 2)}\n`)
    console.log('[lingdong] 预装插件清单已补齐：', bundles.join(', '))
  } catch (error) {
    console.warn('[lingdong] 预装插件清单补齐失败（不影响启动）', error)
  }
}

function applyGateway(context: LingdongContext, user?: LingdongUser): void {
  const key = context.gateway?.key
  const baseUrl = context.gateway?.baseUrl
  if (!key || !baseUrl) throw new Error('平台没有下发网关密钥，无法启动创作环境')
  process.env.PLATFORM_GATEWAY_KEY = String(key)
  process.env.PLATFORM_GATEWAY_BASE_URL = String(baseUrl)
  process.env.DSH_TELEMETRY_DISABLED = '1'
  const home = dshHome()
  process.env.DSH_HOME = home
  const patch = join(GATE_DIR, 'lingdong.patch.yml')
  const defaultModel = gatewayDefaultModel(context, gatewayModels(context))
  if (existsSync(patch)) {
    try {
      const rendered = renderGatewayPatch(readFileSync(patch, 'utf8'), context)
      writeFileSync(join(home, 'lingdong.patch.yml'), rendered)
    } catch (error) { console.error('灵动ai：写入补丁层失败', error) }
  }
  // Never persist the gateway key in an agent-readable file. The host receives it via env only.
  removeGatewayCredential(home)
  pointDefaultModelToGateway(home, defaultModel)
  ensurePreinstalledBundles()
  const workspacePath = ensureClassroomWorkspace(context, user)
  writeClassroomContext(workspacePath === undefined ? context : { ...context, workspacePath }, undefined, user)
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
  let selectedSessionId = readClassroomContext().sessionId || ''
  const nextAction = (): Promise<GateAction> => new Promise((resolve) => { waiting = resolve })

  ipcMain.handle('lingdong:gate', async (_event, payload: unknown) => {
    const request = (payload ?? {}) as { action?: string; login?: string; password?: string; sessionId?: string }
    if (request.action === 'refresh' || request.action === 'logout') { waiting?.(request as GateAction); return { ok: true } }
    if (request.action === 'select-classroom') {
      const sessionId = String(request.sessionId || '').trim()
      if (!sessionId) return { ok: false, message: '请选择要进入的课堂' }
      selectedSessionId = sessionId
      waiting?.({ action: 'select-classroom', sessionId })
      return { ok: true }
    }
    if (request.action !== 'login') return { ok: false, message: '未知操作' }
    const login = String(request.login || '').trim()
    const password = String(request.password || '')
    if (!login || !password) return { ok: false, message: '请输入账号和密码' }
    try {
      const session = await call('/api/auth/login', { method: 'POST', body: { login, password } })
      if (!session?.token) return { ok: false, message: '账号或密码不正确' }
      selectedSessionId = ''
      writeClassroomContext({ classroom: null, classrooms: [], reason: null, upcoming: null, presets: [], sends: null, message: '', sessionId: '' })
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
    if (!isQuitting() && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
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
        context = await call(contextPath(selectedSessionId), { token: session.token })
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法连接平台'
        writeSession(null)
        selectedSessionId = ''
        const action = await show('login.html', { message }).then(nextAction)
        if (action.action === 'logout') return { kind: 'quit' }
        continue
      }
      if (selectedSessionId === '' && Array.isArray(context.classrooms) && context.classrooms.length > 1) {
        const action = await show('classroom.html', {
          classrooms: context.classrooms,
          name: session.user?.displayName || '',
          message: context.message || '',
        }).then(nextAction)
        if (action.action === 'logout') { writeSession(null); continue }
        if (action.action === 'select-classroom') selectedSessionId = action.sessionId
        continue
      }
      if (!context.classroom) {
        if (context.reason === 'CLASSROOM_NOT_AVAILABLE') selectedSessionId = ''
        // 等老师开始上课：这里挂上深链回调 —— 官网拉起的客户端会立刻重问一次（学生不用自己点刷新）
        notifyDeepLink = () => waiting?.({ action: 'refresh' })
        const action = await show('waiting.html', {
          message: context.message || '老师还没有开始上课',
          name: session.user?.displayName || '',
          upcoming: context.upcoming ?? null,
        }).then(nextAction)
        if (action.action === 'logout') { writeSession(null); continue }
        continue // refresh：回循环顶部重新问一次「现在有没有课」
      }
      const activeSessionId = selectedSessionId || context.classroom.id
      applyGateway({ ...context, sessionId: activeSessionId }, session.user)
      watchClassroom(activeSessionId)
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
