#!/usr/bin/env bash
set -euo pipefail

LABEL="com.yunfeili9363.telegram-codex-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "launchd 服务已卸载：${LABEL}"
