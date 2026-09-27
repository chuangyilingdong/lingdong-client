/**
 * 灵动ai 交付文件的**绝对路径**解析（2026-09-25）。
 *
 * 为什么需要这一层：DSH 打开交付文件走的是 `dsh-resource://file/session/<id>/<路径>`
 * 地址，插件（dsh-better-sidebar）拿到地址后**在渲染端**用会话的 cwd 把相对路径拼成绝对
 * 路径，再交给宿主的 `/sidebar/html/<sid>/<绝对路径>` 路由预览。链条上任何一环拿不到 cwd，
 * 相对路径就被原样送到宿主，宿主的 `requireAbsolute()` 把 `/index.html` 解析成
 * `C:\index.html`，于是：
 *   · 侧栏预览 → `{"ok":false,"error":{"code":"fs-error","message":"cannot resolve target \"C:\\index.html\"…"}}`
 *   · 「在文件管理器中显示」→ shell.showItemInFolder 收到相对路径，静默什么都不发生
 * 两根都见过（2026-09-25 学生实机截图 + 对运行中宿主的 curl 复核：同一 sessionId，
 * 相对路径 400、带盘符的绝对路径 200）。
 *
 * 兜底来源是登录门写好的课堂工作区路径（`client-context.workspacePath`，与写进会话
 * header 的 cwd 同源）。它只做**拼接**，不参与任何权限判定：真正的门禁仍在宿主侧。
 */
import { useEffect, useState } from 'react'
import { isAbsoluteWorkspacePath, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'

interface LingdongContextBridge {
  readonly context?: (options?: unknown) => Promise<unknown>
  readonly contextSync?: () => unknown
}

let pending: Promise<string> | null = null
let syncRoot = ''

/** 只问一次登录门（读的是本地缓存的 client-context，不发网络请求）；拿不到就空串。 */
function readWorkspaceRoot(): Promise<string> {
  if (pending !== null) return pending
  pending = (async (): Promise<string> => {
    if (typeof window === 'undefined') return ''
    const bridge = (window as Window & { readonly lingdong?: LingdongContextBridge }).lingdong
    if (bridge?.context === undefined) return ''
    try {
      const raw = await bridge.context()
      const value = (raw as { readonly workspacePath?: unknown } | null)?.workspacePath
      return typeof value === 'string' ? value.trim() : ''
    } catch {
      return ''
    }
  })()
  return pending
}

/** 当前课堂工作区。`ready` 表示「问过一次了」——调用方据此决定要不要等一下再拼路径。 */
export interface LingdongWorkspaceRoot {
  readonly root: string
  readonly ready: boolean
}

/** 同步读一次课堂工作区（同步 IPC，读的是登录门写的本地缓存）。 */
function readWorkspaceRootSync(): string {
  if (syncRoot !== '' || typeof window === 'undefined') return syncRoot
  const bridge = (window as Window & { readonly lingdong?: LingdongContextBridge }).lingdong
  try {
    const raw = bridge?.contextSync?.()
    const value = (raw as { readonly workspacePath?: unknown } | null)?.workspacePath
    if (typeof value === 'string' && value.trim() !== '') syncRoot = value.trim()
  } catch { /* 拿不到就用异步那次 */ }
  return syncRoot
}

/** 当前课堂工作区（拿不到时空串、ready 仍为 true）。用于给交付文件路径兜底。 */
export function useLingdongWorkspaceRoot(): LingdongWorkspaceRoot {
  const [state, setState] = useState<LingdongWorkspaceRoot>(() => {
    const sync = readWorkspaceRootSync()
    return sync === '' ? { root: '', ready: false } : { root: sync, ready: true }
  })
  useEffect(() => {
    let alive = true
    const sync = readWorkspaceRootSync()
    if (sync !== '' && alive) setState({ root: sync, ready: true })
    void readWorkspaceRoot().then((root) => { if (alive && root !== '') setState({ root, ready: true }) })
    return () => { alive = false }
  }, [])
  return state
}

/**
 * 把交付文件路径解析成绝对路径：会话 cwd 优先，课堂工作区兜底。
 * 两边都没有（浏览器测试、宿主侧渲染）时原样返回，调用方按老路走。
 */
export function lingdongAbsolutePath(
  cwd: string | undefined,
  path: string,
  workspaceRoot: string,
): string {
  if (isAbsoluteWorkspacePath(path)) return path
  const base = cwd !== undefined && cwd !== '' ? cwd : workspaceRoot
  return base === '' ? path : resolveWorkspacePath(base, path)
}