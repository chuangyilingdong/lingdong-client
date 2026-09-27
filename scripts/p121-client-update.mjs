/**
 * 客户端启动更新守卫（静态钉口径）。
 * 不启动 Electron；只验证更新清单、SHA256、静默安装和打包接入没有被误删。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(join(root, path), 'utf8')
const checks = []
const check = (name, fn) => { fn(); checks.push(name); console.log(`✓ ${name}`) }

try {
  const updater = read('deploy/desktop/client-patch/LingdongUpdater.ts')
  const apply = read('deploy/desktop/apply-client-gate.mjs')
  const publish = read('deploy/desktop/publish-client.sh')
  const contract = read('docs/平台接口契约.md')

  check('启动检查平台下载清单', () => {
    assert.match(updater, /\/downloads\/manifest\.json/)
    assert.match(updater, /gt\(latest, current\)/)
  })
  check('下载后校验大小与 SHA256', () => {
    assert.match(updater, /createHash\('sha256'\)/)
    assert.match(updater, /received !== expectedSize/)
    assert.match(updater, /actualHash !== expectedHash/)
  })
  check('确认后 Windows 静默安装、macOS 打开 DMG 安装', () => {
    assert.match(updater, /\/S --updated/)
    assert.match(updater, /currentExecutable/)
    assert.match(updater, /darwin' && process\.arch === 'arm64'/)
    assert.match(updater, /spawn\('\/usr\/bin\/open'/)
    assert.match(updater, /app\.quit\(\)/)
    assert.match(apply, /runLingdongUpdater/)
  })
  check('发布清单含后台可配置策略字段', () => {
    for (const key of ['enabled', 'mandatory', 'minVersion', 'publishedAt', 'note']) assert.match(publish, new RegExp(key))
    assert.match(contract, /客户端启动时/)
  })
  check('LibreOffice 引擎整包解包，配置不留在 asar', () => {
    assert.match(apply, /libreoffice-kit-\*\/\*\*\/\*/)
  })
  check('LibreOffice 使用 resources/lo 短路径避免 Windows 长路径限制', () => {
    assert.match(apply, /LINGDONG_LIBREOFFICE_ENGINE_DIR/)
    assert.match(apply, /patchLingdongOfficeEngine/)
    assert.match(apply, /to: 'lo'/)
    assert.match(read('deploy/desktop/client-patch/lingdong-office-engine.mjs'), /LINGDONG_LIBREOFFICE_ENGINE_DIR/)
  })
  check('发布会合并 manifest，不覆盖后台策略', () => {
    assert.match(publish, /JQ_ARGS/)
    assert.match(publish, /\.enabled = \(if has/)
    assert.doesNotMatch(publish, /cat > manifest.json/)
  })
  check('classroom 为空时清掉缓存 presets/sends，不再回退 gateway', () => {
    const gate = read('deploy/desktop/client-patch/platform-gate.ts')
    assert.match(gate, /const hasClassroom = fresh.classroom !== null/)
    assert.match(gate, /presets: hasClassroom && Array\.isArray\(fresh\.presets\)/)
    assert.match(gate, /sends: hasClassroom \? \(fresh\.sends \?\? null\) : null/)
  })
  check('契约记录课时 delivery_modes 双开口径', () => {
    assert.match(contract, /course_lessons.delivery_modes.*VIBECODING/)
    assert.match(contract, /两种同时声明.*放行/)
  })
  check('更新进度页已随门页资源打包', () => {
    assert.equal(existsSync(join(root, 'deploy/desktop/client-patch/gate/update.html')), true)
    assert.match(read('deploy/desktop/client-patch/gate/update.html'), /__lingdongUpdate/)
  })

  check('更新地址限制为平台 HTTPS 下载域且文件名按平台核对', () => {
    assert.match(updater, /allowedUpdateUrl/)
    assert.match(updater, /url\.origin !== base\.origin/)
    assert.match(updater, /expectedUpdateName/)
    assert.match(updater, /lingdong-client-\$\{version\}-win-x64\.exe/)
    assert.match(updater, /lingdong-client-\$\{version\}-mac-arm64\.dmg/)
  })
  check('安装器失败会写回结果并在下次启动提示', () => {
    assert.match(updater, /LINGDONG_UPDATE_EXIT/)
    assert.match(updater, /reportPreviousUpdateFailure/)
    assert.match(updater, /上次更新失败/)
  })
  check('关闭 DSH 遥测和官方会话日志上传', () => {
    const patch = read('deploy/desktop/client-patch/lingdong.patch.yml')
    assert.match(patch, /session-telemetry-otel.*disabled: true/)
    assert.match(patch, /session-log-deepseek.*disabled: true/)
    assert.match(read('deploy/desktop/client-patch/platform-gate.ts'), /DSH_TELEMETRY_DISABLED = '1'/)
  })
  check('学生端权限预设与产品口径一致，且不再写 agent 可读网关凭据', () => {
    const patch = read('deploy/desktop/client-patch/lingdong.patch.yml')
    const gate = read('deploy/desktop/client-patch/platform-gate.ts')
    assert.match(patch, /defaultPreset: danger-full-access/)
    assert.match(patch, /workspace-write:/)
    assert.match(gate, /function removeGatewayCredential/)
    assert.doesNotMatch(gate, /writeGatewayCredential\(/)
  })
  check('会话按课堂工作区隔离', () => {
    assert.match(apply, /classroomWorkspacePath/)
    assert.match(apply, /samePath\(cwd, classroomWorkspacePath\)/)
  })
  check('作品面板识别工作区文件并区分平台不支持类型', () => {
    const panel = read('deploy/desktop/client-patch/LingdongWorkPanel.tsx')
    assert.match(panel, /scanWorkFiles/)
    assert.match(panel, /SUBMITTABLE_WORK_EXTENSIONS/)
    assert.match(panel, /submittable/)
  })
  check('HTML 预览打包本地图片和媒体资源', () => {
    assert.match(read('deploy/desktop/client-patch/HtmlPreviewPack.ts'), /img\[src\]/)
    assert.match(read('deploy/desktop/client-patch/HtmlPreviewBootstrap.ts'), /image/)
    assert.match(read('deploy/desktop/client-patch/HtmlPreviewBootstrap.ts'), /Content-Security-Policy/)
    assert.match(read('deploy/desktop/client-patch/HtmlPreviewBytes.ts'), /encodeBytes/)
  })

  check('域名与发布机已切到新环境', () => {
    const gate = read('deploy/desktop/client-patch/platform-gate.ts')
    const updater = read('deploy/desktop/client-patch/LingdongUpdater.ts')
    assert.match(gate, /https:\/\/aicyld\.com/)
    assert.match(updater, /https:\/\/aicyld\.com/)
    assert.doesNotMatch(gate, /iicili/)
    assert.doesNotMatch(updater, /iicili/)
    assert.match(publish, /root@8\.134\.80\.184/)
    assert.match(publish, /https:\/\/aicyld\.com\/downloads/)
    assert.doesNotMatch(publish, /39\.106\.183\.200|iicili/)
    assert.match(read('docs/平台接口契约.md'), /https:\/\/aicyld\.com/)
  })

  check('客户端版本独立于 DSH 基线且每次发布可递增', () => {
    const build = read('scripts/build-win.sh')
    const buildMac = read('scripts/build-mac-arm64.sh')
    // 版本号本身每次发版都会变，这里只锁「可覆盖 + 语义化」的形状。
    assert.match(build, /LINGDONG_CLIENT_VERSION:-\d+\.\d+\.\d+/)
    assert.match(buildMac, /LINGDONG_CLIENT_VERSION:-\d+\.\d+\.\d+/)
    assert.match(buildMac, /package:mac:arm64/)
    assert.match(buildMac, /--unsigned/)
    assert.match(apply, /process\.env\.LINGDONG_CLIENT_VERSION\?\.trim\(\) \|\| resolveDesktopBuildVersion/)
    assert.match(build, /LINGDONG_DSH_BASE_VERSION/)
    assert.match(apply, /LINGDONG_DSH_BASE_VERSION/)
    assert.match(apply, /resolvedClientVersion/)
    assert.match(apply, /spawn\(process\.execPath/)
    assert.match(publish, /REMOTE_VERSION.*VERSION/s)
    assert.match(publish, /ALLOW_SAME_VERSION_REPUBLISH/)
  })

  console.log(JSON.stringify({ name: 'p121-client-update', pass: true, checks: checks.length }))
} catch (error) {
  console.error(error)
  process.exitCode = 1
}