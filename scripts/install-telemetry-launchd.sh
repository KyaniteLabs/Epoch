#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${EPOCH_TELEMETRY_ENDPOINT:-http://100.66.225.85:3099/v1/telemetry}"
INTERVAL_SECONDS="${EPOCH_TELEMETRY_INTERVAL_SECONDS:-3600}"
LABEL="${EPOCH_TELEMETRY_LAUNCHD_LABEL:-com.kyanitelabs.epoch.telemetry-submit}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${EPOCH_NODE_BIN:-$(command -v node)}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.epoch"
LOG_FILE="$LOG_DIR/telemetry-submit.launchd.log"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "node is not executable: $NODE_BIN" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/dist/index.js" ]]; then
  echo "dist/index.js is missing; run pnpm run build in $REPO_DIR first." >&2
  exit 1
fi

"$NODE_BIN" "$REPO_DIR/dist/index.js" telemetry enable --yes --endpoint "$ENDPOINT" >/dev/null

rm -f "$PLIST"
/usr/bin/plutil -create xml1 "$PLIST"
/usr/libexec/PlistBuddy -c "Add :Label string $LABEL" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string /bin/zsh" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string -lc" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:2 string cd '$REPO_DIR' && '$NODE_BIN' dist/index.js telemetry submit >> '$LOG_FILE' 2>&1 || true" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :StartInterval integer $INTERVAL_SECONDS" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $LOG_FILE" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $LOG_FILE" "$PLIST"

uid="$(id -u)"
/bin/launchctl bootout "gui/$uid" "$PLIST" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$uid" "$PLIST"
/bin/launchctl kickstart -k "gui/$uid/$LABEL" >/dev/null 2>&1 || true

echo "Installed $LABEL"
echo "Repo: $REPO_DIR"
echo "Endpoint: $ENDPOINT"
echo "Interval seconds: $INTERVAL_SECONDS"
echo "Log: $LOG_FILE"
