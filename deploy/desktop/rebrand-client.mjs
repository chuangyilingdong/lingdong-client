#!/usr/bin/env node
/**
 * 把上游 deepseek-harness 的桌面端检出**改成我们的品牌**（2026-09-19）。
 *
 * 为什么是"构建期打补丁"而不是改上游源码再提交：我们维护的是**一份钉住版本的上游检出**，
 * 品牌只在这一层覆盖 —— 上游升级时重跑这个脚本即可，冲突一眼可见。
 * 与 `deploy/dsh-student/rebrand.mjs`（那份改的是 dsh 的 Web UI）同一套思路。
 *
 * ⚠️ 品牌合规（上游 BRAND_GUIDELINES.zh.md，2026-09-19 读过）：
 *   · MIT 允许再分发与换牌；描述性文字可以写「基于 DeepSeek Harness 构建」；
 *   · 但**项目名里不能用 "DeepSeek Harness" 全称**（是注册商标），建议用缩写 DSH；
 *   · 不得让人误以为有官方背书。所以这里把所有对外可见的名字换成我们的，
 *     并在 About/关于里保留一句"基于 DSH 构建"的如实说明（见 SHOW_ATTRIBUTION）。
 *
 * 用法（在检出根目录跑）：
 *   node <我们的仓库>/deploy/desktop/rebrand-client.mjs --checkout <上游检出目录>
 *   # 只预览不改：追加 --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本脚本所在目录（deploy/desktop）：⑤ 的图标源与 apply-client-gate.mjs 共用 client-patch/。 */
const here = path.dirname(fileURLToPath(import.meta.url));
const brandLogoDataUri = `data:image/png;base64,${fs.readFileSync(path.join(here, 'client-patch', 'gate', 'logo.png')).toString('base64')}`

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] || fallback) : fallback;
}
const dryRun = process.argv.includes('--dry-run');
const checkout = path.resolve(arg('--checkout', '.'));
if (!fs.existsSync(path.join(checkout, 'apps/desktop/package.json'))) {
  throw new Error(`这不像上游检出（缺 apps/desktop/package.json）：${checkout}`);
}

// ── 我们的品牌 ────────────────────────────────────────────────────────────
const BRAND = {
  // 产品名：Windows 程序名 / 安装目录 / 开始菜单 / 卸载项都用它。
  // ⚠️ 不能用 "DeepSeek Harness"（上游商标），也不能暗示官方背书。
  productName: '灵动ai创作客户端',
  // 安装包文件名（Latin，避免中文文件名在某些分发/更新通道上出问题）
  artifactName: 'lingdong-client-${version}-${os}-${arch}.${ext}',
  // 外壳文案里出现的名字（英文界面用这个）
  productNameEn: 'LingdongAI Studio',
  // 如实说明（上游要求：可以说明关系，但不能暗示背书）
  attribution: '基于 DSH（DeepSeek Harness）构建',
};
const LEGACY_NAMES = ['DeepSeek Harness'];

const changes = [];
const edit = (file, transform) => {
  const full = path.join(checkout, file);
  if (!fs.existsSync(full)) { changes.push([file, '缺失，跳过']); return; }
  const before = fs.readFileSync(full, 'utf8');
  const after = transform(before);
  if (after === before) { changes.push([file, '无变化']); return; }
  if (!dryRun) fs.writeFileSync(full, after);
  changes.push([file, `已改（${before.length} → ${after.length} 字节）`]);
};
/** 整份覆盖（用于"上游那份是矢量稿、字符串替换一处也改不到"的文件）。 */
const overwrite = (file, content) => {
  const full = path.join(checkout, file);
  if (!fs.existsSync(full)) { changes.push([file, '缺失，跳过']); return; }
  if (fs.readFileSync(full, 'utf8') === content) { changes.push([file, '已是我们的牌（跳过）']); return; }
  if (!dryRun) fs.writeFileSync(full, content);
  changes.push([file, `整份换掉（${content.length} 字节）`]);
};

