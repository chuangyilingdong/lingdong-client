# 用 CDP 驱动跑着的客户端

客户端（Electron）在 dev 模式下会把渲染进程的调试端口开在 **9222**（`dev.ts` 里写死），
所以不用 Playwright 的 Electron 支持也能驱动它 —— 直接说 CDP 协议最稳
（⚠️ Playwright 的 `connectOverCDP` 接 Electron 会**超时**，别用）。

```bash
node scripts/drive/flow.mjs ls                # 看有哪些页面（门页 / dsh 界面）
node scripts/drive/flow.mjs login             # 在登录门里填 student-1/study123 并提交
node scripts/drive/flow.mjs app               # 等 dsh 界面出来（打印正文 + 截图）
node scripts/drive/flow.mjs send "做个网页"    # 在对话框里发一条消息（回车发送）
node scripts/drive/ui.mjs dump                # 列出可点的按钮/菜单项
node scripts/drive/ui.mjs click "选择工作区"    # 按文本点一下
node scripts/drive/ui.mjs text                # 把界面正文打出来
node scripts/drive/ui.mjs shot <名字>          # 截图
node scripts/drive/type.mjs "要输入的文字"      # 往输入框写文字（Input.insertText）
node scripts/drive/clicktext.mjs "新会话"       # 按"最小的那个包含该文字的节点"点击
```

截图默认落到 `.tmp/bench-shots/`（gitignore）。

## 三条踩过的经验

1. **写 React 受控输入框只能用 `Input.insertText`**：直接改 `.value` / `innerText` /
   派发 `input` 事件它都不认（页面看着有字，一提交就空）。
2. **「选择工作区」点的是原生目录选择器**（CDP 驱动不了）：直接预置
   `$DSH_HOME/storages/workspace.json` 再**重启**客户端 —— storage 由宿主进程缓存在内存里，
   改文件不热生效。形状见 `docs/交接-客户端-20260919.md` §四。
3. 这些脚本默认连 `127.0.0.1:9222`；端口被占或客户端没起来时先 `flow.mjs ls` 确认。
