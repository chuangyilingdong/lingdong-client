/**
 * 隐藏桥：侧栏点预设标题后，把正文写进**当前会话**的输入草稿。
 *
 * 侧栏是 root scope，不知道输入框的实现；它只派发带 sessionId 的 CustomEvent。
 * 这个桥注册在 `conversation.input.dock`（session scope），只处理 sessionId
 * 完全匹配的事件，并调用公开的 `inputActions.setDraft()`，不自动发送。
 */
import { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

type LingdongPresetBridgeProps = PropsRuntime<'conversation.input.dock'>

interface InsertPresetDetail {
  readonly sessionId?: unknown
  readonly text?: unknown
}

/** 不渲染 DOM，只监听侧栏事件并写入当前会话草稿。 */
export function LingdongPresetBridge({ sessionId, inputActions }: LingdongPresetBridgeProps) {
  useEffect(() => {
    const onInsert = (event: Event): void => {
      const detail = (event as CustomEvent<InsertPresetDetail>).detail
      if (detail === null || typeof detail !== 'object') return
      if (detail.sessionId !== sessionId || typeof detail.text !== 'string' || detail.text === '') return
      inputActions.setDraft(detail.text)
    }
    window.addEventListener('lingdong:insert-preset', onInsert)
    return () => { window.removeEventListener('lingdong:insert-preset', onInsert) }
  }, [inputActions, sessionId])

  return null
}

/** 注册隐藏桥；apply 只注册，不读取或渲染任何业务数据。 */
export const lingdongPresetBridgeEntry = {
  name: 'lingdong-preset-bridge',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'lingdong-preset-bridge',
      order: 100,
    }, LingdongPresetBridge))
  },
}