#!/usr/bin/env bash
# Install the Epoch receiver watchdog as a systemd timer on the receiver host.
set -euo pipefail

WATCHDOG_SOURCE="${1:-$(cd "$(dirname "$0")" && pwd)/epoch-receiver-watchdog.sh}"
WATCHDOG_TARGET="${EPOCH_RECEIVER_WATCHDOG_PATH:-/srv/apps/epoch/bin/epoch-receiver-watchdog.sh}"
SERVICE_PATH="/etc/systemd/system/epoch-receiver-watchdog.service"
TIMER_PATH="/etc/systemd/system/epoch-receiver-watchdog.timer"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "install-epoch-receiver-watchdog: must run as root" >&2
  exit 1
fi

if [[ ! -f "$WATCHDOG_SOURCE" ]]; then
  echo "install-epoch-receiver-watchdog: watchdog script not found: $WATCHDOG_SOURCE" >&2
  exit 1
fi

install -d -m 0755 "$(dirname "$WATCHDOG_TARGET")"
install -m 0755 "$WATCHDOG_SOURCE" "$WATCHDOG_TARGET"

cat >"$SERVICE_PATH" <<UNIT
[Unit]
Description=Epoch receiver watchdog
Wants=network-online.target tailscaled.service docker.service
After=network-online.target tailscaled.service docker.service

[Service]
Type=oneshot
Environment=EPOCH_RECEIVER_PORT=3099
Environment=EPOCH_RECEIVER_TAILNET_HOST=nucbox.tail599928.ts.net
Environment=EPOCH_RECEIVER_DATA_DIR=/srv/data/epoch
Environment=EPOCH_RECEIVER_COMPOSE_DIR=/srv/containers/nucbox/epoch
Environment=EPOCH_RECEIVER_COMPOSE_SERVICE=epoch
Environment=EPOCH_RECEIVER_CONTAINER=nucbox-epoch
Environment=EPOCH_RECEIVER_CLI_PATH=/usr/local/lib/node_modules/@kyanitelabs/epoch/dist/native/epoch-rust-launcher.js
Environment=EPOCH_RECEIVER_INTEGRATE=0
ExecStart=$WATCHDOG_TARGET
User=root
UNIT

cat >"$TIMER_PATH" <<UNIT
[Unit]
Description=Run Epoch receiver watchdog every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now epoch-receiver-watchdog.timer >/dev/null
systemctl start epoch-receiver-watchdog.service
systemctl --no-pager status epoch-receiver-watchdog.timer
