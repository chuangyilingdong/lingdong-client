/**
 * 灵动ai 发送次数：输入区右侧、**发送按钮正前方**的紧凑计数（`0/20`）。
 *
 * 平台口径（`docs/平台接口契约.md`）：次数上限由**平台**拦与统计，客户端只负责**显示**
 * —— `client-context.sends = { limit, used, remaining }`；超限时平台返回 429，客户端原样显示它的中文原因。
 * 所以这里**不自己计数**，只把平台给的数字摊开：
 *   · `limit === null`（课时没设上限，或不填/填 0）→ 什么都不显示，不打扰学生；
 *   · 有上限时显示 `已发送 used/limit`；用完时换成警示色（拦人的仍然是平台那一侧）。
 *
 * 为什么挂 `conversation.input.right`：契约里它写的是「Compact controls before the composer
 * submit action」，上游 `InputBar.tsx` 就在发送/停止按钮**前一行**渲染它 —— 位置正合适，
 * 而且不用碰上游 JSX（我们是"钉版检出 + 补丁层"，改法见 deploy/desktop/apply-client-gate.mjs）。
 *
 * 数字怎么刷新：`client-context` 是**登录时**取回来落盘的快照，不刷新就会一直显示旧值。
 * 触发点取 `input.phase`（输入框的提交生命周期：plain → adjudicating → claimed → **submitting** → plain）：
 * 每次从 submitting 落回来就向平台**重新问一次**（`window.lingdong.context({ refresh: true })`），
 * 外加窗口重新获得焦点时问一次。问不到就保持上一次的数字，绝不让输入区报错或白屏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface LingdongSends {
  readonly limit: number | null
  readonly used: number
  readonly remaining: number | null
}

interface LingdongDesktopContext {
  readonly sends?: unknown
}

interface LingdongDesktopBridge {
  readonly context?: (options?: unknown) => Promise<LingdongDesktopContext | undefined>
}

type LingdongSendQuotaProps = PropsRuntime<'conversation.input.right'>

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

async function readSends(refresh: boolean): Promise<LingdongSends | null> {
  const bridge = (window as Window & { readonly lingdong?: LingdongDesktopBridge }).lingdong
  if (bridge?.context === undefined) return null
  try {
    return normalizeSends((await bridge.context(refresh ? { refresh: true } : undefined))?.sends)
  } catch {
    // 取不到次数不能让输入区出问题（学生还要继续用）。
    return null
  }
}

/** 取当前会话的提交阶段（`input.phase`）。拿不到就按 undefined 处理，只影响刷新时机。 */
function readPhase(props: LingdongSendQuotaProps): unknown {
  const input = (props as { readonly input?: { readonly phase?: unknown } }).input
  return input?.phase
}

export function LingdongSendQuota(props: LingdongSendQuotaProps) {
  const [sends, setSends] = useState<LingdongSends | null>(null)
  const phase = readPhase(props)
  // 上一次问到的数字：刷新失败时保留它，避免数字闪成空
  const lastGood = useRef<LingdongSends | null>(null)

  const load = useCallback((refresh: boolean) => {
    void readSends(refresh).then((next) => {
      if (next !== null) lastGood.current = next
      setSends(next ?? lastGood.current)
    })
  }, [])

  // 挂载时先拿登录时那份缓存（快），不闪。
  useEffect(() => { load(true) }, [load])

  // 每次提交落回来（不再处于 submitting）就重新问平台要一次真实用量。
  useEffect(() => {
    if (phase === 'submitting') return
    load(true)
  }, [load, phase])

  // 窗口重新获得焦点时对一次（学生切出去再回来，数字不该是旧的）。
  useEffect(() => {
    const onFocus = (): void => { load(true) }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [load])

  const limit = sends?.limit ?? null
  if (limit === null) return null
  const used = Math.min(sends?.used ?? 0, limit)
  const exhausted = used >= limit

  return (
    <span
      style={{ ...styles.root, ...(exhausted ? styles.exhausted : {}) }}
      title={exhausted
        ? `这节课的发送次数用完了（共 ${limit} 次）。`
        : `这节课最多发送 ${limit} 次，已发送 ${used} 次。`}
      aria-label={`发送次数 ${used}/${limit}`}
      role="status"
    >
      {used}/{limit}
    </span>
  )
}

const styles = {
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    marginRight: '6px',
    padding: '2px 8px',
    border: '1px solid rgba(127, 127, 127, 0.24)',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 650,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.6,
    whiteSpace: 'nowrap',
    opacity: 0.78,
    cursor: 'default',
  },
  exhausted: {
    color: '#c0392b',
    borderColor: 'rgba(192, 57, 43, 0.42)',
    opacity: 1,
  },
} as const

/** 注册到上游的原生 list slot；apply 只注册，不抛错。 */
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
