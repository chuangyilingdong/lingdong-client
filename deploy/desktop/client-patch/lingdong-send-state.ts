/**
 * 灵动ai 课堂次数：发送按钮、次数条与提交闸门共用的**唯一**数据源。
 *
 * 平台是唯一计数方：这里只读登录门给的 `window.lingdong.context()`（即 `client-context`），
 * 不做任何本地加减。`used >= limit` 时客户端**直接拦住发送**，不再等第 N+1 次到网关才 429。
 *
 * 为什么单独一层而不是各组件自己拉：次数条（`conversation.input.right`）和发送按钮
 * （`InputBar` 的 primaryDisabled）必须看到同一份快照，否则会出现「按钮能点、次数条说用完了」。
 * 快照只在这里存一份，两个组件都从这里读；刷新合并成一次请求。
 *
 * ⚠️ 只有 `limit !== null` 才拦（平台语义：不填=不拦）。拿不到 `client-context` 时**不拦**，
 *    继续走网关 —— 客户端的判断只是体验优化，真正的门禁永远在平台。
 */
import { useSyncExternalStore } from 'react'

/** 本节课的发送次数（平台下发，客户端只显示）。 */
export interface LingdongSends {
  readonly limit: number | null
  readonly used: number
  readonly remaining: number | null
}

/** 课堂标识（课包 › 课时 · 老师）。 */
export interface LingdongClassroom {
  readonly id?: string
  readonly title?: string
  readonly seriesTitle?: string
  readonly lessonTitle?: string
  readonly teacherName?: string
}

/** 一次 `client-context` 读取后客户端关心的那部分。 */
export interface LingdongCourseState {
  readonly classroom: LingdongClassroom | null
  readonly upcoming: LingdongClassroom | null
  readonly sends: LingdongSends | null
  readonly message: string
}

interface LingdongDesktopBridge {
  readonly context?: (options?: unknown) => Promise<unknown>
}

type Listener = () => void

const listeners = new Set<Listener>()
const LINGDONG_SEND_COUNT_PREFIX = 'lingdong.classroom-sends.'
let snapshot: LingdongCourseState | null = null
let refreshing: Promise<void> | null = null
let detachGlobals: (() => void) | null = null

function readBridge(): LingdongDesktopBridge['context'] {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { readonly lingdong?: LingdongDesktopBridge }).lingdong?.context
}

function classroomOf(value: unknown): LingdongClassroom | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : undefined
  const title = typeof raw.title === 'string' ? raw.title : undefined
  const seriesTitle = typeof raw.seriesTitle === 'string' ? raw.seriesTitle : undefined
  const lessonTitle = typeof raw.lessonTitle === 'string' ? raw.lessonTitle : undefined
  const teacherName = typeof raw.teacherName === 'string' ? raw.teacherName : undefined
  return id === undefined && title === undefined && seriesTitle === undefined && lessonTitle === undefined
    && teacherName === undefined
    ? null
    : {
      ...(id === undefined ? {} : { id }),
      ...(title === undefined ? {} : { title }),
      ...(seriesTitle === undefined ? {} : { seriesTitle }),
      ...(lessonTitle === undefined ? {} : { lessonTitle }),
      ...(teacherName === undefined ? {} : { teacherName }),
    }
}

function normalizeSends(value: unknown): LingdongSends | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as { readonly limit?: unknown; readonly used?: unknown }
  const limit = candidate.limit === null || candidate.limit === undefined ? null : Number(candidate.limit)
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) return null
  const rawUsed = Number(candidate.used)
  const used = Number.isFinite(rawUsed) && rawUsed > 0 ? Math.floor(rawUsed) : 0
  return { limit, used: limit === null ? used : Math.min(used, limit), remaining: limit === null ? null : Math.max(0, limit - used) }
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function sendCountKey(state: LingdongCourseState | null): string | undefined {
  const classroom = state?.classroom
  const id = classroom?.id?.trim()
  if (id !== undefined && id !== '') return LINGDONG_SEND_COUNT_PREFIX + id
  const fallback = classroom?.lessonTitle?.trim() || classroom?.title?.trim()
  return fallback === undefined || fallback === '' ? undefined : LINGDONG_SEND_COUNT_PREFIX + fallback
}

