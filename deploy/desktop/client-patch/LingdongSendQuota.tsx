/**
 * 灵动ai 课堂上下文：发送按钮前显示「课包 › 课时 · 老师」和「已用/上限」。
 *
 * 平台是唯一计数方：客户端只读 `client-context.classroom / sends`，不自己加减。
 * 数据源在 `./lingdong-send-state.ts`（发送按钮与提交闸门读同一份快照，见那个文件的文件头）；
 * 这里只负责显示。超限由平台网关返回 429，提示语原样显示平台给的 `error.message`。
 */
import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  refreshLingdongCourseState, useLingdongCourseState,
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
    // 进入 submitting 后轻量重取一次；平台一旦接受发送，数字很快从 0 变 1。
    // 仍然只相信平台返回值，客户端不自行加一。
    if (phase !== 'submitting') return
    const timer = window.setTimeout(() => { void refreshLingdongCourseState() }, 450)
    return () => { window.clearTimeout(timer) }
  }, [phase])

  if (state === null) return null
  const limit = state.sends?.limit ?? null
  if (limit === null) return null
  const used = Math.min(state.sends?.used ?? 0, limit)
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
