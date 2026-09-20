/**
 * 灵动ai 课堂上下文：发送按钮前显示「课包 › 课时 · 老师」和「已用/上限」。
 *
 * 平台是唯一计数方：客户端只读取 `client-context.classroom / sends`，不自己加减；
 * 一次提交结束和窗口重新聚焦时各刷新一次，不做定时轮询。超限由平台网关返回 429，
 * 客户端只原样显示 `error.message`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface LingdongClassroom {
  readonly id?: string
  readonly title?: string
  readonly seriesTitle?: string
  readonly lessonTitle?: string
  readonly teacherName?: string
}

interface LingdongSends {
  readonly limit: number | null
  readonly used: number
  readonly remaining: number | null
}

interface LingdongDesktopContext {
  readonly classroom?: unknown
  readonly upcoming?: unknown
  readonly sends?: unknown
  readonly message?: unknown
}

interface LingdongDesktopBridge {
  readonly context?: (options?: unknown) => Promise<LingdongDesktopContext | undefined>
}

interface CourseState {
  readonly classroom: LingdongClassroom | null
  readonly upcoming: LingdongClassroom | null
  readonly sends: LingdongSends | null
  readonly message: string
}

type LingdongSendQuotaProps = PropsRuntime<'conversation.input.right'>

function classroomOf(value: unknown): LingdongClassroom | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : undefined
  const title = typeof raw.title === 'string' ? raw.title : undefined
  const seriesTitle = typeof raw.seriesTitle === 'string' ? raw.seriesTitle : undefined
  const lessonTitle = typeof raw.lessonTitle === 'string' ? raw.lessonTitle : undefined
  const teacherName = typeof raw.teacherName === 'string' ? raw.teacherName : undefined
  return id === undefined && title === undefined && seriesTitle === undefined && lessonTitle === undefined && teacherName === undefined
    ? null
    : { ...(id === undefined ? {} : { id }), ...(title === undefined ? {} : { title }), ...(seriesTitle === undefined ? {} : { seriesTitle }), ...(lessonTitle === undefined ? {} : { lessonTitle }), ...(teacherName === undefined ? {} : { teacherName }) }
}

function normalizeSends(value: unknown): LingdongSends | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as { readonly limit?: unknown; readonly used?: unknown; readonly remaining?: unknown }
  const limit = candidate.limit === null || candidate.limit === undefined ? null : Number(candidate.limit)
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) return null
  const used = Number(candidate.used)
  return {
    limit,
    used: Number.isFinite(used) && used > 0 ? Math.floor(used) : 0,
    remaining: limit === null ? null : Math.max(0, limit - (Number.isFinite(used) && used > 0 ? Math.floor(used) : 0)),
  }
}

async function readContext(refresh: boolean): Promise<CourseState | null> {
  const bridge = (window as Window & { readonly lingdong?: LingdongDesktopBridge }).lingdong
  if (bridge?.context === undefined) return null
  try {
    const raw = await bridge.context(refresh ? { refresh: true } : undefined)
    if (raw === undefined) return null
    return {
      classroom: classroomOf(raw.classroom),
      upcoming: classroomOf(raw.upcoming),
      sends: normalizeSends(raw.sends),
      message: typeof raw.message === 'string' ? raw.message : '',
    }
  } catch {
    return null
  }
}

function readPhase(props: LingdongSendQuotaProps): unknown {
  const input = (props as { readonly input?: { readonly phase?: unknown } }).input
  return input?.phase
}

function courseLabel(classroom: LingdongClassroom): string {
  const course = [classroom.seriesTitle, classroom.lessonTitle].filter((value): value is string => Boolean(value && value.trim()))
  if (course.length > 0) return `${course.join(' › ')}${classroom.teacherName ? ` · ${classroom.teacherName}` : ''}`
  return `${classroom.title || '当前课堂'}${classroom.teacherName ? ` · ${classroom.teacherName}` : ''}`
}

export function LingdongSendQuota(props: LingdongSendQuotaProps) {
  const [state, setState] = useState<CourseState | null>(null)
  const phase = readPhase(props)
  const lastGood = useRef<CourseState | null>(null)
  const load = useCallback((refresh: boolean) => {
    void readContext(refresh).then(next => {
      if (next !== null) lastGood.current = next
      setState(next ?? lastGood.current)
    })
  }, [])

  useEffect(() => { load(true) }, [load])
  useEffect(() => {
    // 进入 submitting 后轻量重取一次；平台一旦接受发送，数字很快从 0 变 1。
    // 仍然只相信平台返回值，客户端不自行加一。
    const timer = window.setTimeout(() => { load(true) }, phase === 'submitting' ? 450 : 0)
    return () => { window.clearTimeout(timer) }
  }, [load, phase])
  useEffect(() => {
    const onFocus = (): void => { load(true) }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [load])

  if (state === null) return null
  const { classroom, sends, message, upcoming } = state
  const limit = sends?.limit ?? null
  if (limit === null) return null
  const used = Math.min(sends?.used ?? 0, limit)
  const exhausted = used >= limit
  const courseHint = classroom ? courseLabel(classroom) : (message || (upcoming ? `接下来：${courseLabel(upcoming)}` : ''))

  return (
    <span
      style={{ ...styles.root, ...(exhausted ? styles.exhausted : {}) }}
      title={courseHint ? `${courseHint}；已发送 ${used} 次，上限 ${limit} 次` : `已发送 ${used} 次，上限 ${limit} 次`}
      aria-label={`使用次数 ${used}/${limit}`}
      role="status"
    >
      <span style={styles.count}>使用次数{used}/{limit}</span>
    </span>
  )
}

const styles = {
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    maxWidth: 'min(46vw, 460px)',
    marginRight: '6px',
    padding: '2px 8px',
    border: '1px solid rgba(127, 127, 127, 0.24)',
    borderRadius: '999px',
    fontSize: '11px',
    lineHeight: 1.6,
    whiteSpace: 'nowrap',
    opacity: 0.82,
    cursor: 'default',
  },
  course: { overflow: 'hidden', textOverflow: 'ellipsis' },
  count: { fontWeight: 700, fontVariantNumeric: 'tabular-nums', flex: 'none' },
  exhausted: { color: '#c0392b', borderColor: 'rgba(192, 57, 43, 0.42)', opacity: 1 },
} as const

/** 注册到原生 `conversation.input.right`。 */
export const lingdongSendQuotaEntry = {
  name: 'lingdong-send-quota',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right',
      id: 'lingdong-send-quota',
      order: 10,
    }, LingdongSendQuota))
  },
}
