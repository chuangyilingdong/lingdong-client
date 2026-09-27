/**
 * 灵动ai 客户端启动更新：平台清单 → 用户确认 → 下载校验 → 静默安装 → 重启。
 *
 * 当前安装包未签名，所以这里不依赖 electron-updater 的签名策略，
 * 而是以平台 HTTPS 清单中的 SHA256 作为下载完整性校验。
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { gt, valid } from 'semver'

const API_BASE = String(process.env.LINGDONG_API_BASE || 'https://aicyld.com').replace(/\/+$/u, '')
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

interface UpdateFile {
  readonly name?: unknown
  readonly size?: unknown
  readonly sha256?: unknown
  readonly url?: unknown
}

type LingdongUpdateTarget = 'mac-arm64' | 'win-x64'

interface UpdateManifest {
  readonly enabled?: unknown
  readonly version?: unknown
  readonly channel?: unknown
  readonly mandatory?: unknown
  readonly minVersion?: unknown
  readonly note?: unknown
  readonly files?: Record<string, UpdateFile | null> | unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function updateTarget(): LingdongUpdateTarget | null {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'mac-arm64'
  return null
}

function expectedUpdateName(target: LingdongUpdateTarget, version: string): string {
  return target === 'win-x64'
    ? `lingdong-client-${version}-win-x64.exe`
    : `lingdong-client-${version}-mac-arm64.dmg`
}

function updateExtension(target: LingdongUpdateTarget): 'dmg' | 'exe' {
  return target === 'win-x64' ? 'exe' : 'dmg'
}

function gateDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'gate')
    : join(app.getAppPath(), 'resources', 'gate')
}

async function fetchManifest(): Promise<UpdateManifest> {
  const url = `${API_BASE}/downloads/manifest.json?t=${Date.now()}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as UpdateManifest
  } finally {
    clearTimeout(timer)
  }
}

function updateWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 480,
    height: 280,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: true,
    show: false,
    backgroundColor: '#7e1123',
    title: '灵动ai创作客户端更新',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.setMenuBarVisibility(false)
  return window
}

async function reportUpdate(window: BrowserWindow | null, percent: number, message: string): Promise<void> {
  if (window === null || window.isDestroyed()) return
  const payload = JSON.stringify({ percent, message })
  await window.webContents.executeJavaScript(`window.__lingdongUpdate && window.__lingdongUpdate(${payload})`).catch(() => undefined)
}

function allowedUpdateUrl(candidate: string): string {
  const base = new URL(`${API_BASE}/`)
  const url = new URL(candidate, base)
  const localDevelopment = !app.isPackaged && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  if (url.protocol !== 'https:' && !(localDevelopment && url.protocol === 'http:')) {
    throw new Error('更新地址必须使用 HTTPS')
  }
  if (!localDevelopment && url.origin !== base.origin) throw new Error('更新地址不是平台下载域名')
  if (!url.pathname.startsWith('/downloads/')) throw new Error('更新地址不是平台下载目录')
  return url.href
}

function downloadUrl(file: UpdateFile, name: string): string {
  const configured = text(file.url)
  if (configured !== '') return allowedUpdateUrl(configured)
  return allowedUpdateUrl(`${API_BASE}/downloads/${encodeURIComponent(name)}`)
}

async function downloadAndVerify(
  window: BrowserWindow | null,
  file: UpdateFile,
  version: string,
  target: LingdongUpdateTarget,
): Promise<string> {
  const name = text(file.name)
  const expectedName = expectedUpdateName(target, version)
  if (name !== expectedName) throw new Error(`更新清单文件名不匹配：期望 ${expectedName}`)
  const expectedHash = text(file.sha256).toLocaleLowerCase('en-US')
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) throw new Error('更新清单缺少有效的 SHA256')
  const expectedSize = Number(file.size)

  const destination = join(app.getPath('temp'), `lingdong-client-${version}-${Date.now()}.${updateExtension(target)}`)
  await rm(destination, { force: true }).catch(() => undefined)
  const controller = new AbortController()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const response = await fetch(downloadUrl(file, name), { signal: controller.signal })
    if (!response.ok || response.body === null) throw new Error(`下载安装包失败（HTTP ${response.status}）`)
    const total = Number(response.headers.get('content-length')) || (Number.isSafeInteger(expectedSize) ? expectedSize : 0)
    const downloadTimeout = setTimeout(() => controller.abort(), 20 * 60_000)
    try {
      handle = await open(destination, 'w')
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let received = 0
    let lastReport = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)) continue
      await handle.write(chunk.value)
      hash.update(chunk.value)
      received += chunk.value.byteLength
      const now = Date.now()
      if (now - lastReport > 120) {
        lastReport = now
        const percent = total > 0 ? Math.min(99, Math.round(received * 100 / total)) : 0
        await reportUpdate(window, percent, `正在下载更新 ${percent > 0 ? `${percent}%` : ''}`.trim())
      }
    }
    await handle.close()
    handle = undefined
    if (Number.isSafeInteger(expectedSize) && expectedSize > 0 && received !== expectedSize) {
      throw new Error(`安装包大小不一致（期望 ${expectedSize}，实际 ${received}）`)
    }
      const actualHash = hash.digest('hex').toLocaleLowerCase('en-US')
      if (actualHash !== expectedHash) throw new Error('安装包 SHA256 校验失败')
      return destination
    } finally {
      clearTimeout(downloadTimeout)
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(destination, { force: true }).catch(() => undefined)
    throw error
  }
}

async function launchInstallerAndRestart(installerPath: string, target: LingdongUpdateTarget): Promise<void> {
  if (target === 'mac-arm64') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/open', [installerPath], { detached: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
    return
  }

  const script = join(app.getPath('temp'), `lingdong-client-update-${Date.now()}.cmd`)
  const result = join(app.getPath('temp'), 'lingdong-client-update-result.txt')
  const currentExecutable = process.execPath
  await rm(result, { force: true }).catch(() => undefined)
  const content = [
    '@echo off',
    'ping 127.0.0.1 -n 2 >nul',
    `start "" /wait "${installerPath}" /S --updated`,
    'set "LINGDONG_UPDATE_EXIT=%ERRORLEVEL%"',
    'if not "%LINGDONG_UPDATE_EXIT%"=="0" (',
    `  >"${result}" echo %LINGDONG_UPDATE_EXIT%`,
    `  start "" "${currentExecutable}"`,
    '  del /f /q "%~f0" >nul 2>nul',
    '  exit /b',
    ')',
    `del /f /q "${installerPath}" >nul 2>nul`,
    `start "" "${currentExecutable}"`,
    'del /f /q "%~f0" >nul 2>nul',
  ].join('\r\n')
  writeFileSync(script, `${content}\r\n`, 'utf8')
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

/** @returns True when the app must quit and let the updater finish. */
async function reportPreviousUpdateFailure(): Promise<void> {
  if (process.platform !== 'win32') return
  const file = join(app.getPath('temp'), 'lingdong-client-update-result.txt')
  const value = await readFile(file, 'utf8').catch(() => '')
  if (value.trim() === '') return
  await rm(file, { force: true }).catch(() => undefined)
  await dialog.showMessageBox({
    type: 'error',
    title: '上次更新失败',
    message: '客户端没有完成上次更新',
    detail: `安装器退出码：${value.trim()}\n请重新打开客户端后再次尝试更新。`,
    buttons: ['知道了'],
    noLink: true,
  })
}