// ① 打包身份：productName 与安装包文件名（这两处是硬编码在上游配置里的）
edit('apps/desktop/scripts/electron-builder-config.mjs', (text) => text
  .replace("productName: 'DeepSeek Harness'", `productName: '${BRAND.productName}'`)
  .replace("artifactName: 'deepseek-harness-${version}-${os}-${arch}.${ext}'", `artifactName: '${BRAND.artifactName}'`));

// ② Electron 主进程里的应用名（窗口/协议/单实例标识都读它）
edit('apps/desktop/src/main.ts', (text) => text
  .replace("applicationName: 'DeepSeek Harness'", `applicationName: '${BRAND.productName}'`));

// ③ 外壳文案（菜单、启动失败、更新提示…）：中英文各一份，直接换名字。
//    ⚠️ 只替换**展示名**，不动标识符（如 DSH_* 环境变量、包名）。
edit('apps/desktop/src/locale.ts', (text) => {
  let next = text;
  for (const legacy of LEGACY_NAMES) next = next.split(legacy).join(BRAND.productName);
  return next;
});

// ④ dsh 界面里的品牌串（**在源码里替换**，编译时进 bundle）。
//    与 `deploy/dsh-student/rebrand.mjs` 对 Linux 镜像做的事一样 —— 那一步只服务服务器上的学生环境，
//    客户端里的 dsh 是**另一棵树**（检出源码 → app.asar），所以这里要再来一遍，
//    否则学生打开客户端看到的第一屏还写着 "deepseek HARNESS"。
const UI_BRAND = '灵动ai';
const UI_ROOTS = ['packages', 'apps/desktop/renderer'];
const UI_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|jsx|html|webmanifest|json|css)$/u;
const UI_REPLACEMENTS = [['DeepSeek Harness', UI_BRAND], ['Deepseek Harness', UI_BRAND], ['deepseek harness', UI_BRAND]];
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'coverage', '.desktop-build']);

function walkSource(root, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walkSource(full, out); continue; }
    if (UI_EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

let uiChanged = 0;
let uiScanned = 0;
for (const root of UI_ROOTS) {
  for (const file of walkSource(path.join(checkout, root))) {
    uiScanned += 1;
    let source = '';
    try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!UI_REPLACEMENTS.some(([from]) => source.includes(from))) continue;
    let next = source;
    for (const [from, to] of UI_REPLACEMENTS) next = next.split(from).join(to);
    if (next === source) continue;
    if (!dryRun) fs.writeFileSync(file, next);
    uiChanged += 1;
  }
}
changes.push([`${UI_ROOTS.join(' + ')} 里的 dsh 界面品牌串`, `扫 ${uiScanned} 个文件，命中并替换 ${uiChanged} 个`]);

// ⑤ 应用图标：把 gate/ 里那张 1024×1024 铺到上游的三个图标位。
//    ⚠️ 这一步以前是**手工复制**的（脚本末尾只留了一句提示），实测漏过一次 ——
//       安装包里的图标与登录页/官网不是同一张图，很难发现，所以改成脚本自动铺。
//    `macos` 那份上游本来就与 Windows 同图（历史遗留），这里保持一致。
const iconSource = path.join(here, 'client-patch', 'gate', 'app-icon-1024.png');
for (const name of ['icon-windows.png', 'icon-macos.png', 'icon.png']) {
  const full = path.join(checkout, 'apps/desktop/resources', name);
  if (!fs.existsSync(path.dirname(full))) { changes.push([`resources/${name}`, '目录不存在，跳过']); continue; }
  const before = fs.existsSync(full) ? fs.readFileSync(full) : null;
  const after = fs.readFileSync(iconSource);
  if (before !== null && before.equals(after)) { changes.push([`resources/${name}`, '已是我们的图标（跳过）']); continue; }
  if (!dryRun) fs.writeFileSync(full, after);
  changes.push([`resources/${name}`, `已换成灵动ai图标（${after.length} 字节）`]);
}