function readStoredSendCount(key: string): number | undefined {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return undefined
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
  } catch {
    return undefined
  }
}

/**
 * 本机在本节课点过多少次发送。
 *
 * 口径（学生 2026-09-26 明确要求）：**就按客户端自己的点击次数算**，不再拿平台的
 * 数当显示值——平台那边曾经把 2 次显示成 1 次，学生看不懂。计数存在
 * localStorage 里、按课堂 id 分键，所以客户端重启不会归零。
 *
 * 平台仍然是最终门禁（网关 429）：如果学生换了电脑/浏览器，本地计数会低于平台，
 * 平台该拦还是会拦，只是提示话术由平台给。
 */
export function lingdongLocalSendUsage(): number {
  const key = sendCountKey(snapshot)
  if (key === undefined) return 0
  return readStoredSendCount(key) ?? 0
}

/** Count one allowed user submission. Tool rounds do not pass through submit(). */
export function recordLingdongSend(): void {
  const key = sendCountKey(snapshot)
  if (key === undefined) return
  const next = lingdongLocalSendUsage() + 1
  try { window.localStorage.setItem(key, String(next)) } catch { return }
  snapshot = snapshot === null ? null : { ...snapshot }
  emit()
}

function attachGlobals(): () => void {
  const onFocus = (): void => { void refreshLingdongCourseState() }
  window.addEventListener('focus', onFocus)
  return () => { window.removeEventListener('focus', onFocus) }
}

/** 当前快照；`useSyncExternalStore` 的 getSnapshot。 */
export function readLingdongCourseState(): LingdongCourseState | null {
  return snapshot
}

/** 订阅快照变化；没有 `window` 时（宿主侧）订阅为空操作。 */
export function subscribeLingdongCourseState(listener: Listener): () => void {
  listeners.add(listener)
  if (typeof window !== 'undefined') {
    if (detachGlobals === null) {
      detachGlobals = attachGlobals()
      void refreshLingdongCourseState()
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && detachGlobals !== null) {
        detachGlobals()
        detachGlobals = null
      }
    }
  }
  return () => { listeners.delete(listener) }
}

/**
 * 真实拉一次 `client-context` 并更新快照。
 * 并发调用合并成一次请求；失败保持上一份快照（客户端不猜、也不清空）。
 */
export function refreshLingdongCourseState(): Promise<void> {
  const read = readBridge()
  if (read === undefined) return Promise.resolve()
  if (refreshing !== null) return refreshing
  refreshing = (async () => {
    try {
      const raw = await read({ refresh: true })
      if (raw === null || typeof raw !== 'object') return
      const record = raw as Record<string, unknown>
      const next: LingdongCourseState = {
        classroom: classroomOf(record.classroom),
        upcoming: classroomOf(record.upcoming),
        sends: normalizeSends(record.sends),
        message: typeof record.message === 'string' ? record.message : '',
      }
      const changed = JSON.stringify(next) !== JSON.stringify(snapshot)
      snapshot = next
      if (changed) emit()
    } catch {
      // 读不到就保持原样：真正的门禁在平台，这里只是提前拦住。
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** 这节课还能不能发；`limit === null`、快照缺失都表示「不在这里拦」。 */
export function lingdongSendLimitReached(): boolean {
  const sends = snapshot?.sends
  if (sends === null || sends === undefined || sends.limit === null) return false
  return lingdongLocalSendUsage() >= sends.limit
}

/** 客户端自己拦住时给学生看的一句话；网关 429 的文案仍然由平台给。 */
export function lingdongSendLimitNotice(): string {
  const sends = snapshot?.sends
  if (sends === null || sends === undefined || sends.limit === null) return '本节课的发送次数已用完。'
  return `本节课的发送次数已用完（已用 ${lingdongLocalSendUsage()}/${sends.limit}），不能再发送了。`
}

/** `InputBar` 用：次数用完时禁用发送按钮。 */
export function useLingdongSendLimitReached(): boolean {
  return useSyncExternalStore(subscribeLingdongCourseState, lingdongSendLimitReached, () => false)
}

/** 次数条用：订阅整份课堂快照。 */
export function useLingdongCourseState(): LingdongCourseState | null {
  return useSyncExternalStore(subscribeLingdongCourseState, readLingdongCourseState, () => null)
}
