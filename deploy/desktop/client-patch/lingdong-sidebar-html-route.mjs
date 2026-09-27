/**
 * 让侧栏插件的 HTML 预览**像真浏览器**一样跑页面（2026-09-27 起，rc.2.5 补齐）。
 *
 * 症状（学生截图）：侧栏「index.html」预览只剩一坨没有样式的 HTML —— 链接是浏览器
 * 默认的蓝紫色下划线、`<ul>` 带圆点、导航与首屏挤成一列；同一个文件在系统浏览器里
 * 完全正常。
 *
 * 根因：`dsh-better-sidebar` 的 `/sidebar/html` 路由复用了自己的信任闸门
 * （bundle 内 `src/trust-fence.ts` 的 `isTrustedApiRequest`）。闸门拒绝
 * `sec-fetch-site: cross-site` 与 `origin: null` —— 这正是该插件自己把页面放进
 * `sandbox`（不透明源）iframe 之后，Chromium 给页面相对资源（styles.css、app.js、
 * 图片、fetch 取数）打的标记（Chromium 实测：`/style.css`、`/script.js` 都是
 * `sec-fetch-site: cross-site`）。于是页面本体能显示，它的 CSS/JS 全部 403。
 *
 * 这条补丁做三件事，都只针对「同一个预览路由」：
 *   ① 闸门：放行预览页自己的静态子资源与 fetch/XHR（dest=empty）GET —— 去掉沙箱
 *      必然带来的标记后，Host / Origin 判定仍旧交给插件原来的闸门复核；
 *   ② CORS：fetch 是不透明源的跨源请求，即使 200 浏览器也不让页面读内容，
 *      所以给这类请求补 `access-control-allow-origin: *`；
 *   ③ Storage：不透明源里 `window.localStorage` 一读就抛 SecurityError。DSH 自带的
 *      文档预览为此装了内存 Storage 兜底，插件这条路由没有 —— 学生页面里没写 try/catch
 *      的 `localStorage.getItem(...)` 会让整段 JS 挂掉（真机浏览器里却正常）。这里给
 *      HTML 响应注入同一套内存 Storage 兜底脚本。
 *
 * 路由自己的 workspace 边界、大小上限、GET 限制与 CSP 沙箱全都保持原样。
 *
 * @param pluginProfileDir - 已装好预装插件闭包的 `plugin-profile` 目录。
 */
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 补丁特征串：bundle 里出现过就说明这条补丁已经打过。 */
const MARKER = 'LINGDONG_SIDEBAR_PREVIEW_FENCE'

/** 预览页合法子资源请求的 `sec-fetch-dest`（顶层导航 document/iframe 不在此列）。 */
const ASSET_DESTINATIONS = ['audio', 'empty', 'font', 'image', 'manifest', 'media', 'script', 'style', 'track', 'video']

/** 注入到 HTML 响应 <head> 开头的内存 Storage 兜底（与 DSH 自带的预览同源同义）。 */
const STORAGE_SHIM_TAG =
  '<script data-lingdong-preview-storage>(function(){try{void window.localStorage;void window.sessionStorage;return}catch(e){}'
  + 'var make=function(){var m=new Map();return{get length(){return m.size},clear:function(){m.clear()},'
  + 'getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},key:function(i){var a=Array.from(m.keys());return i in a?a[i]:null},'
  + 'removeItem:function(k){m.delete(String(k))},setItem:function(k,v){m.set(String(k),String(v))}}};'
  + 'var names=["localStorage","sessionStorage"];for(var i=0;i<names.length;i++){'
  + 'try{Object.defineProperty(window,names[i],{value:make(),configurable:true})}catch(e2){}}})()</script>'