// ⑤b 安装器资源：NSIS 的欢迎页图标、字标、卸载器侧栏。
//    上游这五张图原来还写死 DeepSeek 鲸鱼/HARNESS；只换应用图标不够，安装器第一眼仍是上游品牌。
const installerBrandSource = path.join(here, 'assets', 'installer');
for (const name of ['brand.png', 'brand-2x.png', 'brand-dark.png', 'brand-dark-2x.png', 'uninstaller-sidebar.png']) {
  const source = path.join(installerBrandSource, name);
  const target = path.join(checkout, 'apps/desktop/installer/assets', name);
  if (!fs.existsSync(target)) { changes.push([`installer/assets/${name}`, '目录不存在，跳过']); continue; }
  const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const after = fs.readFileSync(source);
  if (before !== null && before.equals(after)) { changes.push([`installer/assets/${name}`, '已是灵动ai图片（跳过）']); continue; }
  if (!dryRun) fs.copyFileSync(source, target);
  changes.push([`installer/assets/${name}`, `已换成灵动ai图片（${after.length} 字节）`]);
}
// ⑤b2 安装器改成参考图的宽版左右分栏：左侧 330×560 品牌面，右侧干净操作区。
overwrite('apps/desktop/installer/theme.nsh', fs.readFileSync(path.join(here, 'client-patch', 'installer-theme.nsh'), 'utf8'));
edit('apps/desktop/scripts/prepare-windows-installer.ps1', (text) =>
  text.replace(
    "$background = if ($asset -like '*dark*') { [Drawing.Color]::FromArgb(21, 21, 23) } else { [Drawing.Color]::White }",
    "$background = [Drawing.Color]::FromArgb(126, 17, 35)"));
edit('apps/desktop/installer/drawing.nsh', (text) => text
  .replace("MulDiv(i 384, i $InstallerDpi, i 96) i.R7", "MulDiv(i 340, i $InstallerDpi, i 96) i.R7")
  .replace("MulDiv(i 34, i $InstallerDpi, i 96) i.R8", "MulDiv(i 42, i $InstallerDpi, i 96) i.R8"));
edit('apps/desktop/installer/pages.nsh', (text) => text
  .replace('!insertmacro InstallerPlace $InstallerDialog 0 0 ${INSTALLER_WINDOW_SIZE} ${INSTALLER_WINDOW_SIZE}',
    '!insertmacro InstallerPlace $InstallerDialog 0 0 ${INSTALLER_WINDOW_WIDTH} ${INSTALLER_WINDOW_HEIGHT}')
  .replace('!insertmacro InstallerPlace $4 0 0 504 48', '!insertmacro InstallerPlace $4 0 0 ${INSTALLER_WINDOW_WIDTH} 48')
  .replace('!insertmacro InstallerPlace $4 504 8 40 32', '!insertmacro InstallerPlace $4 724 8 40 32')
  .replace('!insertmacro InstallerPlace $4 548 8 40 32', '!insertmacro InstallerPlace $4 772 8 40 32')
  .replace('!insertmacro InstallerPlace $4 0 ${INSTALLER_BRAND_Y} ${INSTALLER_WINDOW_SIZE} ${INSTALLER_BRAND_HEIGHT}',
    '!insertmacro InstallerPlace $4 ${INSTALLER_BRAND_X} ${INSTALLER_BRAND_Y} ${INSTALLER_BRAND_WIDTH} ${INSTALLER_BRAND_HEIGHT}')
  .replace('!insertmacro InstallerPlace $InstallerStatus 48 ${INSTALLER_STATUS_Y} 504 ${INSTALLER_STATUS_HEIGHT}',
    '!insertmacro InstallerPlace $InstallerStatus 360 ${INSTALLER_STATUS_Y} 400 ${INSTALLER_STATUS_HEIGHT}')
  .replace('!insertmacro InstallerPlace $InstallerChoose 232 438 136 28', '!insertmacro InstallerPlace $InstallerChoose 455 390 290 42')
  .replace('!insertmacro InstallerPlace $InstallerEditFrame 64 434 384 34', '!insertmacro InstallerPlace $InstallerEditFrame 360 395 340 42')
  .replace("System::Call 'kernel32::MulDiv(i 76, i $InstallerDpi, i 96) i.r0'", "System::Call 'kernel32::MulDiv(i 376, i $InstallerDpi, i 96) i.r0'")
  .replace("System::Call 'kernel32::MulDiv(i 434, i $InstallerDpi, i 96) i.r1'", "System::Call 'kernel32::MulDiv(i 401, i $InstallerDpi, i 96) i.r1'")
  .replace("System::Call 'kernel32::MulDiv(i 360, i $InstallerDpi, i 96) i.r2'", "System::Call 'kernel32::MulDiv(i 316, i $InstallerDpi, i 96) i.r2'")
  .replace("System::Call 'kernel32::MulDiv(i 34, i $InstallerDpi, i 96) i.r3'", "System::Call 'kernel32::MulDiv(i 30, i $InstallerDpi, i 96) i.r3'")
  .replace('!insertmacro InstallerPlace $InstallerBrowse 456 434 80 34', '!insertmacro InstallerPlace $InstallerBrowse 710 395 70 42')
  .replace(/    System::Call 'user32::GetDC\(p \$InstallerLaunch\)[\s\S]*?    System::Call 'user32::MoveWindow\(p \$InstallerLaunch, i r0, i r1, i r2, i r3, i 1\)'/u,
    '    !insertmacro InstallerPlace $InstallerLaunch 470 442 170 32'));