export async function runLingdongUpdater(): Promise<boolean> {
  if (!app.isPackaged && process.env.LINGDONG_UPDATE_ALLOW_DEV !== '1') return false
  if (process.argv.includes('--updated')) return false
  await reportPreviousUpdateFailure()
  const target = updateTarget()
  if (target === null) return false

  let manifest: UpdateManifest
  try { manifest = await fetchManifest() }
  catch (error) {
    console.warn('[lingdong] 更新检查失败（不阻塞启动）', error)
    return false
  }
  if (manifest.enabled === false) return false
  if ((text(manifest.channel) || 'stable') !== (process.env.LINGDONG_UPDATE_CHANNEL || 'stable')) return false
  const version = text(manifest.version)
  const latest = valid(version)
  const current = valid(app.getVersion())
  if (version === '' || VERSION_PATTERN.test(version) === false || latest === null || current === null || !gt(latest, current)) return false
  const files = manifest.files !== null && typeof manifest.files === 'object' && !Array.isArray(manifest.files)
    ? manifest.files as Record<string, UpdateFile | null>
    : {}
  const file = files[target]
  if (file === null || file === undefined || typeof file !== 'object') return false
  const minimum = valid(text(manifest.minVersion))
  const required = bool(manifest.mandatory) || (minimum !== null && gt(minimum, current))
  const note = text(manifest.note)
  const installHint = target === 'mac-arm64'
    ? '点击“立即更新”后，客户端会自动下载并打开安装包；把应用拖到“应用程序”并替换后，再重新打开客户端。'
    : '点击“立即更新”后，客户端会自动下载、安装并重新启动。'
  const result = await dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `灵动ai创作客户端 ${version}`,
    detail: `当前版本：${app.getVersion()}\n\n${note || '本次更新包含客户端功能与稳定性改进。'}\n\n${installHint}`,
    buttons: required ? ['立即更新'] : ['立即更新', '稍后更新'],
    defaultId: 0,
    cancelId: required ? 0 : 1,
    noLink: true,
  })
  if (result.response !== 0) return false

  const window = updateWindow()
  let allowClose = false
  window.on('close', (event) => { if (!allowClose) event.preventDefault() })
  try {
    await window.loadFile(join(gateDirectory(), 'update.html'))
    window.show()
    await reportUpdate(window, 0, '正在准备更新…')
    const installer = await downloadAndVerify(window, file, version, target)
    if (target === 'mac-arm64') {
      await reportUpdate(window, 100, '下载完成，正在打开安装包…')
      await dialog.showMessageBox({
        type: 'info',
        title: '准备安装新版本',
        message: `灵动ai创作客户端 ${version} 已下载并校验`,
        detail: '接下来会打开安装包。请在安装窗口里把“灵动ai创作客户端”拖到“应用程序”，选择替换旧版本，完成后重新打开客户端。',
        buttons: ['打开安装包'],
        defaultId: 0,
        noLink: true,
      })
    } else {
      await reportUpdate(window, 100, '下载完成，正在安装并重启…')
    }
    await launchInstallerAndRestart(installer, target)
    allowClose = true
    setTimeout(() => app.quit(), 300)
    return true
  } catch (error) {
    allowClose = true
    if (!window.isDestroyed()) window.destroy()
    await dialog.showMessageBox({
      type: 'error',
      title: '更新失败',
      message: '客户端更新没有完成',
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}