#!/usr/bin/env bash
# 把新打出来的客户端安装包发布出去（2026-09-19；2026-09-27 增补 macOS）。
#
# 用法：
#   bash deploy/publish-client.sh <安装包> [--dry-run]
#   bash deploy/publish-client.sh <Windows 安装包> <macOS DMG> [--dry-run]
#   bash deploy/publish-client.sh <Windows 安装包> --single-platform [--dry-run]
#
# 单平台发布（--single-platform）：本次只发一个平台时使用。清单顶层 version 只有一个，
# 另一平台仍是旧版本会造成"顶层说新、该平台文件却是旧包"的坏更新，因此本模式会
# **移除另一平台的条目**（对方客户端只会看到"本平台暂无更新"，不会被推错包），
# 并在输出里明确提示。等另一平台出包后，用双包一次发布即可恢复正常。
#
# 支持：
#   lingdong-client-<版本>-win-x64.exe
#   lingdong-client-<版本>-mac-arm64.dmg
#
# 为什么单平台发布要拦一道：平台清单目前只有一个顶层 manifest.version。若
# Win/Mac 条目版本不一致，旧客户端会拿顶层新版本去下载本平台旧包，直接更新失败。
# 因此双端必须同版本；一次传两个包会先全部上传校验，再原子写一次 manifest。
set -euo pipefail

KEY="${PUBLISH_CLIENT_SSH_KEY:-$HOME/.ssh/ai_kids_platform_ecs_temp_ed25519}"
HOST="${PUBLISH_CLIENT_HOST:-root@8.134.80.184}"
REMOTE_DIR="/srv/ai-kids-platform/downloads"
KNOWN_HOSTS="${PUBLISH_CLIENT_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS")
DRY=0
SINGLE=0

file_size() {
  if stat -c %s "$1" >/dev/null 2>&1; then stat -c %s "$1"; else stat -f %z "$1"; fi
}
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
artifact_version() {
  case "$1" in
    lingdong-client-*-win-x64.exe) sed -E 's/^lingdong-client-(.*)-win-x64(-unsigned)?\.exe$/\1/' <<<"$1" ;;
    lingdong-client-*-mac-arm64.dmg) sed -E 's/^lingdong-client-(.*)-mac-arm64\.dmg$/\1/' <<<"$1" ;;
    *) return 1 ;;
  esac
}
artifact_target() {
  case "$1" in
    lingdong-client-*-win-x64.exe) echo win-x64 ;;
    lingdong-client-*-mac-arm64.dmg) echo mac-arm64 ;;
    *) return 1 ;;
  esac
}
other_target() {
  [ "$1" = "win-x64" ] && echo mac-arm64 || echo win-x64
}

ARTIFACTS=()
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY=1 ;;
    --single-platform) SINGLE=1 ;;
    -*) echo "未知参数：$argument"; exit 2 ;;
    *) ARTIFACTS+=("$argument") ;;
  esac
done

if [ "${#ARTIFACTS[@]}" -lt 1 ] || [ "${#ARTIFACTS[@]}" -gt 2 ]; then
  echo "用法：bash $0 <安装包> [--dry-run]"
  echo "      bash $0 <Windows 安装包> <macOS DMG> [--dry-run]"
  exit 2
fi

NAMES=(); TARGETS=(); VERSIONS=(); SIZES=(); SHAS=()
for artifact in "${ARTIFACTS[@]}"; do
  [ -f "$artifact" ] || { echo "!! 文件不存在：$artifact"; exit 2; }
  name="$(basename "$artifact")"
  target="$(artifact_target "$name" || true)"
  version="$(artifact_version "$name" || true)"
  [ -n "$target" ] || { echo "!! 安装包文件名不符合契约：$name"; exit 2; }
  case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "!! 从文件名解析出的版本号不合法：${version}（文件名 ${name}）"; exit 2 ;;
  esac
  NAMES+=("$name"); TARGETS+=("$target"); VERSIONS+=("$version")
  SIZES+=("$(file_size "$artifact")"); SHAS+=("$(file_sha256 "$artifact")")
done

if [ "${#ARTIFACTS[@]}" -eq 2 ] && [ "$SINGLE" = "1" ]; then
  echo "!! --single-platform 只能传一个安装包"
  exit 2
fi

if [ "${#ARTIFACTS[@]}" -eq 2 ]; then
  [ "${TARGETS[0]}" != "${TARGETS[1]}" ] || { echo "!! 两个安装包目标不能相同：${TARGETS[0]}"; exit 2; }
  [ "${VERSIONS[0]}" = "${VERSIONS[1]}" ] || {
    echo "!! Windows 与 macOS 必须同版本发布：${VERSIONS[0]} / ${VERSIONS[1]}"
    exit 2
  }
fi

echo "待发布："
for index in "${!ARTIFACTS[@]}"; do
  echo "  ${TARGETS[$index]} / ${VERSIONS[$index]} / ${SIZES[$index]} 字节 / ${SHAS[$index]}"
  echo "  ${NAMES[$index]}"
done
if [ "$DRY" = "1" ]; then echo "（--dry-run：到此为止，什么都没传）"; exit 0; fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "!! 客户端仓库有未提交改动，停止发布"; exit 1; }

