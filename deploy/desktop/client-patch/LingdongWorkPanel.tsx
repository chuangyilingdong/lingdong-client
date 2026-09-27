/**
 * 灵动ai 侧栏「交作品」面板。
 *
 * 交付方式（2026-09-19 定稿）：
 *   · 点击展开后，扫描本机客户端**有效会话**交付过的作品文件；
 *   · 不弹原生文件选择器，逐项勾选、支持全选；
 *   · 勾选后串行提交，每个作品连同它引用的本地资源一起交给主进程；
 *   · 全部提交完成后只查一次 GET /api/student/works，回显平台原始 warnings/missing/作品列表。
 *
 * 平台契约没有「课堂/课时 ↔ dsh session」映射，所以界面只如实写“本机客户端有效会话交付过的作品文件”，
 * 并用平台作品列表里已有的课时与入口文件识别“这份是不是已经交过”。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ISessions, SessionEventLikeEntry, SessionListState, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

type LingdongWorkPanelProps = PropsRuntime<'sidebar.workspaces.lingdongWork'>

interface WorkCandidate {
  readonly key: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly cwd: string
  readonly path: string
  readonly displayPath: string
  readonly updatedAt: number
  readonly source: 'session' | 'workspace'
  readonly submittable: boolean
}

interface WorkItemView {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly source: string
  readonly entryFile: string
  readonly lessonTitle: string
  readonly submittedAt: string
  readonly teacherComment: string
  readonly submissionRound: number
}

interface WorksView {
  readonly items: readonly WorkItemView[]
  readonly total: number
}

interface ClassroomView {
  readonly id: string
  readonly lessonTitle: string
}

interface BatchBridgeItem {
  readonly sessionId: string
  readonly sessionTitle: string
  readonly cwd: string
  readonly path: string
  readonly displayPath?: string
}

interface BatchResponse {
  readonly ok?: boolean
  readonly message?: string
  readonly submitted?: unknown
  readonly failures?: unknown
  readonly warnings?: unknown
  readonly missing?: unknown
  readonly works?: unknown
  readonly worksError?: unknown
}

interface LingdongDesktopBridge {
  readonly submitWorkBatch?: (payload: {
    readonly copyrightConfirmed: true
    readonly items: readonly BatchBridgeItem[]
  }) => Promise<BatchResponse | undefined>
  readonly listWorks?: () => Promise<unknown>
  readonly scanWorkFiles?: () => Promise<unknown>
  readonly context?: () => Promise<unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => typeof item === 'string' ? item : String(item ?? '')).filter(item => item !== '')
}

function eventOf(entry: SessionEventLikeEntry): { readonly type: string; readonly data: unknown } | null {
  const event = asRecord(entry.event)
  if (event === null || typeof event.type !== 'string') return null
  return { type: event.type, data: event.data }
}

function pathValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function mutationPath(name: string, argsRaw: string): string | null {
  let args: unknown
  try {
    args = JSON.parse(argsRaw) as unknown
  } catch {
    return null
  }
  const record = asRecord(args)
  if (record === null) return null
  switch (name) {
    case 'write':
      return typeof record.content === 'string' ? pathValue(record.file_path) : null
    case 'edit': {
      const oldString = record.old_string
      const newString = record.new_string
      const replaceAll = record.replace_all
      const valid = typeof oldString === 'string' && oldString.length > 0
        && typeof newString === 'string' && oldString !== newString
        && (replaceAll === undefined || typeof replaceAll === 'boolean')
      return valid ? pathValue(record.file_path) : null
    }
    case 'str_replace_editor': {
      const path = pathValue(record.path)
      if (path === null) return null
      switch (record.command) {
        case 'create':
          return typeof record.file_text === 'string' ? path : null
        case 'str_replace':
          return typeof record.old_str === 'string' && record.old_str.length > 0
            && (record.new_str === undefined || typeof record.new_str === 'string')
            ? path
            : null
        case 'insert':
          return typeof record.insert_line === 'number' && Number.isInteger(record.insert_line)
            && record.insert_line >= 0 && typeof record.new_str === 'string'
            ? path
            : null
        default:
          return null
      }
    }
    default:
      return null
  }
}

function normalizedPath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//u, '').split(/[?#]/u)[0] ?? raw
}

function pathBasename(raw: string): string {
  const normalized = raw.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || normalized
}

const SUBMITTABLE_WORK_EXTENSIONS = new Set(['.htm', '.html', '.docx', '.xlsx', '.pptx'])
function extensionOf(raw: string): string {
  const extension = /\.([a-z0-9]+)$/iu.exec(pathBasename(raw))?.[1]
  return extension === undefined ? '' : '.' + extension.toLocaleLowerCase('en-US')
}

function isSubmittableWorkPath(raw: string): boolean {
  return SUBMITTABLE_WORK_EXTENSIONS.has(extensionOf(raw))
}

function displayPathFor(cwd: string, raw: string): string {
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/+$/u, '')
  const normalizedRaw = raw.replace(/\\/g, '/')
  if (normalizedRaw.toLocaleLowerCase('en-US').startsWith(`${normalizedCwd.toLocaleLowerCase('en-US')}/`)) {
    return normalizedRaw.slice(normalizedCwd.length + 1)
  }
  return normalizedRaw.startsWith('/') || /^[a-z]:\//iu.test(normalizedRaw) ? pathBasename(raw) : normalizedRaw
}

function extractSessionWorks(entries: readonly SessionEventLikeEntry[], summary: SessionSummary): WorkCandidate[] {
  const calls = new Map<string, string | null>()
  const found = new Map<string, WorkCandidate>()
  const cwd = summary.cwd?.trim() ?? ''
  if (cwd === '') return []
  const add = (rawPath: string): void => {
    if (!isSubmittableWorkPath(rawPath)) return
    const normalized = normalizedPath(rawPath)
    if (normalized === '') return
    const key = `${summary.id}\u0000${normalized}`
    if (found.has(key)) return
    found.set(key, {
      key,
      sessionId: summary.id,
      sessionTitle: summary.displayTitle || summary.title || summary.id,
      cwd,
      path: rawPath,
      displayPath: displayPathFor(cwd, rawPath),
      updatedAt: summary.updatedAt,
      source: 'session',
      submittable: true,
    })
  }

  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const event = eventOf(entry)
    if (event === null) continue
    const data = asRecord(event.data)
    if (data === null) continue
    if (event.type === 'tool/call') {
      const callId = asString(data.callId)
      const name = asString(data.name)
      const args = asString(data.arguments)
      if (callId !== '') calls.set(callId, name === '' ? null : mutationPath(name, args))
      continue
    }
    if (event.type === 'tool/result') {
      const message = asRecord(data.message)
      const content = Array.isArray(message?.content) ? message.content : []
      const first = asRecord(content[0])
      if (first?.isError === true) continue
      const source = asRecord(message?.source)
      const callId = asString(source?.callId)
      const path = calls.get(callId)
      if (path !== undefined && path !== null) add(path)
      continue
    }
    if (event.type === 'deliverables/presented') {
      const files = Array.isArray(data.files) ? data.files : []
      for (const file of files) {
        const path = pathValue(asRecord(file)?.path)
        if (path !== null) add(path)
      }
    }
  }
  return [...found.values()]
}

async function scanWorkCandidates(
  sessions: ISessions,
  list: SessionListState,
  signal: AbortSignal,
): Promise<WorkCandidate[]> {
  const summaries = Object.values(list.byId)
    .filter(summary => summary.blank !== true && summary.origin !== 'subagent' && (summary.cwd?.trim() ?? '') !== '')
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const found = new Map<string, WorkCandidate>()

  for (const summary of summaries) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    try {
      await sessions.using(summary.id, { source: 'workspaceOperation', signal }, async (reference) => {
        const session = reference.binding.session
        let window = reference.binding.eventSource.getSnapshot()
        let guard = 0
        while (window.hasMore && guard < 500) {
          const revision = window.revision
          const length = window.entries.length
          await session.loadOlder()
          const next = reference.binding.eventSource.getSnapshot()
          if (next.revision === revision && next.entries.length === length) break
          window = next
          guard += 1
        }
        for (const candidate of extractSessionWorks(window.entries, summary)) found.set(candidate.key, candidate)
      })
    } catch (error) {
      if (signal.aborted) throw error
      // 某个坏会话不应拖垮整个作品面板；其它会话继续扫描。
      console.warn('[lingdong] 扫描会话作品失败', summary.id, error)
    }
  }
  return [...found.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.displayPath.localeCompare(right.displayPath))
}

async function scanWorkspaceCandidates(
  bridge: LingdongDesktopBridge | undefined,
  signal: AbortSignal,
): Promise<WorkCandidate[]> {
  if (bridge?.scanWorkFiles === undefined || signal.aborted) return []
  const response = await bridge.scanWorkFiles().catch(() => null)
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  const root = asRecord(response)
  if (root?.ok !== true || typeof root.root !== 'string' || !Array.isArray(root.files)) return []
  const cwd = root.root
  return root.files.flatMap((value): WorkCandidate[] => {
    const record = asRecord(value)
    const rawPath = asString(record?.path)
    const displayPath = asString(record?.displayPath) || pathBasename(rawPath)
    const title = asString(record?.title) || pathBasename(rawPath)
    const updatedAt = typeof record?.updatedAt === 'number' ? record.updatedAt : 0
    if (rawPath === '' || !isSubmittableWorkPath(rawPath)) return []
    const normalized = normalizedPath(rawPath)
    return [{
      key: `workspace\u0000${normalized}`,
      sessionId: 'workspace',
      sessionTitle: title,
      cwd,
      path: rawPath,
      displayPath,
      updatedAt,
      source: 'workspace',
      submittable: true,
    }]
  })
}

function normalizeWorks(value: unknown): WorksView {
  const root = asRecord(value)
  const items = Array.isArray(root?.items) ? root.items : []
  const summary = asRecord(root?.summary)
  const normalized = items.map((item): WorkItemView => {
    const record = asRecord(item) ?? {}
    return {
      id: asString(record.id),
      title: asString(record.title),
      status: asString(record.status),
      source: asString(record.source),
      entryFile: asString(record.entryFile),
      lessonTitle: asString(record.lessonTitle),
      submittedAt: asString(record.submittedAt),
      teacherComment: asString(record.teacherComment),
      submissionRound: typeof record.submissionRound === 'number' ? record.submissionRound : 0,
    }
  }).filter(item => item.id !== '')
  return { items: normalized, total: typeof summary?.total === 'number' ? summary.total : normalized.length }
}

function normalizedEntryName(raw: string): string {
  return pathBasename(normalizedPath(raw)).toLocaleLowerCase('en-US')
}

function submittedKeysFor(
  candidates: readonly WorkCandidate[],
  works: readonly WorkItemView[],
  lessonTitle: string,
): ReadonlySet<string> {
  const submittedNames = new Set(
    works
      .filter(work => work.source.toUpperCase() === 'VIBECODING')
      .filter(work => work.status.toUpperCase() !== 'REJECTED')
      .filter(work => lessonTitle === '' || work.lessonTitle === '' || work.lessonTitle === lessonTitle)
      .map(work => normalizedEntryName(work.entryFile))
      .filter(Boolean),
  )
  const byName = new Map<string, WorkCandidate[]>()
  for (const item of candidates) {
    const name = normalizedEntryName(item.path)
    const group = byName.get(name)
    if (group === undefined) byName.set(name, [item])
    else group.push(item)
  }
  const result = new Set<string>()
  for (const name of submittedNames) {
    const matches = byName.get(name) ?? []
    // A basename alone cannot identify a work when the same lesson contains several index.html-like files.
    if (matches.length === 1 && matches[0] !== undefined) result.add(matches[0].key)
  }
  return result
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  PENDING: '待老师查看',
  APPROVED: '已通过',
  REJECTED: '需修改',
  PUBLISHED: '已发布',
}

const styles = {
  root: {
    margin: '0 12px 8px',
    padding: '0 0 6px',
    borderBottom: '1px solid rgba(127, 127, 127, 0.16)',
    color: 'inherit',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    minHeight: '30px',
    padding: '5px 2px 6px',
    border: 0,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 650,
    textAlign: 'left',
  },
  arrow: { width: '14px', fontSize: '11px', opacity: 0.62 },
  panel: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '0 0 8px' },
  intro: { fontSize: '11px', lineHeight: 1.45, opacity: 0.62 },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
  selectionLine: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' },
  smallButton: {
    padding: '4px 7px', border: '1px solid rgba(127, 127, 127, 0.24)', borderRadius: '7px',
    background: 'rgba(127, 127, 127, 0.06)', color: 'inherit', cursor: 'pointer', fontSize: '11px',
  },
  list: {
    display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '260px', overflowY: 'auto',
    padding: '2px 0',
  },
  item: {
    display: 'flex', alignItems: 'flex-start', gap: '7px', padding: '7px 8px',
    border: '1px solid rgba(127, 127, 127, 0.18)', borderRadius: '8px',
    background: 'rgba(127, 127, 127, 0.045)', fontSize: '11px', lineHeight: 1.38,
  },
  itemBody: { minWidth: 0, flex: 1 },
  itemTitle: { fontWeight: 600, overflowWrap: 'anywhere' },
  itemMeta: { marginTop: '2px', opacity: 0.58, overflowWrap: 'anywhere' },
  submit: {
    width: '100%', padding: '8px 10px', border: 0, borderRadius: '8px', background: '#b42318',
    color: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: 650,
  },
  state: { fontSize: '11px', lineHeight: 1.45, opacity: 0.62 },
  error: { padding: '7px 8px', borderRadius: '7px', background: 'rgba(185, 28, 28, 0.08)', color: '#b42318', fontSize: '11px', lineHeight: 1.45 },
  success: { padding: '7px 8px', borderRadius: '7px', background: 'rgba(22, 128, 61, 0.08)', color: '#167a3d', fontSize: '11px', lineHeight: 1.45 },
  warning: { padding: '7px 8px', borderRadius: '7px', background: 'rgba(180, 102, 0, 0.09)', color: '#9a5a00', fontSize: '11px', lineHeight: 1.45 },
  result: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '240px', overflowY: 'auto', fontSize: '11px', lineHeight: 1.4 },
  resultItem: { padding: '6px 7px', border: '1px solid rgba(127, 127, 127, 0.16)', borderRadius: '7px', overflowWrap: 'anywhere' },
} as const

function selectedItems(items: readonly WorkCandidate[], selected: ReadonlySet<string>): WorkCandidate[] {
  return items.filter(item => selected.has(item.key))
}

/** 侧栏作品面板：扫描、勾选、串行提交、一次回显。 */
export function LingdongWorkPanel({ sessions, sessionList }: LingdongWorkPanelProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'idle' | 'scanning' | 'submitting'>('idle')
  const [items, setItems] = useState<readonly WorkCandidate[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [submittedKeys, setSubmittedKeys] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState('')
  const [result, setResult] = useState<BatchResponse | null>(null)
  const aborter = useRef<AbortController | null>(null)
  const submitBusy = useRef(false)

  useEffect(() => () => { aborter.current?.abort() }, [])

  const scan = useCallback(async () => {
    if (sessions === undefined) {
      setError('会话服务还没有就绪，请稍后重试。')
      return
    }
    aborter.current?.abort()
    const controller = new AbortController()
    aborter.current = controller
    setBusy('scanning')
    setError('')
    setResult(null)
    try {
      const bridge = (window as Window & { readonly lingdong?: LingdongDesktopBridge }).lingdong
      const [sessionCandidates, workspaceCandidates] = await Promise.all([
        scanWorkCandidates(sessions, sessionList, controller.signal),
        scanWorkspaceCandidates(bridge, controller.signal),
      ])
      if (controller.signal.aborted) return
      const merged = [...sessionCandidates]
      const seenPaths = new Set(merged.map(item => normalizedPath(item.path).toLocaleLowerCase('en-US')))
      for (const item of workspaceCandidates) {
        const identity = normalizedPath(item.path).toLocaleLowerCase('en-US')
        if (seenPaths.has(identity)) continue
        seenPaths.add(identity)
        merged.push(item)
      }
      const next = merged.sort((left, right) => right.updatedAt - left.updatedAt || left.displayPath.localeCompare(right.displayPath))
      let platformWorks = normalizeWorks(null)
      let classroom: ClassroomView = { id: '', lessonTitle: '' }
      if (bridge?.listWorks !== undefined) {
        const [worksResponse, contextResponse] = await Promise.all([
          bridge.listWorks().catch(() => null),
          bridge.context?.().catch(() => null) ?? Promise.resolve(null),
        ])
        const worksRecord = asRecord(worksResponse)
        if (worksRecord?.ok === true) platformWorks = normalizeWorks(worksRecord.works)
        const contextRecord = asRecord(contextResponse)
        const classroomRecord = asRecord(contextRecord?.classroom)
        classroom = { id: asString(classroomRecord?.id), lessonTitle: asString(classroomRecord?.lessonTitle) }
      }
      if (controller.signal.aborted) return
      const submitted = submittedKeysFor(next, platformWorks.items, classroom.lessonTitle)
      setItems(next)
      setSubmittedKeys(submitted)
      setSelected(new Set(next.filter(item => item.submittable && !submitted.has(item.key)).map(item => item.key)))
    } catch (scanError) {
      if (controller.signal.aborted) return
      setError(scanError instanceof Error ? scanError.message : String(scanError))
    } finally {
      if (!controller.signal.aborted) setBusy('idle')
    }
  }, [sessionList, sessions])

  const toggleOpen = (): void => {
    const next = !open
    setOpen(next)
    if (next) void scan()
  }

  const selectable = useMemo(() => items.filter(item => item.submittable && !submittedKeys.has(item.key)), [items, submittedKeys])
  const allSelected = selectable.length > 0 && selectable.every(item => selected.has(item.key))
  const chosen = useMemo(() => selectedItems(items, selected).filter(item => item.submittable && !submittedKeys.has(item.key)), [items, selected, submittedKeys])
  const works = useMemo(() => result === null ? null : normalizeWorks(result.works), [result])
  const submitted = useMemo(() => {
    if (!Array.isArray(result?.submitted)) return []
    return result.submitted.map((entry: unknown) => {
      const record = asRecord(entry) ?? {}
      const item = asRecord(record.item) ?? {}
      return {
        title: asString(item.sessionTitle) || asString(item.displayPath) || '作品',
        path: asString(item.displayPath) || asString(item.path),
        warnings: strings(record.warnings),
        missing: strings(record.missing),
        nearby: strings(record.nearby),
      }
    })
  }, [result])
  const failures = useMemo(() => {
    if (!Array.isArray(result?.failures)) return []
    return result.failures.map((entry: unknown) => {
      const record = asRecord(entry) ?? {}
      const item = asRecord(record.item) ?? {}
      return {
        title: asString(item.sessionTitle) || asString(item.displayPath) || '作品',
        path: asString(item.displayPath) || asString(item.path),
        code: asString(record.code),
        message: asString(record.message) || '提交失败',
      }
    })
  }, [result])

  const submit = useCallback(async () => {
    if (chosen.length === 0 || submitBusy.current) return
    const bridge = (window as Window & { readonly lingdong?: LingdongDesktopBridge }).lingdong
    if (bridge?.submitWorkBatch === undefined) {
      setError('客户端作品桥还没加载，请重启客户端后再试。')
      return
    }
    submitBusy.current = true
    setBusy('submitting')
    setError('')
    try {
      const response = await bridge.submitWorkBatch({
        copyrightConfirmed: true,
        items: chosen.map(item => ({
          sessionId: item.sessionId,
          sessionTitle: item.sessionTitle,
          cwd: item.cwd,
          path: item.path,
          displayPath: item.displayPath,
        })),
      })
      if (response === undefined) throw new Error('没有收到提交结果。')
      if (response.ok !== true) throw new Error(response.message || '提交失败。')
      setResult(response)
      const succeeded = new Set<string>()
      if (Array.isArray(response.submitted)) {
        for (const entry of response.submitted) {
          const item = asRecord(asRecord(entry)?.item)
          const sessionId = asString(item?.sessionId)
          const path = asString(item?.path)
          const key = `${sessionId}\u0000${normalizedPath(path)}`
          succeeded.add(key)
        }
      }
      if (succeeded.size > 0) {
        setSubmittedKeys(current => new Set([...current, ...succeeded]))
        setSelected(current => new Set([...current].filter(key => !succeeded.has(key))))
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    } finally {
      submitBusy.current = false
      setBusy('idle')
    }
  }, [chosen])

  return (
    <section style={styles.root} aria-label="交作品">
      <button type="button" style={styles.header} aria-expanded={open} onClick={toggleOpen}>
        <span>交作品</span>
        <span style={{ ...styles.arrow, display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }} aria-hidden>›</span>
      </button>
      {open && (
        <div style={styles.panel}>
          <div style={styles.intro}>
            扫描当前课堂工作区和本机有效会话里的作品文件。HTML、Word、Excel、PPT 可直接提交；其它常见文件会显示出来，但需平台扩展作品类型后才能提交。
          </div>
          <div style={styles.toolbar}>
            <label style={styles.selectionLine}>
              <input
                type="checkbox"
                checked={allSelected}
                disabled={selectable.length === 0 || busy !== 'idle'}
                onChange={event => setSelected(event.currentTarget.checked ? new Set(selectable.map(item => item.key)) : new Set())}
              />
              全选 {selectable.length > 0 ? `（${chosen.length}/${selectable.length}）` : ''}
            </label>
            <button type="button" style={styles.smallButton} disabled={busy !== 'idle'} onClick={() => { void scan() }}>
              {busy === 'scanning' ? '扫描中…' : '重新扫描'}
            </button>
          </div>

          {busy === 'scanning' && items.length === 0 && <div style={styles.state}>正在读取当前课堂工作区…</div>}
          {busy !== 'scanning' && items.length === 0 && <div style={styles.state}>没有找到可提交的作品文件。</div>}
          {items.length > 0 && selectable.length === 0 && <div style={styles.state}>找到的作品都已经提交过，无需重复提交。</div>}
          {items.length > 0 && (
            <div style={styles.list}>
              {items.map(item => {
                const isSubmitted = submittedKeys.has(item.key)
                return (
                <label key={item.key} style={styles.item}>
                  <input
                    type="checkbox"
                    checked={!isSubmitted && selected.has(item.key)}
                    disabled={busy !== 'idle' || isSubmitted}
                    onChange={event => {
                      const checked = event.currentTarget.checked
                      setSelected(current => {
                        const next = new Set(current)
                        if (checked) next.add(item.key)
                        else next.delete(item.key)
                        return next
                      })
                    }}
                  />
                  <span style={styles.itemBody}>
                    <span style={styles.itemTitle}>{item.sessionTitle}</span>
                    <span style={styles.itemMeta}>{item.displayPath}{isSubmitted ? ' · 已提交，无需重复提交' : ''}</span>
                  </span>
                </label>
                )
              })}
            </div>
          )}

          <button
            type="button"
            style={{ ...styles.submit, opacity: busy === 'idle' && chosen.length > 0 ? 1 : 0.45 }}
            disabled={busy !== 'idle' || chosen.length === 0}
            onClick={() => { void submit() }}
          >
            {busy === 'submitting' ? '正在按顺序提交…' : `提交已选 ${chosen.length} 份作品`}
          </button>

          {error !== '' && <div style={styles.error} role="alert">{error}</div>}
          {result !== null && (
            <>
              {(submitted.length > 0 || failures.length > 0) && (
                <div style={styles.success} role="status">
                  成功 {submitted.length} 份，失败 {failures.length} 份。
                </div>
              )}
              {submitted.length > 0 && (
                <div style={styles.result}>
                  {submitted.map((entry, index) => (
                    <div key={`ok-${index}`} style={styles.resultItem}>
                      <strong>已交：</strong>{entry.title} · {entry.path}
                      {entry.warnings.length > 0 && <div>提醒：{entry.warnings.join('；')}</div>}
                      {entry.missing.length > 0 && <div>本地缺失：{entry.missing.join('；')}</div>}
                      {entry.nearby.length > 0 && (
                        <div>
                          主产物同目录还有：{entry.nearby.join('、')}
                          （这些素材没有随作品提交；如果页面里用到了，请让模型改成相对路径引用后再交）
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {failures.length > 0 && (
                <div style={styles.error}>
                  {failures.map((entry, index) => (
                    <div key={`fail-${index}`}>
                      {entry.title} · {entry.path}：{entry.code !== '' ? `[${entry.code}] ` : ''}{entry.message}
                    </div>
                  ))}
                </div>
              )}
              {strings(result.warnings).length > 0 && (
                <div style={styles.warning}>平台提醒：{strings(result.warnings).join('；')}</div>
              )}
              {strings(result.missing).length > 0 && (
                <div style={styles.warning}>缺失内容：{strings(result.missing).join('；')}</div>
              )}
              {asString(result.worksError) !== '' && (
                <div style={styles.error}>作品已交完，但刷新「我交过的作品」失败：{asString(result.worksError)}</div>
              )}
              {works !== null && (
                <div style={styles.result}>
                  <div style={styles.state}>我交过的作品（共 {works.total} 件）</div>
                  {works.items.length === 0 && <div style={styles.state}>平台暂时没有返回作品记录。</div>}
                  {works.items.map(item => (
                    <div key={item.id} style={styles.resultItem}>
                      <strong>{item.title || item.entryFile || item.id}</strong>
                      <div>
                        {[STATUS_TEXT[item.status] ?? item.status, item.source, item.entryFile, item.lessonTitle, item.submittedAt]
                          .filter(part => part !== '').join(' · ')}
                      </div>
                      {item.teacherComment !== '' && <div>老师评语：{item.teacherComment}</div>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

/** 注册到 ui-workspace 新增的侧栏 slot；apply 只注册，不抛错。 */
export const lingdongWorkPanelEntry = {
  name: 'lingdong-work-panel',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('sidebar.workspaces.lingdongWork', () => ctx.slots.register({
      name: 'sidebar.workspaces.lingdongWork',
    }, LingdongWorkPanel))
  },
}