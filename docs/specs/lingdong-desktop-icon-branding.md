# 灵动 ai 桌面端图标品牌

## 背景

Windows 安装包已经显式使用灵动 ai 图标，但 macOS 构建此前仍把仓库中的
`build/icon.icns` 和 `build/icon_installer.icns` 当作最终资源。这两个文件实际是
ZCode 的黑色 Z 标，导致 `.app` 启动图标和 DMG 卷图标都显示成 ZCode。
DMG 背景图中央也仍写着 `ZCODE`。

## 产品规则

1. macOS 应用图标只以 `packages/desktop/build/icon_installer.png` 为源；该文件必须是
   1024x1024 PNG，当前品牌资源 SHA256 为
   `f4b5695bbfcfe10d37be27280f048ca2c5d01690849721ed4e097e5ff9522c15`。
2. `mac.icon` 必须显式指向该 PNG，由 electron-builder 在打包阶段转换成
   `.app/Contents/Resources/icon.icns`；不直接提交或引用产物 `.icns`。
3. DMG 卷图标不单独覆盖；未配置 `dmg.icon` 时继承 electron-builder 已转换的灵动 ai 应
   用图标，避免回退到旧 ZCode `.icns`。
4. DMG 背景图必须使用灵动 ai 品牌，不得再出现 `ZCODE`。当前资源 SHA256：
   - `dmg_background.png`：
     `9d245e0803465ca72add7a61ba0bf2420f6697f48bb308b79027255d4bab7515`
   - `dmg_background@2x.png`：
     `8269ab3958a600b409a6c32a90fa2c447788da98f076506f7b283aa42a6e2a20`
5. `build/icon.icns`、`build/icon_installer.icns` 不是品牌源，也不再作为 macOS 打包
   输入保留。
6. Windows 的 `icon_installer.ico` 与 Windows 运行时图标逻辑不变。

## 所有者与边界

- 打包资源选择唯一所有者为 `packages/desktop/electron-builder.config.js`。
- 品牌源唯一所有者为 `packages/desktop/resources/gate/app-icon-1024.png` 与两张 DMG 背景图。
- 主进程、Renderer、托盘和关于页仍按现有运行时路径读取图标；本变更不引入第二份状态或
  运行时判断。

## 失败语义

- 品牌源缺失、尺寸不是 1024x1024、SHA256 不匹配，DMG 背景图变更未经过品牌更新，或配置
  重新引用已删除的 `.icns` 时，`verify:brand-icons` 必须失败，bundle 不得继续产出安装包。
- macOS 打包后若 `.app/Contents/Resources/icon.icns` 的 `ic10` 与品牌源不一致，
  macOS smoke 校验必须失败。

## 验收

1. `pnpm --filter @zcode/desktop verify:brand-icons` 通过。
2. macOS bundle 完成后，`.app/Contents/Resources/icon.icns` 的 `ic10` PNG 字节与
   `resources/gate/app-icon-1024.png` 完全一致。
3. DMG 未配置独立 `.icns`，挂载卷图标显示灵动 ai，而不是 ZCode。
4. DMG 背景图显示灵动 ai 品牌，不包含 `ZCODE`。
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
