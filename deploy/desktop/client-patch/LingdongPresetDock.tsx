/**
 * 灵动ai 课堂预设提示词：输入卡上方的可点块。
 *
 * 数据来源是登录门写下的 `lingdong-classroom.json`（只读，不含网关密钥），
 * 通过 preload 的 `window.lingdong.context()` 取回。点击块调用宿主公开的
 * `inputActions.setDraft()`，由 Conversation 自己的编辑器写入草稿，**不直接碰 DOM**。
 *
 * 这个文件由 `deploy/desktop/apply-client-gate.mjs` 拷进上游 ui-conversation
 * 包后注册到 `conversation.input.dock`；上游升级时只需跟着脚本重放。
 */
import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputActions } from './contract/input.ts'

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

/** Session slot props: Runtime supplies useInput/inputActions through the standard Session seat. */
export type LingdongPresetDockProps = PropsRuntime<'conversation.input.dock'>

function normalizePresets(value: unknown): readonly LingdongPreset[] {
  if (!Array.isArray(value)) return []
  const presets: LingdongPreset[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const candidate = item as { readonly title?: unknown; readonly text?: unknown }
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : ''
    if (title.length === 0 || text.length === 0) continue
    presets.push({ title, text })
  }
  return presets
}

async function readPresets(): Promise<readonly LingdongPreset[]> {
  const bridge = (window as Window & { readonly lingdong?: LingdongDesktopBridge }).lingdong
  if (bridge?.context === undefined) return []
  try {
    return normalizePresets((await bridge.context())?.presets)
  } catch {
    // 取不到预设不能让创作区白屏；没有块就保持原样。
    return []
  }
}

const styles = {
  root: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    width: '100%',
    marginBottom: '2px',
    color: 'inherit',
  },
  label: {
    flex: '0 0 auto',
    paddingTop: '8px',
    fontSize: '12px',
    fontWeight: 600,
    opacity: 0.62,
    whiteSpace: 'nowrap',
  },
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    minWidth: 0,
  },
  button: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '2px',
    maxWidth: '280px',
    minWidth: '120px',
    padding: '7px 10px',
    border: '1px solid rgba(127, 127, 127, 0.28)',
    borderRadius: '10px',
    background: 'rgba(127, 127, 127, 0.07)',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  },
  title: {
    fontSize: '13px',
    fontWeight: 600,
    lineHeight: 1.35,
  },
  preview: {
    maxWidth: '260px',
    overflow: 'hidden',
    fontSize: '11px',
    lineHeight: 1.35,
    opacity: 0.58,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
} as const

/** Dock entry: renders nothing when the platform sent no presets. */
export function LingdongPresetDock({ useInput, inputActions }: LingdongPresetDockProps & { readonly inputActions: InputActions }) {
  const [presets, setPresets] = useState<readonly LingdongPreset[]>([])
  const phase = useInput(state => state.phase)

  useEffect(() => {
    let alive = true
    void readPresets().then((next) => {
      if (alive) setPresets(next)
    })
    return () => { alive = false }
  }, [])

  if (presets.length === 0) return null
  const disabled = phase !== 'plain'

  return (
    <section style={styles.root} aria-label="课堂预设提示词">
      <span style={styles.label}>课堂预设</span>
      <div style={styles.list}>
        {presets.map(preset => (
          <button
            key={`${preset.title}\u0000${preset.text}`}
            type="button"
            style={{ ...styles.button, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 }}
            title={preset.text}
            aria-label={`插入预设提示词：${preset.title}`}
            disabled={disabled}
            onClick={() => { inputActions.setDraft(preset.text) }}
          >
            <span style={styles.title}>{preset.title}</span>
            <span style={styles.preview}>{preset.text.replace(/\s+/gu, ' ')}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** Register the preset strip on the same native session slot used by todo/goal/queue. */
export const lingdongPresetDockEntry = {
  name: 'lingdong-preset-dock',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'lingdong-presets',
      order: 5,
    }, LingdongPresetDock))
  },
}