edit('apps/desktop/installer/lifecycle.nsh', (text) => {
  const old = `    System::Call 'kernel32::MulDiv(i 600, i $InstallerDpi, i 96) i.s'
    Pop $InstallerSize
    System::Call 'user32::GetSystemMetrics(i 0) i.r0'
    System::Call 'user32::GetSystemMetrics(i 1) i.r1'
    IntOp $0 $0 - $InstallerSize
    IntOp $0 $0 / 2
    IntOp $1 $1 - $InstallerSize
    IntOp $1 $1 / 2
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i $InstallerSize, i $InstallerSize, i 0x34)'`;
  const current = `    System::Call 'kernel32::MulDiv(i 820, i $InstallerDpi, i 96) i.s'
    Pop $InstallerSize
    System::Call 'kernel32::MulDiv(i 560, i $InstallerDpi, i 96) i.r2'
    System::Call 'user32::GetSystemMetrics(i 0) i.r0'
    System::Call 'user32::GetSystemMetrics(i 1) i.r1'
    IntOp $0 $0 - $InstallerSize
    IntOp $0 $0 / 2
    IntOp $1 $1 - $2
    IntOp $1 $1 / 2
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i $InstallerSize, i r2, i 0x34)'`;
  return text.includes(current) ? text : text.replace(old, current);
});
edit('apps/desktop/installer/window-frame.cpp', (text) => text
  .replace('Bitmap buffer(MulDiv(600, page->dpi, 96), MulDiv(600, page->dpi, 96)',
    'Bitmap buffer(MulDiv(820, page->dpi, 96), MulDiv(560, page->dpi, 96)')
  .replace('graphics.Clear(page->dark ? Color(255, 21, 21, 23) : Color(255, 255, 255, 255));',
    'graphics.Clear(Color(255, 126, 17, 35));')
  .replace('graphics.DrawImage(page->brand, Rect(0, 174, 600, 196));',
    'graphics.DrawImage(page->brand, Rect(0, 0, 330, 560));')
  .replace('graphics.DrawImage(page->brand, Rect(0, 0, 600, 600));',
    'graphics.DrawImage(page->brand, Rect(0, 0, 330, 560));')
  .replace('if (x >= 548) PostMessageW(parent, WM_CLOSE, 0, 0);', 'if (x >= 772) PostMessageW(parent, WM_CLOSE, 0, 0);')
  .replace('else if (x >= 504) ShowWindow(parent, SW_MINIMIZE);', 'else if (x >= 724) ShowWindow(parent, SW_MINIMIZE);')
  .replace('SolidBrush track(page->dark ? Color(255, 97, 102, 107) : Color(255, 233, 236, 242));',
    'SolidBrush track(Color(255, 255, 168, 182));')
  .replace('SolidBrush ink(page->dark ? Color(255, 255, 255, 255) : Color(255, 15, 17, 21));',
    'SolidBrush ink(Color(255, 255, 255, 255));')
  .replace('FillProgress(graphics, track, 472.0f);', 'FillProgress(graphics, track, 400.0f);')
  .replace('FillProgress(graphics, ink, 472.0f * static_cast<REAL>(page->progress.value) / 100);',
    'FillProgress(graphics, ink, 400.0f * static_cast<REAL>(page->progress.value) / 100);')
  .replace('RectF(48, 512, 504, 22)', 'RectF(360, 518, 400, 22)')
  .replace('RectF(504, 8, 40, 32)', 'RectF(724, 8, 40, 32)')
  .replace('RectF(548, 8, 40, 32)', 'RectF(772, 8, 40, 32)')
  .replace('0, 0, MulDiv(600, dpi, 96), MulDiv(600, dpi, 96), parent',
    '0, 0, MulDiv(820, dpi, 96), MulDiv(560, dpi, 96), parent')
  .split('64.0f, 482.0f').join('360.0f, 500.0f')
  .split('64.0f + width').join('360.0f + width')
  .split('64.0f, 484.0f').join('360.0f, 502.0f')
  .split('482.0f').join('500.0f')
  .split('484.0f').join('502.0f'));

