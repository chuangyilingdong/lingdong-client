#!/usr/bin/env bash
set -euo pipefail
# ZCode/灵动ai 桌面包发布入口；平台 manifest 契约保持不变。
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/publish-client.sh" "$@"
