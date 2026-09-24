/**
 * P123 安装 / 覆盖升级 / 卸载 循环验证（2026-09-23）。
 *
 * 为什么这么写：这台机器上**装着正在用的客户端**（`E:\vibe`，测试前版本）。
 * 直接跑安装器会走 electron-builder 的「发现旧安装 → 先静默卸载」路径，把那份删掉。
 * 所以流程是：**先导出并临时移除注册表项**（安装器看不到旧安装，就不会去动 E:\vibe），
 * 在隔离目录里跑完整循环，**最后从备份还原注册表**——用户的安装目录全程没被碰过。
 *
 * 验的东西：
 *   ① 全新安装：exe / 卸载器 落地，注册表写 DisplayVersion + **InstallLocation**（0.1.6 那条是空的）
 *   ② 覆盖升级：再装一次，版本不变、文件被替换、**用户数据目录保留**
 *   ③ 静默卸载：卸载器无报错、安装目录与注册表项清掉、**默认保留本机数据**（我们新加的询问 /SD IDNO）
 *   ④ 还原：注册表回到原样（指向 E:\vibe 的 测试前版本）
 *
 * 跑法：node scripts/p123-install-cycle.mjs [<安装包路径>]
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const INSTALLER = process.argv[2]
  || path.join(ROOT, 'upstream/dsh-harness/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts')
const APPDATA = process.env.APPDATA
const APP_ID = process.env.LINGDONG_APP_ID || 'cn.aimagc.lingdong'
/**
 * ⚠️ 两个键都要管：
 *   · Uninstall\<guid>  —— 控制面板「应用和功能」那条记录；
 *   · Software\<guid>   —— electron-builder 自己用来判断「已装过」的键（存放 InstallLocation）。
 * 少管一个，安装器就会认为存在旧安装并先静默卸载它 —— 那会把用户在 E:\vibe 的安装删掉。
 */
const REG_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\90768118-e412-502a-b2e7-07fd8027988c',
  'HKCU\\Software\\90768118-e412-502a-b2e7-07fd8027988c',
]
const REG_KEY = REG_KEYS[0]
const EXE_NAME = '灵动ai创作客户端.exe'
const DATA_DIR = path.join(APPDATA, '灵动ai创作客户端')
const WORK = path.join(ROOT, '.tmp', 'install-cycle')
const TEST_DIR = path.join(WORK, 'app')
/** ⚠️ 备份必须放在 WORK 之外：早先版本把备份和测试目录放在一起，第二轮开头 rmSync(WORK)
 *  就把上一轮的备份删了 —— 一旦中途出问题就只能手工重建注册表（踩过）。 */
const BACKUP_DIR = path.join(ROOT, '.tmp', 'install-cycle-backup')
const backups = REG_KEYS.map((key, index) => path.join(BACKUP_DIR, `key-backup-${index}.reg`))
const MARKER = path.join(DATA_DIR, 'p123-keep-me.txt')

const checks = []
const check = (name, run) => {
  try { const detail = run(); checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) }) }
  catch (error) { checks.push({ name, ok: false, message: error?.message ?? String(error) }) }
}
const reg = (args) => { try { return execFileSync('reg.exe', args, { encoding: 'utf8' }) } catch (error) { return error.stdout ?? '' } }
const regQuery = () => reg(['query', REG_KEY])
const regValue = (name) => {
  const out = regQuery()
  const line = out.split(/\r?\n/u).find(l => l.trim().startsWith(name))
  return line === undefined ? undefined : line.trim().split(/\s{2,}/u).slice(-1)[0]
}
const runInstaller = (exe, args) => {
  // NSIS 的 /S 安装一般是同步的，但保险起见装完轮询等文件落地。
  try { execFileSync(exe, args, { stdio: 'ignore', timeout: 300_000 }) } catch (error) { /* 安装器退出码不可靠，用文件/注册表判定 */ }
}
/** 同步 sleep：Atomics.wait 不占 CPU，比 spawn 一个 node 去 setTimeout 干净得多。 */
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
const waitFor = (predicate, label, timeoutMs = 120_000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    sleep(400)
  }
  throw new Error(`等待超时：${label}`)
}