// ⑤c 修正 NSIS 查找安装器资源的构建根。
//    配置层的 `beforeBuild` 把 BMP/DLL 写到 `$LINGDONG_BUILD_ROOT`（本项目约定 `.desktop-build2`），
//    但上游 `installer.nsh` 默认还指向 `.desktop-build`，导致安装器明明生成了新图却嵌入旧缓存。
edit('apps/desktop/scripts/installer.nsh', (text) =>
  text.replace(
    '${__FILEDIR__}\\..\\.desktop-build\\targets\\win-x64\\installer-ui',
    '${__FILEDIR__}\\..\\.desktop-build2\\targets\\win-x64\\installer-ui',
  ));
// ⑥ dsh 界面里的字标：**字符串替换改不动** —— 上游那幅字标是矢量稿，
//    "deepseek" 那几个字母是 SVG path 而不是文本节点（上一轮就是卡在这：扫了 4470 个文件、
//    命中 150 个，学生打开客户端看到的还是上游字标）。所以直接换"字标产地"：
//      · web/boot-page.ts —— 启动页（framework-free，dsh 起来前第一眼看到的那屏）；
//      · ui-brand-official/Brand.tsx —— 侧栏品牌位（mark + name 两个 slot 的占用者）；
//      · locale 里的 `brand.localBuild` —— 非 official 构建时侧栏回退显示的那个名字。
//    ⚠️ 侧栏显示哪套由 `DSH_CLIENT_BUILD_PROFILE` 决定（见 ui-brand-official/README）：
//      official → Brand.tsx 那两个组件；其它取值 → 回退成 `brand.localBuild` 这个名字。
//      两条路都要是我们的牌，所以两边都换 —— 只换一边的话换个构建档就露馅。
const UI_WORDMARK = '灵动ai';
edit('packages/client/web/src/boot-page.ts', (text) =>
  text.replace("div(css.wordmark, 'HARNESS')", `div(css.wordmark, '${UI_WORDMARK}')`));
edit('packages/client/locale/src/locales/zh.ts', (text) =>
  text.replace("'brand.localBuild': 'DSH 本地构建',", `'brand.localBuild': '${UI_WORDMARK}',`));
edit('packages/client/locale/src/locales/en.ts', (text) =>
  text.replace("'brand.localBuild': 'DSH Local Build',", "'brand.localBuild': 'LingdongAI',"));
