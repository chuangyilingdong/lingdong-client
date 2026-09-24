/**
 * 灵动ai 课堂工作区：进入一节课时自动切到“学生名-课时名”的独立工作区。
 *
 * 目录由登录门在 DSH 启动前创建，这里等 Workspace/Session Controller 就绪后注册它。
 * 新课堂没有历史 Session 时创建空白会话；重新打开同一课堂时继续最近一条会话，
 * 避免把上一节课的对话留在当前主面板里。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { UiWorkspace } from './navigation.ts'

interface LingdongContextState {
  readonly sessionId?: unknown
  readonly workspacePath?: unknown
}

interface LingdongContextBridge {
  readonly context?: () => Promise<unknown>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function samePath(left: string, right: string): boolean {
  return left.replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US')
    === right.replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US')
}

export const lingdongClassroomWorkspaceEntry = {
  name: 'lingdong-classroom-workspace',
  inject: ['workspaces', 'sessions', 'uiWorkspace'],
  apply(ctx: Context): void {
    const workspaces = ctx.get('workspaces') as IWorkspaces
    const sessions = ctx.get('sessions') as ISessions
    const uiWorkspace = ctx.get('uiWorkspace') as UiWorkspace
    let disposed = false
    let busy = false
    let appliedSessionId = ''

    const ensure = async (): Promise<void> => {
      if (disposed || busy || typeof window === 'undefined') return
      const bridge = (window as Window & { readonly lingdong?: LingdongContextBridge }).lingdong
      if (bridge?.context === undefined) return
      busy = true
      try {
        const raw = await bridge.context() as LingdongContextState | null
        const sessionId = text(raw?.sessionId)
        const workspacePath = text(raw?.workspacePath)
        if (sessionId === '' || workspacePath === '' || sessionId === appliedSessionId) return

        const workspaceSnapshot = workspaces.list.getSnapshot()
        if (workspaceSnapshot.phase !== 'ready') return
        let workspace: WorkspaceView | undefined = workspaceSnapshot.items.find(
          item => samePath(item.path, workspacePath),
        )
        if (workspace === undefined) workspace = await workspaces.create({ path: workspacePath })
        if (disposed || sessionId === appliedSessionId) return

        const sessionSnapshot = sessions.list.getSnapshot()
        if (sessionSnapshot.phase !== 'ready') return
        const archived = new Set(workspaces.list.getSnapshot().archivedSessionIds)
        const latestSessionId = [...workspace.sessionIds].reverse().find(
          id => sessionSnapshot.byId[id] !== undefined && !archived.has(id),
        )
        if (latestSessionId !== undefined) uiWorkspace.openSession(latestSessionId)
        else await uiWorkspace.openWorkspace(workspace.workspaceId)
        appliedSessionId = sessionId
      } catch (error) {
        console.warn('[lingdong] 自动切换课堂工作区失败', error)
      } finally {
        busy = false
      }
    }

    ctx.effect(() => {
      const stopWorkspaces = workspaces.list.subscribe(() => { void ensure() })
      const stopSessions = sessions.list.subscribe(() => { void ensure() })
      void ensure()
      return () => {
        disposed = true
        stopWorkspaces()
        stopSessions()
      }
    }, 'lingdong-classroom-workspace')
  },
}