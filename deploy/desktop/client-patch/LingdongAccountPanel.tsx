/**
 * 侧栏底部账号区：头像 + 学生名/账号 + 退出登录，**一行**。
 *
 * 2026-09-25 反馈 ⑥：原来上游还有个头像启动器（点开只有「设置 / 意见反馈」）单独占一行，
 * 学生看到的是「名字+退出登录」和「头像」两块，语义重复。现在上游那个启动器在灵动ai登录门
 * 存在时直接不渲染（见 AccountMenu 的 LINGDONG_ACCOUNT_MERGE），身份与退出都收在这一行里。
 */
import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface AccountView {
  readonly displayName: string
  readonly login: string
}

interface LingdongBridge {
  readonly account?: () => Promise<unknown>
  readonly logout?: () => Promise<unknown>
}

type AccountPanelProps = PropsRuntime<'sidebar.footer.action'>

function accountOf(value: unknown): AccountView | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as { readonly displayName?: unknown; readonly login?: unknown }
  return {
    displayName: typeof raw.displayName === 'string' ? raw.displayName.trim() : '',
    login: typeof raw.login === 'string' ? raw.login.trim() : '',
  }
}

/** 极简人像图标（不引上游图标名，避免版本改名互相牵连）。 */
function AvatarGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M4.9 20c.6-3.6 3.6-5.6 7.1-5.6s6.5 2 7.1 5.6" strokeLinecap="round" />
    </svg>
  )
}

export function LingdongAccountPanel({ wide }: AccountPanelProps) {
  const [account, setAccount] = useState<AccountView | null>(null)
  useEffect(() => {
    let alive = true
    const bridge = (window as Window & { readonly lingdong?: LingdongBridge }).lingdong
    void bridge?.account?.().then(value => { if (alive) setAccount(accountOf(value)) }).catch(() => undefined)
    return () => { alive = false }
  }, [])

  if (!wide || account === null || (account.displayName === '' && account.login === '')) return null
  const name = account.displayName || account.login
  const secondary = account.displayName !== '' && account.login !== account.displayName ? account.login : ''
  return (
    <div style={styles.root}>
      <span style={styles.avatar} aria-hidden><AvatarGlyph /></span>
      <div style={styles.identity}>
        <span style={styles.name} title={name}>{name}</span>
        {secondary !== '' && <span style={styles.login} title={secondary}>{secondary}</span>}
      </div>
      <button type="button" style={styles.logout} onClick={() => {
        const bridge = (window as Window & { readonly lingdong?: LingdongBridge }).lingdong
        void bridge?.logout?.()
      }}>退出登录</button>
    </div>
  )
}

const styles = {
  root: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 10px 4px' },
  avatar: {
    flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '26px', height: '26px', borderRadius: '8px',
    border: '1px solid rgba(127,127,127,.25)', color: 'inherit', opacity: 0.86,
  },
  identity: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 650 },
  login: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '10px', opacity: 0.52 },
  logout: { flex: 'none', padding: '5px 8px', border: '1px solid rgba(127,127,127,.25)', borderRadius: '7px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11px' },
} as const

export const lingdongAccountPanelEntry = {
  name: 'lingdong-account-panel',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'lingdong-account-panel',
      order: 10,
    }, LingdongAccountPanel))
  },
}