overwrite('packages/client/ui-brand-official/src/client/Brand.tsx', `/**
 * 灵动ai 的品牌位（2026-09-20 起由本仓库的 deploy/desktop/rebrand-client.mjs 整份覆盖）。
 *
 * 这里直接使用产品提供的字标 PNG，避免用系统字体临摹后出现字重、字形和间距漂移。
 * 图片内联为 data URI，不依赖上游是否有静态资源目录；side bar 的 mark/name 两个 slot
 * 由一个字标承载，收起侧栏时仍作为同一个品牌入口。
 */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

const WORDMARK_DATA_URI = '${brandLogoDataUri}'

/** 侧栏品牌字标：保持原图约 2.1:1 的比例，避免被宽容器 object-fit 二次缩小。 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <img
      src={WORDMARK_DATA_URI}
      alt=''
      aria-hidden='true'
      role='presentation'
      data-lingdong-wordmark
      style={{ display: 'block', width: Number((size * 2.1).toFixed(1)), height: size, maxWidth: '100%', objectFit: 'contain' }}
    />
  )
}

/** 字标已包含完整品牌名，不再重复文本。 */
export function OfficialBrandName() {
  return null
}
`);

// ⑥a 展开态把品牌字标真正放大，并在侧栏可用宽度中居中；收起轨道仍裁切为图标位。
edit('packages/client/ui-sidebar/src/client/SidebarRoot.module.css', (text) => {
  const marker = '/* 灵动ai：放大并居中侧栏品牌字标。 */'
  const current = `.root:not(.collapsed) .brand { justify-content: center; padding-left: 0 !important; }\n.root:not(.collapsed) .brandIdentity { width: 100%; justify-content: center; height: 36px; }\n.root:not(.collapsed) .brandMark { display: flex; height: 36px; align-items: center; justify-content: center; }`
  if (text.includes(current)) return text
  const previous = `${marker}\n.root:not(.collapsed) .brand { justify-content: center; padding-left: 0 !important; }\n.root:not(.collapsed) .brandIdentity { width: 100%; justify-content: center; height: 30px; }\n.root:not(.collapsed) .brandMark { display: flex; height: 30px; align-items: center; justify-content: center; }`
  if (text.includes(previous)) return text.replace(previous, `${marker}\n${current}`)
  return `${text.trimEnd()}\n\n${marker}\n${current}\n`
});

// ⑥ab 展开态把传给字标的高度从 24 提到 34；收起态仍保持 24。
edit('packages/client/ui-sidebar/src/client/SidebarRoot.tsx', (text) => {
  const before = `<span className={css.brandMark}>
                {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo size={24} /> })}`
  const after = `<span className={css.brandMark}>
                {renderSlot('sidebar.brand.mark', { size: 34 }, { fallback: <FishLogo size={34} /> })}`
  return text.includes(after) ? text : text.replace(before, after)
});

overwrite('packages/client/ui-primitives/src/BrandWordmark.tsx', `/**
 * 灵动ai full wordmark. \`includeMark\` is retained for upstream call compatibility;
 * the supplied product mark already contains the complete name.
 */
import type { IconProps } from './icons/props.ts'

const LINGDONG_WORDMARK = '${brandLogoDataUri}'

export interface BrandWordmarkProps extends IconProps {
  readonly includeMark?: boolean | undefined
}

export function BrandWordmark({ size = 24, className }: BrandWordmarkProps) {
  return (
    <img
      src={LINGDONG_WORDMARK}
      width={size * (720 / 342)}
      height={size}
      className={className}
      alt=''
      aria-hidden='true'
      style={{ display: 'block', maxWidth: '100%', objectFit: 'contain' }}
    />
  )
}
`);
edit('packages/client/ui-primitives/tests/icons.client.spec.tsx', (text) => {
  const legacy = `  it('renders the fish path in currentColor at the native ratio', () => {
    const { container } = render(<primitives.FishLogo />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(Number(svg.getAttribute('height'))).toBeCloseTo(17.66, 1)
    expect(svg.getAttribute('viewBox')).toBe('0 0 23.16 17.04')
    expect(container.querySelectorAll('path')).toHaveLength(1)
    expect(container.innerHTML).toContain('currentColor')
    expect(container.innerHTML).not.toContain('M0 0L23.16')
  })`
  const current = `  it('renders the supplied wordmark image at the requested height', () => {
    const { container } = render(<primitives.FishLogo />)
    const image = container.querySelector('img')!
    expect(Number(image.getAttribute('height'))).toBe(24)
    expect(Number(image.getAttribute('width'))).toBeGreaterThan(48)
    expect(image.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true)
    expect(container.querySelector('path')).toBeNull()
  })`
  return text.includes(current) ? text : text.replace(legacy, current)
});
edit('packages/client/ui-conversation/tests/skeleton.client.spec.tsx', (text) => text
  .split("'Into the Unknown'").join("'VibeCoding with Lingdong'")
  .split("'探索未至之境'").join("'小灵陪你一起 VibeCoding'")
  .split(/\r?\n/u).filter(line =>
    !line.includes("getByText('Preview')") && !line.includes("getByText('预览版')")).join('\n'));