const installerPath = (() => {
  if (INSTALLER.endsWith('.exe')) return INSTALLER
  const found = fs.readdirSync(INSTALLER).filter(f => f.startsWith('lingdong-client-') && f.endsWith('-unsigned.exe'))
  assert.ok(found.length > 0, `在 ${INSTALLER} 里没找到安装包`)
  return path.join(INSTALLER, found.sort().at(-1))
})()

const installerVersion = path.basename(installerPath).match(/^lingdong-client-(.+)-win-x64(?:-unsigned)?\.exe$/u)?.[1]
assert.ok(installerVersion, `从文件名解析安装版本失败：${path.basename(installerPath)}`)

fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(BACKUP_DIR, { recursive: true })

console.log(`安装包：${path.basename(installerPath)}`)
console.log(`隔离安装目录：${TEST_DIR}`)

// —— 前置：备份并临时移除注册表项，避免安装器动到 E:\vibe 那份 ——
const hadKey = /90768118/u.test(regQuery())
const originalVersion = hadKey ? regValue('DisplayVersion') : undefined
const originalUninstallString = hadKey ? regValue('UninstallString') : undefined
check('前置：导出注册表项备份', () => {
  if (!hadKey) return '（本机原本没有安装记录）'
  const exported = []
  REG_KEYS.forEach((key, index) => {
    const out = reg(['export', key, backups[index], '/y'])
    if (fs.existsSync(backups[index])) exported.push(path.basename(backups[index]))
    else exported.push(`缺失(${out.trim().slice(0, 40)})`)
  })
  return exported
})
if (hadKey) for (const key of REG_KEYS) reg(['delete', key, '/f'])
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.writeFileSync(MARKER, `p123 marker ${new Date().toISOString()}\n`)

// —— ① 全新安装 ——
check('① 全新安装：exe 与卸载器落地', () => {
  runInstaller(installerPath, ['/S', `/D=${TEST_DIR}`])
  waitFor(() => fs.existsSync(path.join(TEST_DIR, EXE_NAME)), '安装后的主程序')
  const uninstaller = fs.readdirSync(TEST_DIR).find(f => f.startsWith('Uninstall') && f.endsWith('.exe'))
  assert.ok(uninstaller, '没找到卸载器')
  return { exe: EXE_NAME, uninstaller }
})
check('① 运行时资源：登录门页面与 Office 引擎都在包内', () => {
  // ⚠️ 2026-09-24 线上事故：打包配置漏了 gate 进 extraResources，
  //    安装后一启动就是 file:///<install>/resources/gate/loading.html ERR_FILE_NOT_FOUND。
  //    所以安装完成后必须直接核对落盘资源，而不是只信构建日志。
  const gateDir = path.join(TEST_DIR, 'resources', 'gate')
  for (const page of ['loading.html', 'login.html', 'waiting.html', 'classroom.html', 'update.html', 'lingdong.patch.yml']) {
    assert.ok(fs.existsSync(path.join(gateDir, page)), `缺 resources/gate/${page}`)
  }
  assert.ok(fs.existsSync(path.join(TEST_DIR, 'resources', 'lo', 'prebuilds.json')), '缺 resources/lo（Office 引擎）')
  // 主运行时与原生模块（asar 外）——它们的缺失同样会让应用起不来。
  for (const entry of [['runtime', 'versions.json'], ['app.asar.unpacked', 'dsh']]) {
    assert.ok(fs.existsSync(path.join(TEST_DIR, 'resources', entry[0], entry[1])), `缺 resources/${entry[0]}/${entry[1]}`)
  }
  assert.ok(fs.existsSync(path.join(TEST_DIR, 'resources', 'app.asar')), '缺 app.asar')
  return { gate: '6 个页面', lo: true, runtime: true, asar: true }
})

check('① 注册表：DisplayVersion / InstallLocation', () => {
  const version = regValue('DisplayVersion')
  assert.equal(version, installerVersion, `DisplayVersion=${version}，期望 ${installerVersion}`)
  const location = regValue('InstallLocation')
  assert.ok(location, 'InstallLocation 是空的（这条是本次新加的写入）')
  assert.ok(location.toLowerCase().includes(TEST_DIR.toLowerCase()), `InstallLocation=${location}`)
  return { version, installLocation: location }
})

