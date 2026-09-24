/** Verify the pinned checkout still carries every client patch before packaging. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.argv[2] || join(root, 'upstream', 'dsh-harness'))
const read = (path) => readFileSync(join(checkout, path), 'utf8')
const same = (left, right) => readFileSync(left).equals(readFileSync(right))

const copies = [
  ['deploy/desktop/client-patch/platform-gate.ts', 'apps/desktop/src/platform-gate.ts'],
  ['deploy/desktop/client-patch/LingdongUpdater.ts', 'apps/desktop/src/LingdongUpdater.ts'],
  ['deploy/desktop/client-patch/LingdongClassroomWorkspace.ts', 'packages/client/ui-workspace/src/client/LingdongClassroomWorkspace.ts'],
  ['deploy/desktop/client-patch/LingdongWorkPanel.tsx', 'packages/client/ui-workspace/src/client/LingdongWorkPanel.tsx'],
  ['deploy/desktop/client-patch/HtmlPreviewBytes.ts', 'packages/client/ui-sidebar-documentpreview/src/client/html/bytes.ts'],
  ['deploy/desktop/client-patch/HtmlPreviewBootstrap.ts', 'packages/client/ui-sidebar-documentpreview/src/client/html/bootstrap.ts'],
  ['deploy/desktop/client-patch/HtmlPreviewPack.ts', 'packages/client/ui-sidebar-documentpreview/src/client/html/pack.ts'],
  ['deploy/desktop/client-patch/OfficePreview.ts', 'packages/client/ui-sidebar-documentpreview/src/client/office/index.ts'],
  ['deploy/desktop/client-patch/Deliverables.tsx', 'packages/client/ui-deliverables/src/client/Deliverables.tsx'],
  ['deploy/desktop/client-patch/LingdongSendQuota.tsx', 'packages/client/ui-conversation/src/client/LingdongSendQuota.tsx'],
  ['deploy/desktop/client-patch/lingdong-send-state.ts', 'packages/client/ui-conversation/src/client/lingdong-send-state.ts'],
]
for (const [source, target] of copies) {
  assert.equal(existsSync(join(root, source)), true, `missing patch source ${source}`)
  assert.equal(existsSync(join(checkout, target)), true, `missing checkout target ${target}`)
  assert.equal(same(join(root, source), join(checkout, target)), true, `patch drift: ${target}`)
}

// ⚠️ 2026-09-24 踩过：patch() 的默认「已打过」标记取自替换文本开头，而这条补丁的第一行就是锚点本身，
//    于是被误判成「已打过」整个跳过 —— 打出来的包缺 resources/gate/，学生一启动就 ERR_FILE_NOT_FOUND。
//    除了修 patch()，这里再钉一道：构建前必须能在打包配置里看到 gate 条目，且页面文件都在。
const gateConfig = read('apps/desktop/scripts/electron-builder-config.mjs')
assert.equal(gateConfig.includes("'../resources/gate'"), true,
  'gate/ 没进 extraResources（打包配置里找不到 ../resources/gate）')
for (const page of ['login.html', 'loading.html', 'waiting.html', 'classroom.html', 'update.html', 'lingdong.patch.yml']) {
  assert.equal(existsSync(join(checkout, 'apps/desktop/resources/gate', page)), true, `缺少登录门页面 ${page}`)
}

const expectations = [
  ['apps/desktop/src/preload-app.ts', 'scanWorkFiles'],
  ['apps/desktop/src/platform-gate.ts', 'function renderGatewayPatch('],
  ['apps/desktop/src/platform-gate.ts', 'window.show()'],
  ['packages/client/ui-model-selection/src/client/directory.ts', 'LINGDONG_PLATFORM_MODEL_MIGRATION'],
  ['apps/desktop/src/platform-gate.ts', 'LINGDONG_DEFAULT_MODEL_MARKER'],
  ['apps/desktop/resources/gate/lingdong.patch.yml', '# LINGDONG_MODELS_BEGIN'],
  ['apps/desktop/resources/gate/lingdong.patch.yml', '# LINGDONG_MODELS_END'],
  ['apps/desktop/resources/gate/lingdong.patch.yml', 'model: deepseek-flash # LINGDONG_DEFAULT_MODEL'],
  ['apps/desktop/resources/gate/lingdong.patch.yml', "id: session-telemetry-otel, name: '@deepseek-ai/dsh-session-telemetry-otel', disabled: true"],
  ['apps/desktop/scripts/electron-builder-config.mjs', 'resolvedClientVersion'],
  ['apps/desktop/installer/uninstall.nsh', 'LINGDONG_CLEAN_OPT_IN'],
  ['packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx', 'classroomWorkspacePath'],
  ['packages/client/ui-conversation/src/client/skeleton/InputBar.tsx', 'lingdongExhausted'],
  ['packages/client/ui-conversation/src/client/input/facade.ts', 'LINGDONG_SEND_LIMIT_GUARD'],
  ['packages/todo/tool-todo/src/index.ts', 'LINGDONG_TODO_CLOSE'],
  ['apps/desktop/src/project-manager.ts', 'function enablePreinstalledPlugins('],
  ['apps/desktop/src/project-manager.ts', 'materializePreinstalledPlugins(this.paths.profile, this.runtime.plugins)'],
  ['apps/desktop/src/project-manager.ts', '@yuxianglin/dsh-bridge-browser'],
  ['apps/desktop/scripts/prepare-dsh.ts', 'LINGDONG_VENDOR_PLUGINS'],
  ['apps/desktop/scripts/prepare-dsh.ts', 'LINGDONG_PLUGIN_PROFILE'],
  ['apps/desktop/src/main.ts', 'LINGDONG_PLUGIN_RESOURCE'],
  ['packages/client/ui-conversation/src/client/lingdong-send-state.ts', 'lingdongSendLimitReached'],
]
for (const [path, marker] of expectations) {
  assert.equal(read(path).includes(marker), true, `missing marker ${marker} in ${path}`)
}

// 预装插件的 tarball 必须随检出（dsh-browser 没发布到 npm，只能随包）。
for (const file of ['yuxianglin-dsh-bridge-browser-0.0.5.tgz']) {
  assert.equal(existsSync(join(checkout, 'apps/desktop/vendor-plugins', file)), true, 'missing packaged plugin ' + file)
}

console.log(JSON.stringify({ name: 'verify-upstream-patches', pass: true, checkout }))
