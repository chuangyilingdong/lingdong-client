/**
 * 灵动ai 课堂预设提示词：侧栏「工作区」上方的独立可展开区。
 *
 * 平台把 `presets: [{ title, text }]` 随 client-context 下发；主进程只读缓存后
 * 通过 `window.lingdong.context()` 给渲染层。这里只显示标题，点击标题把正文
 * 交给隐藏的输入桥填进当前会话草稿，**不自动发送**。
 */
import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface LingdongPreset {
  readonly title: string
  readonly text: string
}

interface LingdongDesktopContext {
  readonly presets?: unknown
}

interface LingdongDesktopBridge {
  readonly context?: () => Promise<LingdongDesktopContext | undefined>
}

type LingdongPresetPanelProps = PropsRuntime<'sidebar.workspaces.lingdongPresets'>

function normalizePresets(value: unknown): readonly LingdongPreset[] {
  if (!Array.isArray(value)) return []
  const result: LingdongPreset[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const candidate = item as { readonly title?: unknown; readonly text?: unknown }
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : ''
    if (title === '' || text === '') continue
    result.push({ title, text })
  }
  return result
}

async function readPresets(): Promise<readonly LingdongPreset[]> {
  const bridge = (window as Window & { readonly lingdong?: LingdongDesktopBridge }).lingdong
  if (bridge?.context === undefined) return []
  try {
    return normalizePresets((await bridge.context())?.presets)
  } catch {
    // 取不到预设不能让侧栏或创作区白屏。
    return []
  }
}

const styles = {
  root: {
    margin: '10px 12px 6px',
    padding: '0 0 2px',
    borderBottom: '1px solid rgba(127, 127, 127, 0.16)',
    color: 'inherit',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    minHeight: '30px',
    padding: '3px 2px 6px',
    border: 0,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 650,
    letterSpacing: '0.01em',
    textAlign: 'left',
  },
  count: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '18px',
    height: '18px',
    marginLeft: '6px',
    padding: '0 5px',
    borderRadius: '999px',
    background: 'rgba(127, 127, 127, 0.12)',
    fontSize: '10px',
    fontWeight: 600,
    opacity: 0.72,
  },
  arrow: {
    width: '14px',
    fontSize: '11px',
    opacity: 0.62,
    transition: 'transform 140ms ease',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    maxHeight: '190px',
    overflowY: 'auto',
    padding: '0 0 8px',
  },
  button: {
    width: '100%',
    padding: '7px 9px',
    border: '1px solid rgba(127, 127, 127, 0.22)',
    borderRadius: '8px',
    background: 'rgba(127, 127, 127, 0.055)',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
    lineHeight: 1.35,
    textAlign: 'left',
  },
  buttonDisabled: {
    cursor: 'not-allowed',
    opacity: 0.48,
  },
  state: {
    padding: '0 2px 9px',
    fontSize: '11px',
    lineHeight: 1.45,
    opacity: 0.58,
  },
} as const

/** 独立可展开的预设标题列表；无当前会话时按钮禁用。 */
export function LingdongPresetPanel({ sessionId }: LingdongPresetPanelProps) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [presets, setPresets] = useState<readonly LingdongPreset[]>([])
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!open || loaded) return
    let alive = true
    void readPresets().then((next) => {
      if (!alive) return
      setPresets(next)
      setLoaded(true)
    })
    return () => { alive = false }
  }, [loaded, open])

  const missingSession = sessionId === undefined

  return (
    <section style={styles.root} aria-label="提示词预设">
      <button
        type="button"
        style={styles.header}
        aria-expanded={open}
        onClick={() => {
          setOpen(value => !value)
          setNotice('')
        }}
      >
        <span>
          提示词预设
          {open && loaded && presets.length > 0 && <span style={styles.count}>{presets.length}</span>}
        </span>
        <span style={{ ...styles.arrow, transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }} aria-hidden>›</span>
      </button>
      {open && (
        loaded
          ? presets.length > 0
            ? (
              <div style={styles.list}>
                {presets.map(preset => (
                  <button
                    key={`${preset.title}\u0000${preset.text}`}
                    type="button"
                    style={{ ...styles.button, ...(missingSession ? styles.buttonDisabled : {}) }}
                    disabled={missingSession}
                    title={missingSession ? '先打开或新建一个会话' : `把“${preset.title}”填入当前输入框`}
                    onClick={() => {
                      if (sessionId === undefined) return
                      window.dispatchEvent(new CustomEvent('lingdong:insert-preset', {
                        detail: { sessionId, text: preset.text },
                      }))
                      setNotice(`已填入：${preset.title}`)
                    }}
                  >
                    {preset.title}
                  </button>
                ))}
                {notice !== '' && <div style={styles.state} role="status">{notice}</div>}
                {missingSession && <div style={styles.state}>先打开或新建一个会话，再点标题填入。</div>}
              </div>
            )
            : <div style={styles.state}>本节课还没有下发预设提示词。</div>
          : <div style={styles.state}>正在读取…</div>
      )}
    </section>
  )
}

/** 注册到 ui-workspace 新增的侧栏 slot；apply 只注册，不抛错。 */
export const lingdongPresetPanelEntry = {
  name: 'lingdong-preset-panel',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('sidebar.workspaces.lingdongPresets', () => ctx.slots.register({
      name: 'sidebar.workspaces.lingdongPresets',
    }, LingdongPresetPanel))
  },
}