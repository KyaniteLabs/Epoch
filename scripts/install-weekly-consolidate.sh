#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install the weekly Epoch consolidation launchd job on the Mac mini.
#
# Usage: bash scripts/install-weekly-consolidate.sh
# ---------------------------------------------------------------------------
set -euo pipefail

PLIST_NAME="com.kyanitelabs.epoch.weekly-consolidate"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$PLIST_NAME.plist"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/weekly-consolidate.sh"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.epoch"

# Fleet SSH targets and addresses are not stored in this public repo.
# They are baked into the launchd job from the environment at install time.
: "${EPOCH_NUC_HOST:?EPOCH_NUC_HOST must be set (user@host for the receiver)}"
: "${EPOCH_LAPTOP_HOST:?EPOCH_LAPTOP_HOST must be set (Tailscale IP or hostname)}"

echo "Installing $PLIST_NAME..."
echo "  Script: $SCRIPT_PATH"
echo "  Repo:   $REPO_DIR"
echo "  Log:    $LOG_DIR/consolidate.log"

# Make script executable
chmod +x "$SCRIPT_PATH"

# Create plist
mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${PLIST_NAME}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/zsh</string>
		<string>-lc</string>
		<string>EPOCH_REPO_DIR="${REPO_DIR}" EPOCH_NUC_HOST="${EPOCH_NUC_HOST}" EPOCH_LAPTOP_HOST="${EPOCH_LAPTOP_HOST}" bash "${SCRIPT_PATH}" &gt;&gt; "${LOG_DIR}/consolidate.log" 2&gt;&amp;1 || true</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Weekday</key>
		<integer>1</integer>
		<key>Hour</key>
		<integer>3</integer>
		<key>Minute</key>
		<integer>0</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>${LOG_DIR}/consolidate.log</string>
	<key>StandardErrorPath</key>
	<string>${LOG_DIR}/consolidate.log</string>
	<key>RunAtLoad</key>
	<false/>
</dict>
</plist>
PLIST

# Unload old version if exists
launchctl unload "$PLIST_PATH" 2>/dev/null || true

# Load
launchctl load "$PLIST_PATH"

echo ""
echo "Installed. Runs every Monday at 3 AM."
echo ""
echo "To test now:    launchctl start $PLIST_NAME"
echo "To view log:    tail -f $LOG_DIR/consolidate.log"
echo "To uninstall:   launchctl unload $PLIST_PATH && rm $PLIST_PATH"
echo ""
launchctl list | grep "$PLIST_NAME" || echo "(loaded but not yet run — scheduled for next Monday)"
