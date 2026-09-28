#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/c/Program Files/nodejs:/c/WINDOWS/system32:$PATH"
export ZCODE_ENV="${ZCODE_ENV:-production}"
export ZCODE_DESKTOP_DIST_DIR="${ZCODE_DESKTOP_DIST_DIR:-$ROOT/dist/win-x64}"
export LINGDONG_API_BASE="${LINGDONG_API_BASE:-https://aicyld.com}"
cd "$ROOT"
echo "灵动ai ZCode Windows 构建：$ZCODE_ENV"
pnpm --filter @zcode/desktop run bundle -- --os win --arch x64 "$@"
