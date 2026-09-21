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
  check('确认后静默安装并重启', () => {
    assert.match(updater, /\/S --updated/)
    assert.match(updater, /currentExecutable/)
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
    assert.match(publish, /jq --arg version/)
    assert.match(publish, /has\("enabled"\)/)
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

  console.log(JSON.stringify({ name: 'p121-client-update', pass: true, checks: checks.length }))
} catch (error) {
  console.error(error)
  process.exitCode = 1
}