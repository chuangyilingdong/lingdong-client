/** 侧栏底部账号名与退出登录。 */
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
      <div style={styles.identity}>
        <span style={styles.name}>{name}</span>
        {secondary !== '' && <span style={styles.login}>{secondary}</span>}
      </div>
      <button type="button" style={styles.logout} onClick={() => {
        const bridge = (window as Window & { readonly lingdong?: LingdongBridge }).lingdong
        void bridge?.logout?.()
      }}>退出登录</button>
    </div>
  )
}

const styles = {
  root: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px 4px' },
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