REMOTE_VERSION=$(ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "$HOST" "jq -r '.version // \"\"' '$REMOTE_DIR/manifest.json'")
for index in "${!ARTIFACTS[@]}"; do
  target="${TARGETS[$index]}"
  name="${NAMES[$index]}"
  remote_name=$(ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "$HOST" "jq -r --arg target '$target' '.files[\$target].name // \"\"' '$REMOTE_DIR/manifest.json'")
  if [ "$remote_name" = "$name" ] && [ "${ALLOW_SAME_VERSION_REPUBLISH:-}" != "1" ]; then
    echo "!! manifest 里 ${target} 已经是 ${name}；请升版本号，或显式设置 ALLOW_SAME_VERSION_REPUBLISH=1"
    exit 1
  fi
done

if [ "${#ARTIFACTS[@]}" -eq 1 ] && [ "$SINGLE" != "1" ]; then
  target="${TARGETS[0]}"
  version="${VERSIONS[0]}"
  other="$(other_target "$target")"
  other_name=$(ssh "${SSH_OPTS[@]}" -o ConnectTimeout=10 "$HOST" "jq -r --arg target '$other' '.files[\$target].name // \"\"' '$REMOTE_DIR/manifest.json'")
  if [ -n "$other_name" ]; then
    other_version="$(artifact_version "$other_name" || true)"
    if [ "$other_version" != "$version" ]; then
      echo "!! 平台清单两端版本不一致：${target}=${version}，${other}=${other_version}"
      echo "   平台顶层的 manifest.version 只有一个；请把 Windows 与 macOS 两个包一次性传给本脚本。"
      exit 1
    fi
  fi
fi

echo "=== ① 上传到 ${REMOTE_DIR}（发布目录之外，换代不冲） ==="
for index in "${!ARTIFACTS[@]}"; do
  scp "${SSH_OPTS[@]}" "${ARTIFACTS[$index]}" "$HOST:$REMOTE_DIR/${NAMES[$index]}"
done

echo "=== ② 服务器上核对每个包的字节数与 SHA256 ==="
for index in "${!ARTIFACTS[@]}"; do
  name="${NAMES[$index]}"
  remote_size=$(ssh "${SSH_OPTS[@]}" "$HOST" "stat -c %s '$REMOTE_DIR/$name'")
  remote_sha=$(ssh "${SSH_OPTS[@]}" "$HOST" "sha256sum '$REMOTE_DIR/$name' | cut -d' ' -f1")
  echo "  ${name}：${remote_size} 字节 / ${remote_sha}"
  [ "$remote_size" = "${SIZES[$index]}" ] || { echo "!! $name 远端字节数与本地不一致，停止"; exit 1; }
  [ "$remote_sha" = "${SHAS[$index]}" ] || { echo "!! $name 远端 SHA256 与本地不一致，停止"; exit 1; }
done

echo "=== ③ 一次原子写回 manifest（保留另一平台和后台策略，先备份） ==="
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILTER=".version = \$version0 | .publishedAt = \$timestamp | .updatedAt = \$timestamp | .files = (.files // {})"
JQ_ARGS=(--arg version0 "${VERSIONS[0]}" --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
for index in "${!ARTIFACTS[@]}"; do
  FILTER="$FILTER | .files[\"${TARGETS[$index]}\"] = {version: \$version$index, name: \$name$index, size: \$size$index, sha256: \$sha$index}"
  JQ_ARGS+=(--arg "version$index" "${VERSIONS[$index]}" --arg "name$index" "${NAMES[$index]}" --arg "sha$index" "${SHAS[$index]}" --argjson "size$index" "${SIZES[$index]}")
done
if [ "$SINGLE" = "1" ]; then
  other="$(other_target "${TARGETS[0]}")"
  FILTER="$FILTER | del(.files[\"$other\"])"
  echo "[single-platform] 将移除 $other 条目（本次只发 ${TARGETS[0]}）"
fi
FILTER="$FILTER | .enabled = (if has(\"enabled\") then .enabled else true end) | .mandatory = (if has(\"mandatory\") then .mandatory else false end) | .minVersion = (if has(\"minVersion\") then .minVersion else \"\" end) | .note = (if has(\"note\") then .note else \"灵动ai创作客户端新版本已发布。\" end) | .channel = (if has(\"channel\") then .channel else \"stable\" end)"

JQ_ARGS_TEXT=""
for argument in "${JQ_ARGS[@]}"; do
  printf -v quoted '%q' "$argument"
  JQ_ARGS_TEXT="$JQ_ARGS_TEXT $quoted"
done
ssh "${SSH_OPTS[@]}" "$HOST" "cd '$REMOTE_DIR' && cp manifest.json manifest.json.bak-$STAMP && jq $JQ_ARGS_TEXT '$FILTER' manifest.json > manifest.json.tmp && mv manifest.json.tmp manifest.json && chown ai-kids-prod:ai-kids-prod manifest.json && cat manifest.json"

echo "=== ④ 核验公网真能下（服务器本机） ==="
for name in "${NAMES[@]}"; do
  ssh "${SSH_OPTS[@]}" "$HOST" "curl -sI -m 20 'https://aicyld.com/downloads/$name' | head -5"
done
ssh "${SSH_OPTS[@]}" "$HOST" "printf 'manifest 公网：'; curl -s -m 20 'https://aicyld.com/downloads/manifest.json' | head -c 500; echo"
echo "PUBLISH_CLIENT_DONE ${NAMES[*]}"