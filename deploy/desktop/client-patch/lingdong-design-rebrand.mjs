/**
 * 灵动ai：把 `deepseek-idesign` / `deepseek-ippt` 的品牌换成灵动ai（2026-09-27，rc.2.6）。
 *
 * 这两个插件是 iPolloWork 的 DeepSeek Design 套件（原许可证要求保留 iPolloWork 署名）。
 * 项目方确认这是自家项目、署名改成灵动ai，所以打包时统一替换**用户可见的文案与图形**：
 *
 *   · 文案：`iPolloWork` → `灵动ai`、`DeepSeek iDesign` → `灵动ai 设计`、
 *     `DeepSeek iPPT` → `灵动ai PPT`、`DeepSeek Harness` → `灵动ai`；
 *   · 视图标签：`Design` → `设计`（PPT 保持 PPT，学生一眼能认）；
 *   · 模板里的品牌图 `assets/ipollowork-logo.svg` 换成灵动ai 的标记（文件名不动，模板引用不变）。
 *
 * 只改**显示层**：小写标识符（路由 `/ipollowork-design`、频道名 `ipollowork-design-studio-host-v1`、
 * 模板 id `ipollowork.*`、`--ipw-*` CSS 变量、`data-ipw-*` 属性）与代码标识符
 * （`iPolloWorkState` / `iPolloWorkRead` 之类）一律不动 —— 负向先行断言保证只替换独立的品牌词。
 * 许可证正文（LICENSE*）与 README 原文也不动。
 *
 * @param pluginProfileDir - 已装好预装插件闭包的 `plugin-profile` 目录。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

/** 补丁特征串：模板 logo 里出现就说明这条补丁已经打过。 */
const LOGO_MARKER = 'data-lingdong-brand-logo'

/** 要改的插件包（视频插件不预装，也就不在这条补丁里）。 */
const PACKAGES = ['deepseek-idesign', 'deepseek-ippt']

/** 需要做文案替换的目录（相对包根）。 */
const AREAS = ['lib', 'studio/dist']

/** 需要处理的文本扩展名。 */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.htm', '.css', '.svg', '.txt', '.yml', '.yaml', '.map'])

/** 许可证与说明原文不动（`package.json` 里有插件名/版本，也不动）。 */
const SKIP_FILE = /(^|\/)(LICENSE[^/]*|README[^/]*|package\.json)$/iu

/** 独立的品牌词 → 灵动ai；带 `(?![A-Za-z0-9_$])` 的只替换「词」不替换标识符。 */
const REPLACEMENTS = [
  [/iPolloWork DeepSeek iDesign/gu, '灵动ai 设计'],
  [/iPolloWork DeepSeek iPPT/gu, '灵动ai PPT'],
  [/DeepSeek iDesign/gu, '灵动ai 设计'],
  [/DeepSeek iPPT/gu, '灵动ai PPT'],
  [/DeepSeek Harness/gu, '灵动ai'],
  [/iPolloWork(?![A-Za-z0-9_$])/gu, '灵动ai'],
]

/** 视图标签：Design → 设计（只改视图注册那一处）。 */
const LABEL_REPLACEMENTS = [
  [/label: "Design"/gu, 'label: "设计"'],
  [/label:"Design"/gu, 'label:"设计"'],
]

/** 灵动ai 品牌标记（模板里 21 个 entry.html 引用同一个文件名，内容整体替换）。 */
const LOGO_SVG = [
  '<svg data-lingdong-brand-logo xmlns="http://www.w3.org/2000/svg" width="281" height="298" viewBox="0 0 281 298" role="img" aria-label="灵动ai">',
  '  <defs><linearGradient id="lingdong-brand" x1="0" y1="0" x2="1" y2="1">',
  '    <stop offset="0" stop-color="#5B7CFA"/><stop offset="1" stop-color="#38BDF8"/>',
  '  </linearGradient></defs>',
  '  <rect x="16" y="20" width="249" height="258" rx="68" fill="url(#lingdong-brand)"/>',
  '  <text x="140" y="206" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="152" font-weight="700" fill="#ffffff">灵</text>',
  '</svg>',
  '',
].join('\n')

/**
 * Rebrand the installed design/ppt plugins for Lingdong.
 * @param pluginProfileDir - directory holding `node_modules/<plugin>`.
 */
export function patchLingdongDesignBranding(pluginProfileDir) {
  let touched = 0
  for (const name of PACKAGES) {
    const root = join(pluginProfileDir, 'node_modules', name)
    if (!existsSync(root)) throw new Error(`lingdong design rebrand: 找不到预装插件 ${root}`)
    for (const area of AREAS) {
      const directory = join(root, area)
      if (!existsSync(directory)) continue
      for (const file of walk(directory)) {
        const path = relative(root, file).replaceAll('\\', '/')
        if (SKIP_FILE.test(path)) continue
        const extension = extname(file).toLocaleLowerCase('en-US')
        if (!TEXT_EXTENSIONS.has(extension)) continue
        if (extension === '.svg' && file.endsWith('ipollowork-logo.svg')) {
          if (!readFileSync(file, 'utf8').includes(LOGO_MARKER)) {
            replaceFile(file, LOGO_SVG)
            touched += 1
          }
          continue
        }
        const before = readFileSync(file, 'utf8')
        let next = before
        for (const [pattern, value] of REPLACEMENTS) next = next.replace(pattern, value)
        if (extension === '.js' && path.endsWith('client.js')) {
          for (const [pattern, value] of LABEL_REPLACEMENTS) next = next.replace(pattern, value)
        }
        if (next !== before) {
          replaceFile(file, next)
          touched += 1
        }
      }
    }
  }
}

/** 递归列出目录里的文件。 */
function walk(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walk(child))
    else if (entry.isFile() && statSync(child).isFile()) found.push(child)
  }
  return found
}

/**
 * 写回文件。pnpm 把 node_modules 里的文件硬链到全机 store（实测 nlink>1），直接写会污染 store，
 * 所以先写临时文件、再 unlink + rename 换一个新 inode。
 * @param file - 要覆盖的文件。
 * @param text - 新内容。
 */
function replaceFile(file, text) {
  const temporary = `${file}.lingdong-tmp`
  writeFileSync(temporary, text, 'utf8')
  try {
    unlinkSync(file)
  } catch {
    try { chmodSync(file, 0o666) } catch { /* 已经可写就好 */ }
    unlinkSync(file)
  }
  renameSync(temporary, file)
}