/** 注入到 `const fence = ...` 之后的辅助函数：只认「预览路由的静态子资源 / 取数请求」这一种形状。 */
function helperSource() {
  return [
    '',
    '\t// LINGDONG_SIDEBAR_PREVIEW_FENCE：沙箱预览 iframe 读自己的相对资源（styles.css / app.js / 图片）',
    '\t// 或 fetch 自己的同目录数据时，Chromium 会把它标成 sec-fetch-site: cross-site（不透明源），',
    '\t// 插件复用的信任闸门因此 403，预览就只剩没有样式的 HTML。这里只放行「同一个预览路由的这类请求」：',
    '\t// 去掉沙箱必然带来的标记后，Host / Origin 判定仍旧交给原闸门复核，路由自己的边界与 CSP 不变。',
    `\tconst LINGDONG_PREVIEW_ASSET_DESTINATIONS = new Set(${JSON.stringify(ASSET_DESTINATIONS)});`,
    `\tconst LINGDONG_PREVIEW_STORAGE_TAG = ${JSON.stringify(STORAGE_SHIM_TAG)};`,
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
    '\t// fetch/XHR 是不透明源的跨源请求：闸门放行还不够，必须补 ACAO 浏览器才让页面读到内容。',
    '\tconst lingdongPreviewCorsHeaders = (req) => {',
    '\t\tif ((req.headers ?? {})["sec-fetch-dest"] !== "empty" || !lingdongPreviewAssetRequest(req)) return {};',
    '\t\treturn { "access-control-allow-origin": "*", "vary": "origin" };',
    '\t};',
    '\t// 不透明源里 window.localStorage 一读就抛：给 HTML 注入内存 Storage 兜底，别再让页面 JS 挂掉。',
    '\tconst lingdongPreviewBody = (type, body) => {',
    '\t\tif (typeof type !== "string" || type.indexOf("text/html") !== 0 || body === null || body === undefined) return body;',
    '\t\tconst buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));',
    '\t\tconst html = buffer.toString("utf8");',
    '\t\tif (html.indexOf("data-lingdong-preview-storage") >= 0) return buffer;',
    '\t\tconst head = /<head[^>]*>/iu.exec(html);',
    '\t\tlet next;',
    '\t\tif (head !== null) {',
    '\t\t\tnext = html.slice(0, head.index + head[0].length) + LINGDONG_PREVIEW_STORAGE_TAG + html.slice(head.index + head[0].length);',
    '\t\t} else {',
    '\t\t\tconst doctype = /<!doctype[^>]*>/iu.exec(html);',
    '\t\t\tconst skip = doctype === null ? 0 : doctype.index + doctype[0].length;',
    '\t\t\tnext = html.slice(0, skip) + "<head>" + LINGDONG_PREVIEW_STORAGE_TAG + "</head>" + html.slice(skip);',
    '\t\t}',
    '\t\treturn Buffer.from(next, "utf8");',
    '\t};',
    '',
  ].join('\n')
}

/**
 * Patch the installed sidebar bundle so a sandboxed preview may load its own assets and storage.
 * @param pluginProfileDir - directory holding `node_modules/dsh-better-sidebar`.
 */
export function patchLingdongSidebarHtmlRoute(pluginProfileDir) {
  const file = join(pluginProfileDir, 'node_modules', 'dsh-better-sidebar', 'lib', 'index.js')
  if (!existsSync(file)) throw new Error(`lingdong sidebar html route: 找不到预装插件 ${file}`)

  const before = readFileSync(file, 'utf8')
  if (before.includes(MARKER) && before.includes('lingdongPreviewBody')) return
  if (before.includes(MARKER)) {
    throw new Error('lingdong sidebar html route: 发现旧版补丁残留（只有闸门、没有 Storage/fetch 兜底），先清掉插件闭包再打包')
  }

  const fenceAnchor = '\tconst fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);\n'
  if (!before.includes(fenceAnchor)) {
    throw new Error('lingdong sidebar html route: 信任闸门锚点漂了（dsh-better-sidebar 换版了？）')
  }
  let text = before.replace(fenceAnchor, fenceAnchor + helperSource())

  const routeIndex = text.indexOf('path: "/sidebar/html"')
  if (routeIndex < 0) throw new Error('lingdong sidebar html route: 找不到 /sidebar/html 路由')

  const check = 'if (!fence(req)) {'
  const checkIndex = text.indexOf(check, routeIndex)
  if (checkIndex < 0) throw new Error('lingdong sidebar html route: /sidebar/html 里找不到闸门调用')
  const checkReplacement = 'if (!fence(req) && !lingdongPreviewAssetRequest(req)) {'
  text = text.slice(0, checkIndex) + checkReplacement + text.slice(checkIndex + check.length)

  const write = 'res.writeHead(200, {'
  const writeIndex = text.indexOf(write, routeIndex)
  if (writeIndex < 0) throw new Error('lingdong sidebar html route: /sidebar/html 里找不到 200 响应头')
  const writeReplacement = 'res.writeHead(200, { ...lingdongPreviewCorsHeaders(req),'
  text = text.slice(0, writeIndex) + writeReplacement + text.slice(writeIndex + write.length)

  const end = 'res.end(body);'
  const endIndex = text.indexOf(end, routeIndex)
  if (endIndex < 0) throw new Error('lingdong sidebar html route: /sidebar/html 里找不到 res.end(body)')
  const endReplacement = 'res.end(lingdongPreviewBody(type, body));'
  text = text.slice(0, endIndex) + endReplacement + text.slice(endIndex + end.length)

  replaceFile(file, text)
}

/**
 * 写回打好补丁的 bundle。
 *
 * pnpm 默认把 node_modules 里的文件硬链到全机 store（实测 nlink=3），直接 writeFileSync 会把
 * 补丁写进 store 里那份 —— 污染别的项目、也让 pnpm 把它当成损坏的缓存。所以先写临时文件，
 * 再 unlink + rename 换一个全新 inode。
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
