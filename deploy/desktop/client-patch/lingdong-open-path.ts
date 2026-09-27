/**
 * 灵动ai：把「打开文件」的地址**钉成绝对路径**（2026-09-26，.2.10）。
 *
 * 为什么要在 DSH 的 openFile 咽喉处改：上游 `fileAddressFor(sessionId, cwd, path)` 会把
 * **工作区内的绝对路径降级成相对拼写**（`src/a.ts`），设计上要由右侧栏插件拿自己那份会话 cwd
 * 还原成绝对路径。而 `dsh-better-sidebar@0.19.1` 在 DSH 0.1.7 上拿不到 cwd
 * （`ctx.sessions.list.getSnapshot().byId[id]?.cwd` 为空）→ 相对路径一路送到宿主 →
 * 宿主的 `requireAbsolute()` 把 `/index.html` 按盘根解析成 `C:\index.html`：
 *   · 侧栏预览 → `fs-error: cannot resolve target "C:\index.html"`（学生图3）
 *   · 「在文件管理器中显示」→ `shell.showItemInFolder('index.html')` 静默失败（学生图2）
 * 2026-09-26 桩平台真机复现确认：工具行点 `index.html`，iframe src 就是
 * `/sidebar/html/<sid>/index.html`（相对），正文正是那句 fs-error。
 *
 * 修法：先在本端把路径拼成绝对（会话 cwd 优先、登录门给的课堂工作区兜底 —— 与
 * ui-deliverables 的 LingdongWorkspacePath 同源同义），再用 `sessionFileAddress()` 直接编码，
 * **绕开降级**。地址里带绝对路径对下游两种消费方都合法：
 *   · 侧栏插件 `resolveSidebarPath()` 见 `isAbsolutePath` 为真 → 原样透传 → 宿主 realpath 成功；
 *   · DSH 自带的文档预览走宿主会话文件系统解析，绝对路径同样落在会话工作区内，门禁不变。
 * 拿不到任何根目录时（浏览器测试、宿主侧渲染）保持上游行为，不改变语义。
 */
import { isAbsoluteWorkspacePath, resolveWorkspacePath, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

interface LingdongContextBridge {
  readonly context?: (options?: unknown) => Promise<unknown>
  readonly contextSync?: () => unknown
}

let pending: Promise<string> | null = null

/** 只问一次登录门（读本地缓存的 client-context，不发网络请求）；拿不到就空串。 */
function classroomRoot(): Promise<string> {
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

/** 已解析到的课堂工作区（同步快照，供 `openFile` 这种同步调用点使用）。 */
let resolvedRoot = ''

/**
 * 同步读一次课堂工作区（`contextSync` 走的是同步 IPC，读的是登录门写的本地缓存）。
 * 冷启动第一次点「打开」时它已经在手上，不会再退回相对路径。
 */
function readRootSync(): string {
  if (resolvedRoot !== '' || typeof window === 'undefined') return resolvedRoot
  const bridge = (window as Window & { readonly lingdong?: LingdongContextBridge }).lingdong
  try {
    const raw = bridge?.contextSync?.()
    const value = (raw as { readonly workspacePath?: unknown } | null)?.workspacePath
    if (typeof value === 'string' && value.trim() !== '') resolvedRoot = value.trim()
  } catch { /* 拿不到就等异步那次 */ }
  return resolvedRoot
}
readRootSync()
void classroomRoot().then((root) => { if (root !== '') resolvedRoot = root })

/**
 * 把一次「打开文件」调用编成会话地址：能拼绝对就带绝对路径（不降级），否则退回上游语义。
 * @param sessionId - 会话 id。
 * @param cwd - 该会话的工作区（可能缺失）。
 * @param path - 模型/上游给的路径（绝对或相对）。
 * @returns `dsh-resource://file/session/<id>/<路径>` 地址。
 */
export function lingdongFileAddress(sessionId: string, cwd: string | undefined, path: string): string {
  if (isAbsoluteWorkspacePath(path)) return sessionFileAddress(sessionId, path)
  const base = cwd !== undefined && cwd !== '' ? cwd : readRootSync()
  if (base === '') return sessionFileAddress(sessionId, path)
  return sessionFileAddress(sessionId, resolveWorkspacePath(base, path))
}