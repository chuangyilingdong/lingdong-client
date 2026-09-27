#!/usr/bin/env bash
# 出一份 Windows 安装包（2026-09-19，客户端仓库）。
#
# 为什么要有这个包装：出包要设对四件事，顺序也不能错，而这四件事都是**踩过才记住**的：
#   ① node 必须是 ≥22（PATH 里的 node 可能是微信开发者工具那份 v16）；
#   ② PATH 里要有 Windows 的 bsdtar（Git Bash 的 GNU tar 会把 E:\… 当远程主机）；
#   ③ 构建根固定（复用缓存，否则每次重头编，还要重新下主运行时）；
#   ④ 打不通 GitHub release 资产时（本机实测就是这样）走本地 Electron 镜像，
#      但镜像是**真的在按官方 SHASUMS256.txt 校验**，不是关掉校验。
#
# 用法：bash scripts/build-win.sh [--with-mirror <镜像端口>]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKOUT="${LINGDONG_CHECKOUT:-$ROOT/upstream/dsh-harness}"
MIRROR_PORT="${2:-18920}"

[ -d "$CHECKOUT/apps/desktop" ] || { echo "!! 没找到上游检出：$CHECKOUT（先按 README 的『出包』第 0 步准备）"; exit 2; }

PINNED_COMMIT="477b4f420553e8a52c2fbccc464d7561b239c443"
ACTUAL_COMMIT="$(git -C "$CHECKOUT" rev-parse HEAD)"
[ "$ACTUAL_COMMIT" = "$PINNED_COMMIT" ] || { echo "!! 上游 commit 不是钉住的 $PINNED_COMMIT，实际为 $ACTUAL_COMMIT"; exit 2; }
export LINGDONG_CLIENT_VERSION="${LINGDONG_CLIENT_VERSION:-0.1.7-rc.2.7}"
export LINGDONG_DSH_BASE_VERSION="0.1.7-rc.2"
export LINGDONG_DISABLE_UPSTREAM_UPDATE=1
# 双保险：代码里的兜底已经是新域名，这里再显式钉一次，避免有人用本机残留环境变量覆盖。
export LINGDONG_API_BASE="${LINGDONG_API_BASE:-https://aicyld.com}"
# 这台机器直连 GitHub release 会超时：主运行时归档走镜像前缀（仍按 lock 的 sha256 校验）。
export DSH_PRIMARY_RUNTIME_GITHUB_BASE="${DSH_PRIMARY_RUNTIME_GITHUB_BASE:-https://ghfast.top}"
export DSH_DESKTOP_APP_ID="${DSH_DESKTOP_APP_ID:-cn.aimagc.lingdong}"
echo "客户端版本：$LINGDONG_CLIENT_VERSION（DSH 基础版本 $LINGDONG_DSH_BASE_VERSION）"

echo "=== ① 先品牌、再登录门（顺序不能反） ==="
node "$ROOT/deploy/desktop/rebrand-client.mjs" --checkout "$CHECKOUT"
node "$ROOT/deploy/desktop/apply-client-gate.mjs" --checkout "$CHECKOUT"
node "$ROOT/scripts/verify-upstream-patches.mjs" "$CHECKOUT"

# 新版上游打包要求 apps/desktop/.env.windows（gitignore，不入库）。缺了就用 example 兜底，
# 保证未签名构建不会因为缺文件直接失败；真正发布用的值仍以仓库里那份为准。
if [ ! -f "$CHECKOUT/apps/desktop/.env.windows" ]; then
  echo "⚠️ 缺 $CHECKOUT/apps/desktop/.env.windows，用 .example 兜底（仅够本地出未签名包）"
  cp "$CHECKOUT/apps/desktop/.env.windows.example" "$CHECKOUT/apps/desktop/.env.windows"
fi

echo "=== ② 离线 Electron 镜像（$1） ==="
MIRROR_PID=""
if [ "${1:-}" = "--with-mirror" ]; then
  [ -f "$ROOT/upstream/electron-mirror/v44.0.0/SHASUMS256.txt" ] || { echo "!! 缺官方 SHASUMS256.txt，见 docs/交接-客户端-20260919.md §三"; exit 2; }
  node "$ROOT/scripts/electron-mirror.mjs" "$MIRROR_PORT" &
  MIRROR_PID=$!
  export ELECTRON_MIRROR="http://127.0.0.1:$MIRROR_PORT/"
  MIRROR_READY=0
  for _ in $(seq 1 20); do
    if curl -fsS "$ELECTRON_MIRROR/v44.0.0/SHASUMS256.txt" >/dev/null 2>&1; then MIRROR_READY=1; break; fi
    sleep 0.5
  done
  [ "$MIRROR_READY" = "1" ] || { echo "!! Electron 镜像未就绪：$ELECTRON_MIRROR"; kill "$MIRROR_PID" 2>/dev/null || true; exit 2; }
  echo "   镜像起来了（PID $MIRROR_PID），ELECTRON_MIRROR=$ELECTRON_MIRROR"
fi

echo "=== ③ 打包（约 30 分钟） ==="
cd "$CHECKOUT"
# ⚠️ node 要用 ≥22 那份；bsdtar 用系统自带的
export PATH="/c/Program Files/nodejs:/c/WINDOWS/system32:$PATH"
# 0.1.7 上游把构建根固定成 apps/desktop/.desktop-build；LINGDONG_BUILD_ROOT 已不再生效。
pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:unsigned

ARTIFACT_DIR="$CHECKOUT/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts"
ls -la "$ARTIFACT_DIR"/*.exe
echo "BUILD_WIN_DONE 产物在 $ARTIFACT_DIR"
[ -n "$MIRROR_PID" ] && kill "$MIRROR_PID" 2>/dev/null || true
