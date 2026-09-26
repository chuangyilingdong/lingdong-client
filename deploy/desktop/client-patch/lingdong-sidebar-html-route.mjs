/**
 * 让侧栏插件的 HTML 预览能读到页面自己的相对文件（2026-09-26，rc.2.4）。
 *
 * 症状（学生截图）：侧栏「index.html」预览只剩一坨没有样式的 HTML —— 链接是浏览器
 * 默认的蓝紫色下划线、`<ul>` 带圆点、导航与首屏挤成一列；同一个文件在系统浏览器里
 * 完全正常。
 *
 * 根因：`dsh-better-sidebar` 的 `/sidebar/html` 路由复用了自己的信任闸门
 * （bundle 内 `src/trust-fence.ts` 的 `isTrustedApiRequest`）。闸门拒绝
 * `sec-fetch-site: cross-site` 与 `origin: null` —— 这正是该插件自己把页面放进
 * `sandbox`（不透明源）iframe 之后，Chromium 给页面相对资源（styles.css、app.js、
 * 图片）打的标记（Chromium 实测：`/style.css` 与 `/script.js` 都是
 * `sec-fetch-site: cross-site`）。于是页面本体能显示，它的 CSS/JS 全部 403，预览
 * 必然是无样式的一坨。
 *
 * 修法：只对「同一个预览路由的静态子资源」这一类请求放行 —— 去掉沙箱必然带来的标记
 * 之后，Host / Origin 判定仍旧交给插件原来的闸门复核；路由自己的 workspace 边界、
 * 大小上限、GET 限制与 CSP 全都不动，预览 iframe 仍是不透明源沙箱。
 *
 * @param pluginProfileDir - 已装好预装插件闭包的 `plugin-profile` 目录。
 */
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 补丁特征串：bundle 里出现过就说明这条补丁已经打过。 */
const MARKER = 'LINGDONG_SIDEBAR_PREVIEW_FENCE'

/** 预览页合法子资源请求的 `sec-fetch-dest`（顶层导航 document/iframe 不在此列）。 */
const ASSET_DESTINATIONS = ['audio', 'font', 'image', 'manifest', 'media', 'script', 'style', 'track', 'video']

/**
 * 写回打好补丁的 bundle。
 *
 * pnpm 默认把 node_modules 里的文件硬链到全机 store（实测 nlink=3），直接
 * writeFileSync 会把补丁写进 store里那份——污染别的项目、也让 pnpm 把它当成损坏的
 * 缓存。所以先写临时文件，再 unlink + rename 换一个全新 inode。
 * @param file - 要覆盖的文件。
 * @param text - 新内容。
 */
function replaceFile(file, text) {
  const temporary = `${file}.lingdong-tmp`
  writeFileSync(temporary, text, 'utf8')
  try {
    unlinkSync(file)
  } catch {
    // Windows 对只读文件：先去掉只读位再试一次。
    try { chmodSync(file, 0o666) } catch { /* 已经可写就好 */ }
    unlinkSync(file)
  }
  renameSync(temporary, file)
}

/** 注入到 `const fence = ...` 之后的辅助函数：只认「预览路由的静态子资源」这一种形状。 */
function helperSource() {
  return [
    '',
    '\t// LINGDONG_SIDEBAR_PREVIEW_FENCE：沙箱预览 iframe 读自己的相对资源（styles.css / app.js / 图片）时，',
    '\t// Chromium 会把它标成 sec-fetch-site: cross-site（不透明源），插件复用的信任闸门因此 403，',
    '\t// 预览就只剩没有样式的 HTML。这里只放行「同一个预览路由的静态子资源」：去掉沙箱必然带来的',
    '\t// 标记后，Host / Origin 判定仍旧交给原闸门复核，路由自己的边界与 CSP 不变。',
    `\tconst LINGDONG_PREVIEW_ASSET_DESTINATIONS = new Set(${JSON.stringify(ASSET_DESTINATIONS)});`,
    '\tconst lingdongPreviewAssetRequest = (req) => {',
    '\t\tconst headers = req.headers ?? {};',
    '\t\tif (headers["sec-fetch-site"] !== "cross-site") return false;',
    '\t\tconst destination = headers["sec-fetch-dest"];',
    '\t\tif (typeof destination !== "string" || !LINGDONG_PREVIEW_ASSET_DESTINATIONS.has(destination)) return false;',
    '\t\tconst rest = { ...headers };',
    '\t\tdelete rest["sec-fetch-site"];',
    '\t\tif (rest.origin === "null") delete rest.origin;',
    '\t\treturn fence({ ...req, headers: rest });',
    '\t};',
    '',
  ].join('\n')
}

/**
 * Patch the installed sidebar bundle so a sandboxed preview may load its own assets.
 * @param pluginProfileDir - directory holding `node_modules/dsh-better-sidebar`.
 */
export function patchLingdongSidebarHtmlRoute(pluginProfileDir) {
  const file = join(pluginProfileDir, 'node_modules', 'dsh-better-sidebar', 'lib', 'index.js')
  if (!existsSync(file)) throw new Error(`lingdong sidebar html route: 找不到预装插件 ${file}`)

  const before = readFileSync(file, 'utf8')
  if (before.includes(MARKER)) return

  const fenceAnchor = '\tconst fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);\n'
  if (!before.includes(fenceAnchor)) {
    throw new Error('lingdong sidebar html route: 信任闸门锚点漂了（dsh-better-sidebar 换版了？）')
  }
  const withHelper = before.replace(fenceAnchor, fenceAnchor + helperSource())

  const routeIndex = withHelper.indexOf('path: "/sidebar/html"')
  if (routeIndex < 0) throw new Error('lingdong sidebar html route: 找不到 /sidebar/html 路由')
  const check = 'if (!fence(req)) {'
  const checkIndex = withHelper.indexOf(check, routeIndex)
  if (checkIndex < 0) throw new Error('lingdong sidebar html route: /sidebar/html 里找不到闸门调用')

  const replacement = 'if (!fence(req) && !lingdongPreviewAssetRequest(req)) {'
  replaceFile(file, withHelper.slice(0, checkIndex) + replacement + withHelper.slice(checkIndex + check.length))
}
