#!/usr/bin/env bash
# 把新打出来的客户端安装包发布出去（2026-09-19；2026-11-02 增补 macOS Intel）。
#
# 用法：
#   bash deploy/publish-client.sh <Windows 安装包> <macOS arm64 DMG> <macOS x64 DMG> [--dry-run]
#   bash deploy/publish-client.sh <安装包> --single-platform [--dry-run]
#
# 正式发布必须一次传三个包：win-x64、mac-arm64、mac-x64。清单顶层 version 只有一个，
# 三端必须同版本；脚本会先把三个包全部上传并核对大小/SHA256，最后只原子写一次
# manifest.json。任意一个包失败都不会切换清单。
#
# 单平台发布（--single-platform）：只用于恢复/应急。本模式会更新一个平台，并在同一次
# 原子写里移除另外两个平台的条目（旧平台客户端只会看到"本平台暂无更新"，不会被推错包）。
# 单平台恢复后，下一次正式发布仍必须传齐三个包。
#
# 支持：
#   lingdong-client-<版本>-win-x64.exe
#   lingdong-client-<版本>-mac-arm64.dmg
#   lingdong-client-<版本>-mac-x64.dmg
# 也接受构建产物名（带 -unsigned 后缀），脚本会在上传前归一化成上面的规范名，
# 因此平台上传口的严格正则不需要放宽。
#
# 旧的普通双平台发布模式已移除：两个包无法证明第三个平台也是同一版本，容易把旧包
# 伪装成新版本。正式发布传三个包，单平台恢复显式加 --single-platform。
set -euo pipefail

KEY="${PUBLISH_CLIENT_SSH_KEY:-$HOME/.ssh/ai_kids_platform_ecs_temp_ed25519}"
# 默认走稳定域名；服务器换 IP 不改脚本。accept-new 首次固定主机 key，后续 key 变化仍会拒绝。
HOST="${PUBLISH_CLIENT_HOST:-root@aicyld.com}"
REMOTE_DIR="/srv/ai-kids-platform/downloads"
KNOWN_HOSTS="${PUBLISH_CLIENT_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KNOWN_HOSTS")
DRY=0
SINGLE=0

