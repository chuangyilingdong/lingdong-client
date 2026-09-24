#!/usr/bin/env bash
# 把新打出来的客户端安装包发布出去（2026-09-19 下半场）。
#
# 为什么要有它：出包之后要做四件事，顺序不能乱，而且每一步都要看得见结果 ——
#   ① 算本地校验值（发布后能核对下载到的东西与打出来的是同一份）
#   ② 传到**发布目录之外的** /srv/ai-kids-platform/downloads/（每次换代都不会被冲掉）
#   ③ 把 manifest.json 里的 win-x64 置回（上一轮为「客户端跑不通」故意摘成 null）
#   ④ 核验公网真的能下（HEAD 一下 /downloads/<文件名>，看 content-length 对不对）
#
# 用法：bash .tmp/publish-client.sh <安装包路径> [--dry-run]
set -euo pipefail

KEY="${PUBLISH_CLIENT_SSH_KEY:-$HOME/.ssh/ai_kids_platform_ecs_temp_ed25519}"
HOST="${PUBLISH_CLIENT_HOST:-root@8.134.80.184}"
REMOTE_DIR="/srv/ai-kids-platform/downloads"
KNOWN_HOSTS="${PUBLISH_CLIENT_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
EXE="${1:-}"
DRY="${2:-}"

if [ -z "$EXE" ] || [ ! -f "$EXE" ]; then echo "用法：bash $0 <安装包路径> [--dry-run]"; exit 2; fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "!! 客户端仓库有未提交改动，停止发布"; exit 1; }
NAME=$(basename "$EXE")
SIZE=$(stat -c %s "$EXE")
SHA=$(sha256sum "$EXE" | cut -d' ' -f1)
# ⚠️ 未签名构建带 -unsigned 后缀，版本号必须把它剥掉，否则 manifest 会写成 0.1.7-alpha.2.1-unsigned，
#    客户端的 app.getVersion() 对不上，更新判断直接错位。
VERSION=$(echo "$NAME" | sed -E 's/^lingdong-client-(.*)-win-x64(-unsigned)?\.exe$/\1/')
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "!! 从文件名解析出的版本号不合法：$VERSION（文件名 $NAME）"; exit 2 ;;
esac
echo "安装包：$NAME"
echo "  版本：$VERSION"
echo "  字节：$SIZE"
echo "  sha256：$SHA"
if [ "$DRY" = "--dry-run" ]; then echo "（--dry-run：到此为止，什么都没传）"; exit 0; fi

REMOTE_VERSION=$(ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "$HOST" "jq -r '.version // \"\"' '$REMOTE_DIR/manifest.json'")
if [ "$REMOTE_VERSION" = "$VERSION" ] && [ "${ALLOW_SAME_VERSION_REPUBLISH:-}" != "1" ]; then
  echo "!! manifest 已经是 $VERSION；客户端不会提示同版本更新。请先升版本号，或显式设置 ALLOW_SAME_VERSION_REPUBLISH=1"
  exit 1
fi

echo "=== ① 传到 $REMOTE_DIR（发布目录之外，换代不冲） ==="
scp "${SSH_OPTS[@]}" "$EXE" "$HOST:$REMOTE_DIR/$NAME"

echo "=== ② 服务器上核对字节数与 SHA256 ==="
REMOTE_SIZE=$(ssh "${SSH_OPTS[@]}" "$HOST" "stat -c %s '$REMOTE_DIR/$NAME'")
REMOTE_SHA=$(ssh "${SSH_OPTS[@]}" "$HOST" "sha256sum '$REMOTE_DIR/$NAME' | cut -d' ' -f1")
echo "  远端字节：$REMOTE_SIZE"
echo "  远端 SHA256：$REMOTE_SHA"
[ "$REMOTE_SIZE" = "$SIZE" ] || { echo "!! 远端字节数与本地不一致，停止"; exit 1; }
[ "$REMOTE_SHA" = "$SHA" ] || { echo "!! 远端 SHA256 与本地不一致，停止"; exit 1; }

echo "=== ③ 合并写回 manifest（保留后台策略，先备份） ==="
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILTER='.version = $version | .publishedAt = $timestamp | .updatedAt = $timestamp | .files = ((.files // {}) | .["win-x64"] = {name: $name, size: $size, sha256: $sha}) | .enabled = (if has("enabled") then .enabled else true end) | .mandatory = (if has("mandatory") then .mandatory else false end) | .minVersion = (if has("minVersion") then .minVersion else "" end) | .note = (if has("note") then .note else "灵动ai创作客户端新版本已发布。" end) | .channel = (if has("channel") then .channel else "stable" end)'
ssh "${SSH_OPTS[@]}" "$HOST" "cd '$REMOTE_DIR' && cp manifest.json manifest.json.bak-$STAMP && jq --arg version '$VERSION' --arg name '$NAME' --arg sha '$SHA' --argjson size '$SIZE' --arg timestamp '$(date -u +%Y-%m-%dT%H:%M:%SZ)' '$FILTER' manifest.json > manifest.json.tmp && mv manifest.json.tmp manifest.json && chown ai-kids-prod:ai-kids-prod manifest.json && cat manifest.json"

echo "=== ④ 核验公网真能下（服务器本机） ==="
ssh "${SSH_OPTS[@]}" "$HOST" "curl -sI -m 20 'https://aicyld.com/downloads/$NAME' | head -5; printf 'manifest 公网：'; curl -s -m 20 'https://aicyld.com/downloads/manifest.json' | head -c 300; echo"
echo "PUBLISH_CLIENT_DONE $NAME"