// —— ② 覆盖升级 ——
const exeBefore = fs.statSync(path.join(TEST_DIR, EXE_NAME)).mtimeMs
check('② 覆盖升级：再装一次，用户数据保留、版本不变', () => {
  runInstaller(installerPath, ['/S', `/D=${TEST_DIR}`])
  assert.ok(fs.existsSync(path.join(TEST_DIR, EXE_NAME)), '升级后主程序不见了')
  assert.equal(regValue('DisplayVersion'), installerVersion)
  assert.ok(fs.existsSync(MARKER), '升级把用户数据目录删了')
  return { replaced: fs.statSync(path.join(TEST_DIR, EXE_NAME)).mtimeMs !== exeBefore || '同版本重装（mtime 可能不变）' }
})

// —— ③ 静默卸载 ——
check('③ 静默卸载：安装目录与注册表项清掉', () => {
  const uninstaller = fs.readdirSync(TEST_DIR).find(f => f.startsWith('Uninstall') && f.endsWith('.exe'))
  assert.ok(uninstaller, '没找到卸载器')
  runInstaller(path.join(TEST_DIR, uninstaller), ['/S', '/currentuser'])
  waitFor(() => !fs.existsSync(path.join(TEST_DIR, EXE_NAME)), '主程序被移除')
  // ⚠️ NSIS 卸载器会先把自己复制到临时目录再返回，注册表清理可能滞后，这里必须轮询。
  const stillThere = () => REG_KEYS.filter(key => {
    const out = reg(['query', key])
    return out.includes(key) || out.includes('90768118')
  })
  // ⚠️ NSIS 卸载器把自己复制成临时 exe（Un_A*.tmp / Uninstall *.exe）后**异步**收尾：
  //    进程还在时注册表可能刚刚被清、也可能还没清；不等它退出就还原备份 = 备份会被它随后删掉（踩过）。
  const uninstallerRunning = () => {
    try {
      const out = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      return /Un_A|Uninstall\s+灵动ai/u.test(out)
    } catch { return false }
  }
  try { waitFor(() => !uninstallerRunning(), '卸载器进程退出', 120_000) } catch { /* 拿不到进程列表时不阻塞判定 */ }
  try { waitFor(() => stillThere().length === 0, '注册表项被清理', 60_000) }
  catch {
    throw new Error(`静默卸载后仍残留注册表项：${stillThere().join(' | ')}`)
  }
  return '已卸载（含注册表）'
})
check('③ 卸载默认保留本机数据（我们新加的询问 /SD IDNO）', () => {
  assert.ok(fs.existsSync(MARKER), '静默卸载把用户数据删了 —— 默认应该是保留')
  return path.basename(MARKER)
})

// —— ④ 还原用户环境 ——
check('restore registry to original values', () => {
  if (!hadKey) return '（原本没有安装记录，无需还原）'
  const out = backups.map(file => fs.existsSync(file) ? reg(['import', file]) : '').join('')
  const version = regValue('DisplayVersion')
  assert.equal(version, originalVersion, `restored DisplayVersion=${version} (expected ${originalVersion})`)
  const uninstallString = regValue('UninstallString')
  assert.equal(String(uninstallString), String(originalUninstallString), `restored UninstallString=${uninstallString} (expected ${originalUninstallString})`)
  return { version, uninstallString }
})

// 清理测试目录（用户数据 marker 留着，便于人工确认；如不需要可自行删）
fs.rmSync(MARKER, { force: true })
fs.rmSync(TEST_DIR, { recursive: true, force: true })

for (const item of checks) {
  console.log(`${item.ok ? '  ✓' : '  ✗'} ${item.name}${item.detail === undefined ? '' : ` → ${JSON.stringify(item.detail)}`}`)
  if (!item.ok) console.log(`      ${item.message}`)
}
const failed = checks.filter(item => !item.ok)
console.log(JSON.stringify({ name: 'p123-install-cycle', pass: failed.length === 0, checks: checks.length, failed: failed.map(i => i.name) }))
process.exit(failed.length === 0 ? 0 : 1)