file_size() {
  if stat -c %s "$1" >/dev/null 2>&1; then stat -c %s "$1"; else stat -f %z "$1"; fi
}
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    # Windows Git Bash 传入反斜杠路径时，GNU sha256sum 会为了转义文件名给整行加 `\` 前缀；
    # manifest 只接受 64 位十六进制，因此这里剥掉该前缀，避免本地校验值污染发布清单。
    sha256sum "$1" | cut -d' ' -f1 | sed 's/^\\//'
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
# 安装包文件名 → 目标平台。构建产物可能带 `-unsigned` 后缀（未签名包），这里一并接受，
# 发布时再由 canonical_artifact_name 归一化成平台上传口只认的规范名。
artifact_target() {
  case "$1" in
    lingdong-client-*-win-x64.exe | lingdong-client-*-win-x64-unsigned.exe) echo win-x64 ;;
    lingdong-client-*-mac-arm64.dmg | lingdong-client-*-mac-arm64-unsigned.dmg) echo mac-arm64 ;;
    lingdong-client-*-mac-x64.dmg | lingdong-client-*-mac-x64-unsigned.dmg) echo mac-x64 ;;
    *) return 1 ;;
  esac
}
artifact_version() {
  case "$1" in
    lingdong-client-*-win-x64.exe | lingdong-client-*-win-x64-unsigned.exe) sed -E 's/^lingdong-client-(.*)-win-x64(-unsigned)?\.exe$/\1/' <<<"$1" ;;
    lingdong-client-*-mac-arm64.dmg | lingdong-client-*-mac-arm64-unsigned.dmg) sed -E 's/^lingdong-client-(.*)-mac-arm64(-unsigned)?\.dmg$/\1/' <<<"$1" ;;
    lingdong-client-*-mac-x64.dmg | lingdong-client-*-mac-x64-unsigned.dmg) sed -E 's/^lingdong-client-(.*)-mac-x64(-unsigned)?\.dmg$/\1/' <<<"$1" ;;
    *) return 1 ;;
  esac
}
# 规范名：写进 manifest、上传到平台的文件名（去掉 -unsigned 等构建后缀）。
canonical_artifact_name() {
  case "$1" in
    win-x64) echo "lingdong-client-${2}-win-x64.exe" ;;
    mac-arm64) echo "lingdong-client-${2}-mac-arm64.dmg" ;;
    mac-x64) echo "lingdong-client-${2}-mac-x64.dmg" ;;
    *) return 1 ;;
  esac
}
other_targets() {
  for target in win-x64 mac-arm64 mac-x64; do
    [ "$target" != "$1" ] && echo "$target"
  done
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

if [ "${#ARTIFACTS[@]}" -lt 1 ] || [ "${#ARTIFACTS[@]}" -gt 3 ]; then
  echo "用法：bash $0 <Windows x64> <macOS arm64> <macOS x64> [--dry-run]"
  echo "      bash $0 <安装包> --single-platform [--dry-run]"
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
  canonical="$(canonical_artifact_name "$target" "$version")"
  if [ "$name" != "$canonical" ]; then
    echo "[规范名] ${name} → ${canonical}（上传/写 manifest 用规范名）"
    name="$canonical"
  fi
  NAMES+=("$name"); TARGETS+=("$target"); VERSIONS+=("$version")
  SIZES+=("$(file_size "$artifact")"); SHAS+=("$(file_sha256 "$artifact")")
done

if [ "$SINGLE" = "1" ] && [ "${#ARTIFACTS[@]}" -ne 1 ]; then
  echo "!! --single-platform 只能传一个安装包"
  exit 2
fi

if [ "$SINGLE" != "1" ] && [ "${#ARTIFACTS[@]}" -ne 3 ]; then
  echo "!! 正式发布必须一次传齐 win-x64 / mac-arm64 / mac-x64 三个安装包"
  echo "   只发一个平台请显式加 --single-platform；旧的普通双平台模式已移除。"
  exit 2
fi

if [ "${#ARTIFACTS[@]}" -eq 3 ]; then
  unique_targets=$(printf '%s\n' "${TARGETS[@]}" | sort -u | wc -l | tr -d ' ')
  [ "$unique_targets" = "3" ] || { echo "!! 三个安装包必须分别对应 win-x64 / mac-arm64 / mac-x64"; exit 2; }
  for index in 1 2; do
    [ "${VERSIONS[$index]}" = "${VERSIONS[0]}" ] || {
      echo "!! 三个平台必须同版本发布：${VERSIONS[0]} / ${VERSIONS[1]} / ${VERSIONS[2]}"
      exit 2
    }
  done
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

echo "=== ③ 一次原子写回 manifest（保留后台策略，先备份） ==="
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILTER=".version = \$version0 | .publishedAt = \$timestamp | .updatedAt = \$timestamp | .files = (.files // {})"
JQ_ARGS=(--arg version0 "${VERSIONS[0]}" --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
for index in "${!ARTIFACTS[@]}"; do
  FILTER="$FILTER | .files[\"${TARGETS[$index]}\"] = {version: \$version$index, name: \$name$index, size: \$size$index, sha256: \$sha$index}"
  JQ_ARGS+=(--arg "version$index" "${VERSIONS[$index]}" --arg "name$index" "${NAMES[$index]}" --arg "sha$index" "${SHAS[$index]}" --argjson "size$index" "${SIZES[$index]}")
done
if [ "$SINGLE" = "1" ]; then
  while IFS= read -r other; do
    FILTER="$FILTER | del(.files[\"$other\"])"
    echo "[single-platform] 将移除 $other 条目（本次只发 ${TARGETS[0]}）"
  done < <(other_targets "${TARGETS[0]}")
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