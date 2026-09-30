# 课堂作品提交：带上入口 HTML 引用的本地素材

## 背景

平台此前**拒收任何带 `/` 的文件名**，客户端只能把文件名拍平，于是入口 HTML 里的
`src="assets/hero.png"` 在平台上找不到对应资源——学生交上去的作品图片裂、视频空。
平台侧已修好（允许相对路径名，并把相对引用改写成 `/api/student/file-assets/<id>/download`），
客户端负责把**入口引用的本地素材一起打包提交**。

接口不变：`POST /api/student/runtime/submit-upload`，路径、鉴权、字段名都不动，
`sessionId` / `classroomId` 也不传（课堂由运行时密钥解出）。

## 客户端契约（提交给平台的形状）

```jsonc
{
  "name": "index.html",
  "copyrightConfirmed": true,
  "cover": { "content": "<base64 PNG>" },
  "files": [
    { "name": "index.html",      "content": "<html…>", "binary": false },
    { "name": "style.css",       "content": "…",       "binary": false },
    { "name": "assets/hero.png", "content": "<base64>", "binary": true },
    { "name": "assets/clip.mp4", "content": "<base64>", "binary": true }
  ]
}
```

- `name` 用**相对路径**，与 HTML/CSS 里写的引用逐字一致（去掉开头 `./`、去掉 `?query`/`#hash` 之后）。
- `name` 相对**入口文件所在目录**计算，入口自身取文件名（`index.html`）。
- `.css` / `.js` 等文本按 `binary: false` 提交（平台内联进预览）；图片/视频/音频按 `binary: true`。

## 清单怎么算

1. 起点是学生勾选的入口文件（`.htm/.html/.docx/.xlsx/.pptx`，入口放进 `files[0]` 与顶层 `name`）。
2. 从入口 HTML 出发扫 `src=` / `href=` / `poster=`，以及 `<style>` 内联样式与引用的 `.css` 里的 `url()`。
3. 丢掉：`http(s)://`、`//` 协议相对、`data:` 等带协议、`#` 页内锚点、以 `/` 开头的站点绝对路径。
4. 去掉开头 `./` 与 `?query`/`#hash` 后，按**所在文件**的相对位置解析；工作区里存在且在白名单内的才带上。
5. CSS 会继续向下扫一层（CSS 引用的图/字体也带上）。

## 名字白名单（平台服务端逐段校验，不合规整单 400、不静默改名）

- ≤6 段（5 层目录）、单段 ≤64 字、整名 ≤120 字。
- 段首必须是中英文/数字，段内可含 `.` `_` `-`。
- 禁止 `..`、隐藏文件（`.` 开头）、绝对路径、盘符、反斜杠。

## 体积与数量

- 文件数 ≤60，base64 解码后合计 ≤16MB（封面另算），JSON 请求体 ≤24MB。
- 平台今天能存：`png/jpg/jpeg/gif/webp/mp3/mp4/webm`；字体与 `svg` 平台侧会跳过并发一条 warning，
  作品照样交得上（那几处资源在平台侧为空）。

## 不变量

1. 只提交**工作区内**的文件：解析结果必须落在入口工作区里，越界一律丢弃。
2. 外部引用绝不外带：`http(s)`、`data:`、`//`、页内锚点、站点绝对路径都不进清单。
3. 同一个文件只提交一次（按绝对路径去重），名字冲突时后者丢弃。
4. 名字不合规的素材**跳过**；入口本身名字不合规时**直接报错**，不发出必然 400 的请求。
5. 超出数量/体积预算的素材跳过，不改变入口与已收集素材的正确性。
6. 客户端不自己拼 `/api/student/file-assets/...` 地址——改写由平台做。

## 失败语义

- 单个素材读取失败（文件消失/权限）→ 跳过该素材，其余照常提交。
- 平台返回的 `warnings` / `missingAssets` 原样交给 UI；客户端不吞。

## 验收

1. 入口 HTML 里 `<img src='assets/hero.png'>`、`<video src='assets/clip.mp4'>`、
   `<link href='style.css'>`，且 `style.css` 里 `url('assets/bg.png')`：清单必须含
   `index.html`(text)、`style.css`(text)、`assets/hero.png`(binary)、`assets/clip.mp4`(binary)、
   `assets/bg.png`(binary)。
2. 同一份 HTML 里的 `https://…`、`data:…`、`#anchor` 引用不得出现在清单里。
3. mock 平台按白名单逐段校验，名字不合规直接 400 —— E2E 必须保持绿。
4. `pnpm typecheck`、`pnpm lint` 通过。
