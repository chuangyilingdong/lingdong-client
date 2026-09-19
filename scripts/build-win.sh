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
CHECKOUT="$ROOT/upstream/dsh-harness"
MIRROR_PORT="${2:-18920}"

[ -d "$CHECKOUT/apps/desktop" ] || { echo "!! 没找到上游检出：$CHECKOUT（先按 README 的『出包』第 0 步准备）"; exit 2; }

echo "=== ① 先品牌、再登录门（顺序不能反） ==="
node "$ROOT/deploy/desktop/rebrand-client.mjs" --checkout "$CHECKOUT"
node "$ROOT/deploy/desktop/apply-client-gate.mjs" --checkout "$CHECKOUT"

echo "=== ② 离线 Electron 镜像（$1） ==="
MIRROR_PID=""
if [ "${1:-}" = "--with-mirror" ]; then
  [ -f "$ROOT/upstream/electron-mirror/v44.0.0/SHASUMS256.txt" ] || { echo "!! 缺官方 SHASUMS256.txt，见 docs/交接-客户端-20260919.md §三"; exit 2; }
  node "$ROOT/scripts/electron-mirror.mjs" "$MIRROR_PORT" &
  MIRROR_PID=$!
  sleep 2
  export ELECTRON_MIRROR="http://127.0.0.1:$MIRROR_PORT/"
  echo "   镜像起来了（PID $MIRROR_PID），ELECTRON_MIRROR=$ELECTRON_MIRROR"
fi

echo "=== ③ 打包（约 30 分钟） ==="
cd "$CHECKOUT"
# ⚠️ node 要用 ≥22 那份；bsdtar 用系统自带的
export PATH="/c/Program Files/nodejs:/c/WINDOWS/system32:$PATH"
export LINGDONG_BUILD_ROOT=.desktop-build2
pnpm --filter @deepseek-ai/dsh-desktop run package:win:x64:unsigned

ARTIFACT_DIR="$CHECKOUT/apps/desktop/.desktop-build2/targets/win-x64/unsigned-artifacts"
ls -la "$ARTIFACT_DIR"/*.exe
echo "BUILD_WIN_DONE 产物在 $ARTIFACT_DIR"
[ -n "$MIRROR_PID" ] && kill "$MIRROR_PID" 2>/dev/null || true