edit('packages/client/ui-primitives/tests/icons.client.spec.tsx', (text) => {
  const legacy = `describe('BrandWordmark', () => {
  it('can render the name artwork with or without its leading mark', () => {
    const view = render(<primitives.BrandWordmark />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('182')
    expect(svg.getAttribute('viewBox')).toBe('0 0 182 24')

    view.rerender(<primitives.BrandWordmark includeMark={false} />)
    expect(svg.getAttribute('width')).toBe('156')
    expect(svg.getAttribute('viewBox')).toBe('26 0 156 24')
  })
})`
  const current = `describe('BrandWordmark', () => {
  it('renders the supplied product wordmark image', () => {
    const view = render(<primitives.BrandWordmark />)
    const image = view.container.querySelector('img')!
    expect(Number(image.getAttribute('height'))).toBe(24)
    expect(Number(image.getAttribute('width'))).toBeGreaterThan(48)
    expect(image.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true)
  })
})`
  return text.includes(current) ? text : text.replace(legacy, current)
});
// ⑥ab 会话空态与所有上游 fallback：鲸鱼整支换成灵动ai 字标，并去掉“预览版”。
overwrite('packages/client/ui-primitives/src/FishLogo.tsx', `/**
 * 灵动ai 品牌字标（上游 FishLogo 的兼容实现）。
 * 保留原导出名，避免所有调用点逐一改签名；真正显示的是产品提供的蓝橙字标。
 */
import type { IconProps } from './icons/props.ts'

export const FISH_LOGO_VIEWBOX = { width: 720, height: 342 }
export const FISH_LOGO_PATH = 'lingdong-ai'
const LINGDONG_WORDMARK = '${brandLogoDataUri}'

/** Render the supplied LingdongAI wordmark at the caller's requested height. */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <img
      src={LINGDONG_WORDMARK}
      className={className}
      width={size * (FISH_LOGO_VIEWBOX.width / FISH_LOGO_VIEWBOX.height)}
      height={size}
      alt=''
      aria-hidden='true'
      style={{ display: 'block', maxWidth: '100%', objectFit: 'contain' }}
    />
  )
}
`);
overwrite('packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx', fs.readFileSync(path.join(here, 'client-patch', 'EmptyHero.tsx'), 'utf8'));
edit('packages/client/ui-chat/src/client/locale.ts', (text) => text
  .replace("'chat.deepDiving': '深度求索中...',", "'chat.deepDiving': '小灵VibeCoding中...',")
  .replace("'chat.deepDiving': 'Deep diving...',", "'chat.deepDiving': 'Lingdong VibeCoding...',"));
edit('packages/client/ui-chat/tests/chat-view.client.spec.tsx', (text) => text
  .split('深度求索中...').join('小灵VibeCoding中...')
  .split('深度求索中').join('小灵VibeCoding中'));
edit('packages/client/ui-conversation/src/client/locales.ts', (text) => text
  .replace("'hero.headline': '探索未至之境',", "'hero.headline': '小灵陪你一起 VibeCoding',")
  .replace("'hero.headline': 'Into the Unknown',", "'hero.headline': 'VibeCoding with Lingdong',"));

