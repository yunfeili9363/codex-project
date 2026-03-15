#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.yunfeili9363.telegram-codex-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "未找到 node，请先确认 Node.js 已安装并可执行。"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$ROOT_DIR/logs"

cd "$ROOT_DIR"
npm run build

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${ROOT_DIR}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${ROOT_DIR}/logs/bridge.out.log</string>
    <key>StandardErrorPath</key>
    <string>${ROOT_DIR}/logs/bridge.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
  </dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/${LABEL}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "launchd 服务已安装并启动：${LABEL}"
echo "查看状态：launchctl print gui/$(id -u)/${LABEL}"
echo "日志目录：${ROOT_DIR}/logs"
