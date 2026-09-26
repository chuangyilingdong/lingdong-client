/**
 * 灵动ai 课堂上下文：发送按钮前显示「课包 › 课时 · 老师」和「已用/上限」。
 *
 * 计数口径（学生 2026-09-26 要求）：**就数客户端自己的点击次数**，不再拿平台的 `sends.used` 当显示值。
 * 数据源在 `./lingdong-send-state.ts`（发送按钮与提交闸门读同一份）；这里只负责显示。
 * `classroom`、`limit` 仍然来自平台的 `client-context`；真正超限由平台网关 429 兜底。
 */
import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  lingdongLocalSendUsage, refreshLingdongCourseState, useLingdongCourseState,
  type LingdongClassroom, type LingdongCourseState,
} from './lingdong-send-state.ts'

type LingdongSendQuotaProps = PropsRuntime<'conversation.input.right'>

function readPhase(props: LingdongSendQuotaProps): unknown {
  const input = (props as { readonly input?: { readonly phase?: unknown } }).input
  return input?.phase
}

function courseLabel(classroom: LingdongClassroom): string {
  const course = [classroom.seriesTitle, classroom.lessonTitle].filter((value): value is string => Boolean(value && value.trim()))
  if (course.length > 0) return `${course.join(' › ')}${classroom.teacherName ? ` · ${classroom.teacherName}` : ''}`
  return `${classroom.title || '当前课堂'}${classroom.teacherName ? ` · ${classroom.teacherName}` : ''}`
}

function hintOf(state: LingdongCourseState, used: number, limit: number): string {
  const { classroom, message, upcoming } = state
  const course = classroom ? courseLabel(classroom) : (message || (upcoming ? `接下来：${courseLabel(upcoming)}` : ''))
  return course ? `${course}；已发送 ${used} 次，上限 ${limit} 次` : `已发送 ${used} 次，上限 ${limit} 次`
}

export function LingdongSendQuota(props: LingdongSendQuotaProps) {
  const state = useLingdongCourseState()
  const phase = readPhase(props)
  useEffect(() => {
    // 进入 submitting 后轻量重取一次：把课堂/上限/老师这些平台字段刷新。
    // 显示的次数不看平台，由 recordLingdongSend() 在本机点击时加一。
    if (phase !== 'submitting') return
    const timer = window.setTimeout(() => { void refreshLingdongCourseState() }, 450)
    return () => { window.clearTimeout(timer) }
  }, [phase])

  if (state === null) return null
  const limit = state.sends?.limit ?? null
  if (limit === null) return null
  const used = Math.min(lingdongLocalSendUsage(), limit)
  const exhausted = used >= limit

  return (
    <span
      style={{ ...styles.root, ...(exhausted ? styles.exhausted : {}) }}
      title={hintOf(state, used, limit)}
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
