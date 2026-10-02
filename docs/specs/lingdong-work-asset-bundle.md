# 课堂作品提交：入口文件与引用素材自动打包

## 背景

平台支持相对路径资源后，客户端提交一个 HTML/PPT/Word/Excel 主作品时，必须把主作品
本地引用的 CSS、图片、视频、音频等素材一起带上，否则平台预览会裂图或空播放器。

学生不应该逐个勾选这些“实现细节”素材。对话框只让学生看/选一个主作品文件；客户端负责
按主作品里的相对引用自动解析最终清单，并展示会自动带入的文件与总大小。

## 产品规则

1. 作品提交对话框只显示一个可提交主作品入口（`.htm/.html/.docx/.xlsx/.pptx`）。
   - 当前自动取工作区里**最近更新**的可提交入口文件。
   - 其他工作区文件不再逐项展示，也不再要求学生勾选。
2. 选中主作品后，客户端解析它涉及的全部本地引用文件：
   - HTML 的 `src` / `href` / `poster`，以及内联 `<style>` 和引用 CSS 里的 `url()`。
   - UI 以只读方式列出“自动包含”的引用文件；这些文件不单独勾选。
3. UI 显示最终清单的总文件数和原始大小合计。
4. 用户点击提交时，renderer 只发送主作品一项；宿主在提交前用同一份解析结果重新打包
   主作品和引用素材。
5. 若没有可提交主作品，显示空状态并禁用提交；若入口名不合法，显示宿主返回的具体原因。

## 客户端契约（提交给平台的形状）

```jsonc
{
  "name": "index.html",
  "copyrightConfirmed": true,
  "cover": { "content": "<base64 PNG>" },
  "files": [
    { "name": "index.html", "content": "<html…>", "binary": false },
    { "name": "style.css", "content": "…", "binary": false },
    { "name": "assets/hero.png", "content": "<base64>", "binary": true },
    { "name": "assets/clip.mp4", "content": "<base64>", "binary": true },
  ],
}
```

- `name` 用**相对路径**，与 HTML/CSS 里写的引用逐字一致（去掉开头 `./`、去掉 `?query`/`#hash` 之后）。
- `name` 相对**入口文件所在目录**计算，入口自身取文件名（`index.html`）。
- `.css` / `.js` 等文本按 `binary: false` 提交（平台内联进预览）；图片/视频/音频按 `binary: true`。

## 提交去重

### 产品规则

1. 已经成功提交过当前主作品，且打包内容没有任何新增、修改或删除时，提交按钮置灰，文案为
   `已提交，无新产出`。
2. 主作品本身、任一自动带入的引用文件或最终文件清单发生变化时，按钮恢复可提交。
3. 去重判断以**最终打包清单**为准，不以单个入口 HTML 的修改时间为准。
4. 平台历史作品可在本地没有提交记录时作为兜底，避免升级/换机后重复提交；平台查询失败时
   放行提交，宁可多交一次，也不能误挡新作品。

### 所有者与状态

- 唯一所有者：`packages/desktop/src/main/lingdongPlatformGate.ts`。
- 指纹键：`workspaceIdentity + 主作品工作区相对路径`。
- 指纹内容：最终清单中每个文件的提交资源名、原始大小、mtime；任一变化都会产生新指纹。
- 成功提交后由 Main 持久化指纹；renderer 只消费 `submitted` 与 `hasNewOutput`，不自行缓存事实。

### 事件顺序

```text
scanWorkspaceFiles()
  → resolveSubmitPlan()（与提交共用）
  → currentRevision = fingerprint(plan)
  → 读取本地指纹 / 平台历史作品兜底
  → preview{submitted, hasNewOutput, lastSubmittedAt}
  → UI 决定按钮是否置灰

submitWork()
  → 平台提交成功
  → 写入 currentRevision
  → 重新 scan 同一工作区
  → UI 按钮转为“已提交，无新产出”
```
## 预览契约

`scanWorkspaceFiles()` 在扫描元数据之外返回一个权威预览：

```ts
type ClassroomWorkspaceSubmitPreview = {
  entry: ClassroomWorkspaceFile;
  files: Array<{
    path: string;
    name: string; // 提交给平台的相对资源名
    relativePath: string; // 工作区内展示路径
    size: number; // 原始磁盘大小
    autoIncluded: boolean; // true = 从入口引用自动带入
  }>;
  totalBytes: number; // files 的原始大小合计
};
```

预览必须由与真实提交相同的解析函数生成，禁止 renderer 自行复制一套引用解析规则。

## 清单怎么算

1. 起点是唯一的主作品入口，放进 `files[0]` 与顶层 `name`。
2. 从入口 HTML 出发扫 `src=` / `href=` / `poster=`，以及 `<style>` 内联样式与引用的 `.css` 里的 `url()`。
3. 丢掉：`http(s)://`、`//` 协议相对、`data:` 等带协议、`#` 页内锚点、以 `/` 开头的站点绝对路径。
4. 去掉开头 `./` 与 `?query`/`#hash` 后，按**所在文件**的相对位置解析；工作区里存在且在白名单内的才带上。
5. CSS 会继续向下扫一层（CSS 引用的图/字体也带上）。

## 名字白名单（平台服务端逐段校验，不合规整单 400、不静默改名）

- ≤6 段（5 层目录）、单段 ≤64 字、整名 ≤120 字。
- 段首必须是中英文/数字，段内可含 `.` `_` `-`。
- 禁止 `..`、隐藏文件（`.` 开头）、绝对路径、盘符、反斜杠。

## 体积与数量

- 文件数 ≤60，base64 解码后合计 ≤100MB（封面另算）。
- 客户端提交前发送请求体上限按 140MB 预检；平台接收层必须覆盖 100MB 原始文件
  base64 后的约 133MB 传输量。
- `png/jpg/jpeg/gif/webp/mp3/mp4/webm` 是可存素材；字体与 `svg` 由平台按既有规则处理。

## 不变量

1. UI 只有一个主作品可选择/提交，引用素材不得变成第二个勾选项。
2. 只提交**工作区内**的文件：解析结果必须落在入口工作区里，越界一律丢弃。
3. 外部引用绝不外带：`http(s)`、`data:`、`//`、页内锚点、站点绝对路径都不进清单。
4. 同一个文件只提交一次（按绝对路径去重），名字冲突时后者丢弃。
5. 预览清单与真实提交清单必须一致；差异只能来自两次扫描之间文件系统发生变化。
6. 客户端不自己拼 `/api/student/file-assets/...` 地址——改写由平台做。

## 失败语义

- 扫描阶段没有入口：空状态，禁用提交。
- 入口名不合法：预览报错，禁用提交。
- 单个素材读取失败（文件消失/权限）：由宿主按既有提交错误处理，不伪造预览成功。
- 平台返回的 `warnings` / `missingAssets` 原样交给 UI；客户端不吞。

## 验收

1. 工作区有 `index.html`、`style.css`、`assets/hero.png`、`assets/clip.mp4`、`assets/bg.png` 时：
   - 对话框只出现一个主作品 `index.html`；
   - `style.css`、图片、视频以“自动包含”只读展示；
   - 总文件数与原始大小合计包含全部 5 个文件；
   - 提交请求只带 `items: [{ path: index.html }]`。
2. 入口 HTML 里的 `https://…`、`data:…`、`#anchor` 引用不得出现在预览或提交清单里。
3. mock 平台按白名单逐段校验，名字不合规直接 400 —— E2E 必须保持绿。
4. UI 不显示工作区里未被主作品引用的普通文件，例如 `notes.txt`。
5. `pnpm typecheck`、`pnpm lint` 通过。
