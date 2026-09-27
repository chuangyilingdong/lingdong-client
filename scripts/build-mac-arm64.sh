#!/usr/bin/env bash
# 出一份 macOS Apple Silicon 客户端（2026-09-27，客户端仓库）。
#
# 用法：
#   bash scripts/build-mac-arm64.sh              # 正式包：必须已配 .env.macos 和 Apple 签名/公证凭据
#   bash scripts/build-mac-arm64.sh --unsigned   # 本机验收包：无需证书，不能作为学生分发包
#
# 硬约束：
#   1. 只能在 Apple Silicon macOS 主机上构建；上游 package-target 会主动拒绝其它主机。
#   2. 正式包必须签名并公证，否则 Gatekeeper 会拦截；未签名选项只用于本机验收。
#   3. 改过补丁真源后，本脚本会先 rebrand + apply + verify，再开始出包。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKOUT="${LINGDONG_CHECKOUT:-$ROOT/.tmp/dsh-0.1.7-rc.2}"
PINNED_COMMIT="477b4f420553e8a52c2fbccc464d7561b239c443"
UNSIGNED=0
CREATED_ENV=0

if [ "${1:-}" = "--unsigned" ]; then
  UNSIGNED=1
elif [ -n "${1:-}" ]; then
  echo "未知参数：$1（只支持 --unsigned）"
  exit 2
fi

cleanup() {
  if [ "$CREATED_ENV" = "1" ]; then
    rm -f "$CHECKOUT/apps/desktop/.env.macos"
  fi
}
trap cleanup EXIT

[ "$(uname -s)" = "Darwin" ] || { echo "!! macOS 包只能在 macOS 主机上构建"; exit 2; }
[ "$(uname -m)" = "arm64" ] || { echo "!! mac-arm64 包必须在 Apple Silicon（arm64）主机上构建"; exit 2; }
[ -d "$CHECKOUT/apps/desktop" ] || { echo "!! 没找到上游检出：$CHECKOUT"; exit 2; }

ACTUAL_COMMIT="$(git -C "$CHECKOUT" rev-parse HEAD)"
[ "$ACTUAL_COMMIT" = "$PINNED_COMMIT" ] || { echo "!! 上游 commit 不是钉住的 ${PINNED_COMMIT}，实际为 ${ACTUAL_COMMIT}"; exit 2; }

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[ "$NODE_MAJOR" -ge 22 ] || { echo "!! 需要 Node.js >= 22，当前：$(node -v)"; exit 2; }

export LINGDONG_CLIENT_VERSION="${LINGDONG_CLIENT_VERSION:-0.1.7-rc.2.9}"
export LINGDONG_DSH_BASE_VERSION="0.1.7-rc.2"
export LINGDONG_DISABLE_UPSTREAM_UPDATE=1
export LINGDONG_API_BASE="${LINGDONG_API_BASE:-https://aicyld.com}"
export DSH_DESKTOP_APP_ID="${DSH_DESKTOP_APP_ID:-cn.aimagc.lingdong}"

echo "客户端版本：${LINGDONG_CLIENT_VERSION}（DSH 基础版本 ${LINGDONG_DSH_BASE_VERSION}，目标 mac-arm64）"

echo "=== ① 先品牌、再登录门 ==="
node "$ROOT/deploy/desktop/rebrand-client.mjs" --checkout "$CHECKOUT"
node "$ROOT/deploy/desktop/apply-client-gate.mjs" --checkout "$CHECKOUT"
node "$ROOT/scripts/verify-upstream-patches.mjs" "$CHECKOUT"

if [ "$UNSIGNED" = "1" ]; then
  if [ ! -f "$CHECKOUT/apps/desktop/.env.macos" ]; then
    cat > "$CHECKOUT/apps/desktop/.env.macos" <<'EOF'
# 自动生成本机未签名验收包配置；脚本退出时会删除。
DSH_DESKTOP_APP_ID=cn.aimagc.lingdong
DSH_DESKTOP_AUTO_UPDATE_ENV=test
DOWNLOAD_TEST_ORIGIN=https://aicyld.com
DOWNLOAD_TEST_RELEASE_ID=0123456789abcdef0123456789abcdef
DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=https://aicyld.com
DSH_DESKTOP_MANDATORY_UPDATE_CONFIG={"allowedAuthOrigins":["https://aicyld.com"]}
DSH_DESKTOP_MACOS_PACK_CONCURRENCY=4
EOF
    CREATED_ENV=1
    echo "⚠️ 未签名验收模式：临时生成 .env.macos（无证书配置）"
  fi
  if ! grep -q '^DSH_DESKTOP_APP_ID=cn\.aimagc\.lingdong$' "$CHECKOUT/apps/desktop/.env.macos"; then
    echo "!! .env.macos 里 DSH_DESKTOP_APP_ID 必须是 cn.aimagc.lingdong"
    exit 2
  fi
  echo "=== ② 打包未签名 DMG/ZIP（本机验收，不能外发） ==="
  (
    cd "$CHECKOUT"
    pnpm --filter @deepseek-ai/dsh-desktop run package -- mac-arm64 --unsigned
  )
  ARTIFACT_DIR="$CHECKOUT/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts"
else
  [ -f "$CHECKOUT/apps/desktop/.env.macos" ] || {
    echo "!! 正式包缺少 $CHECKOUT/apps/desktop/.env.macos"
    echo "   请复制 .env.macos.example，填写 Developer ID、notarization 凭据，并设置 DSH_DESKTOP_APP_ID=cn.aimagc.lingdong"
    exit 2
  }
  echo "=== ② 打包签名 + 公证 DMG/ZIP ==="
  (
    cd "$CHECKOUT"
    pnpm --filter @deepseek-ai/dsh-desktop run package:mac:arm64
  )
  ARTIFACT_DIR="$CHECKOUT/apps/desktop/.desktop-build/targets/mac-arm64/artifacts"
fi

echo "=== ③ 产物 ==="
ls -lh "$ARTIFACT_DIR"/*.dmg "$ARTIFACT_DIR"/*.zip
echo "BUILD_MAC_ARM64_DONE 产物在 $ARTIFACT_DIR"