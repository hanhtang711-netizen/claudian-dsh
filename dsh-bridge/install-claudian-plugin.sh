#!/bin/bash
# 安装带 dsh provider 的 Claudian 插件构建产物到 vault。
# 用法: bash install-claudian-plugin.sh [--rollback]
# 备份沿用 vault 惯例: main.js.pre-dsh-YYYYMMDD 等。
set -euo pipefail

VAULT="$(cd "$(dirname "$0")/../../.." && pwd)"          # vault 根目录
PLUGIN_DIR="$VAULT/.obsidian/plugins/realclaudian"
BUILD_DIR="/tmp/claudian-fork"                            # fork 构建目录
STAMP="dsh-$(date +%Y%m%d)"

if [[ "${1:-}" == "--rollback" ]]; then
  LATEST_MAIN=$(ls -t "$PLUGIN_DIR"/main.js.pre-"$STAMP" 2>/dev/null | head -1 || true)
  LATEST_CSS=$(ls -t "$PLUGIN_DIR"/styles.css.pre-"$STAMP" 2>/dev/null | head -1 || true)
  if [[ -z "$LATEST_MAIN" ]]; then
    echo "没有找到 $STAMP 的 main.js 备份，无法回滚。"; exit 1
  fi
  cp "$LATEST_MAIN" "$PLUGIN_DIR/main.js"
  [[ -n "$LATEST_CSS" ]] && cp "$LATEST_CSS" "$PLUGIN_DIR/styles.css"
  echo "已回滚: main.js <- $LATEST_MAIN"
  exit 0
fi

for f in main.js manifest.json styles.css; do
  [[ -f "$BUILD_DIR/$f" ]] || { echo "缺少构建产物: $BUILD_DIR/$f (先跑 npm run build)"; exit 1; }
done

# 语法检查
node --check "$BUILD_DIR/main.js"

# 备份现有文件（含用户既有本地补丁，可随时回滚）
for f in main.js manifest.json styles.css; do
  if [[ -f "$PLUGIN_DIR/$f" ]]; then
    cp -p "$PLUGIN_DIR/$f" "$PLUGIN_DIR/$f.pre-$STAMP"
    echo "备份: $PLUGIN_DIR/$f.pre-$STAMP"
  fi
done

# 安装
for f in main.js manifest.json styles.css; do
  cp "$BUILD_DIR/$f" "$PLUGIN_DIR/$f"
done
node --check "$PLUGIN_DIR/main.js"

echo "安装完成。请在 Obsidian 中禁用再启用 Claudian 插件（或重启 Obsidian）。"
echo "回滚: bash install-claudian-plugin.sh --rollback"