// ⑥a 品牌位测试跟着我们的实现走：名字 slot 不再重复渲染，字标由 mark slot 的图片承载。
edit('packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx', (text) => {
  const legacy = `  it('renders the official name independently from both requested mark sizes', () => {
    const name = render(<OfficialBrandName />)
    expect(name.container.querySelector('svg')?.getAttribute('viewBox')).toBe('26 0 156 24')
    name.unmount()

    const mark = render(<OfficialBrandMark size={34} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('34')
    mark.rerender(<OfficialBrandMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
  })`
  const current = `  it('renders the supplied wordmark once and scales it with the requested size', () => {
    const name = render(<OfficialBrandName />)
    expect(name.container.innerHTML).toBe('')
    name.unmount()

    const mark = render(<OfficialBrandMark size={34} />)
    const image = mark.container.querySelector('img')
    expect(image?.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true)
    expect(image?.style.width).toBe('71.4px')
    mark.rerender(<OfficialBrandMark size={24} />)
    expect(mark.container.querySelector('img')?.style.width).toBe('50.4px')
  })`
  const migrated = text
    .split("expect(image?.style.width).toBe('136px')").join("expect(image?.style.width).toBe('71.4px')")
    .split("expect(mark.container.querySelector('img')?.style.width).toBe('96px')").join("expect(mark.container.querySelector('img')?.style.width).toBe('50.4px')")
  if (migrated.includes(current)) return migrated
  return migrated.includes(legacy) ? migrated.replace(legacy, current) : migrated
});

// ⑥a 上游侧栏测试里的回退品牌名也要跟我们的品牌一致。
edit('packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx', (text) =>
  text.split('DSH Local Build').join('LingdongAI'));

// ⑥a 安装器：首次打开就直接展开安装路径，别让学生先点一次“选择安装位置”。
edit('apps/desktop/installer/lifecycle.nsh', (text) => {
  const marker = '    StrCpy $InstallerPhase "welcome"'
  if (!text.includes(marker) || text.includes('    StrCpy $InstallerExpanded 1')) return text
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return text.replace(marker, `${marker}${eol}    StrCpy $InstallerExpanded 1`)
});

// ⑥b 窗口标题与 PWA 名：dsh 的**官方构建档**把标题钉在一个常量里，而且构建会**断言**这个值
//     （`assertClientBuildEnvironment`），所以不能只在生成时传环境变量 —— 必须改常量本身，
//     两处一起改（常量 + 断言里那份期望），否则下一次构建直接报错。
//     实测：不改的话客户端窗口标题栏写着 "DeepSeek Harness"（品牌合规也不允许用全称）。
edit('scripts/client-build-environment.ts', (text) =>
  text.replace("  DSH_CLIENT_TITLE: 'DeepSeek Harness',", `  DSH_CLIENT_TITLE: '${BRAND.productName}',`));
edit('scripts/client-build-environment.client.spec.ts', (text) =>
  text.split("DSH_CLIENT_TITLE: 'DeepSeek Harness'").join(`DSH_CLIENT_TITLE: '${BRAND.productName}'`));
edit('apps/web/vite.config.ts', (text) =>
  text.replace("const DEFAULT_CLIENT_TITLE = 'DSH Local Build'", `const DEFAULT_CLIENT_TITLE = '${BRAND.productName}'`));
edit('apps/web/public/manifest.webmanifest', (text) => text
  .replace('"name": "DeepSeek Harness"', `"name": "${BRAND.productName}"`)
  .replace('"short_name": "DSH"', '"short_name": "灵动ai"'));

console.log(`检出：${checkout}${dryRun ? '（--dry-run，不写入）' : ''}`);
console.log(`品牌：${BRAND.productName}（英文 ${BRAND.productNameEn}）/ 安装包 ${BRAND.artifactName}`);
for (const [file, result] of changes) console.log(`  · ${file} —— ${result}`);
console.log('\n⚠️ 还要手工确认的：');
console.log('   ① 关于/署名：请在 About 里保留一句「' + BRAND.attribution + '」');
console.log('   ② 安装器图片：brand*.png 与 uninstaller-sidebar.png 已由本脚本自动替换。');
