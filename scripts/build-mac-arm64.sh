#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ZCODE_ENV="${ZCODE_ENV:-production}"
export ZCODE_DESKTOP_DIST_DIR="${ZCODE_DESKTOP_DIST_DIR:-$ROOT/dist/mac-arm64}"
export LINGDONG_API_BASE="${LINGDONG_API_BASE:-https://aicyld.com}"
cd "$ROOT"
if [ "${1:-}" = "--unsigned" ]; then shift; export ZCODE_ENABLE_MAC_SIGN=0; fi
echo "灵动ai ZCode macOS 构建：$ZCODE_ENV"
pnpm --filter @zcode/desktop run bundle -- --os mac --arch arm64 "$@"
