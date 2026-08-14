#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Epoch — Fleet bootstrap helper
#
# Installs/configures one machine as an Epoch telemetry participant using the
# same CLI invocation pattern everywhere. The npm-generated `epoch` shim can be
# unreliable in non-interactive contexts on some hosts, so jobs call the package
# dist entrypoint via node directly.
#
# Usage:
#   bash scripts/epoch-fleet-bootstrap.sh sender
#   bash scripts/epoch-fleet-bootstrap.sh mac-consolidator
#   bash scripts/epoch-fleet-bootstrap.sh receiver
#
# Environment:
#   EPOCH_TELEMETRY_ENDPOINT  required (telemetry receiver URL; fleet
#                             endpoints are not stored in this public repo)
#   EPOCH_RECEIVER_PORT       default: 3099
#   EPOCH_PACKAGE_VERSION     default: 0.2.7
# ---------------------------------------------------------------------------
set -euo pipefail

ROLE="${1:-sender}"
VERSION="${EPOCH_PACKAGE_VERSION:-0.2.7}"
# Fleet endpoints are not stored in this public repo.
ENDPOINT="${EPOCH_TELEMETRY_ENDPOINT:?EPOCH_TELEMETRY_ENDPOINT must be set (telemetry receiver URL)}"
PORT="${EPOCH_RECEIVER_PORT:-3099}"
OS="$(uname -s)"

log() { printf '[epoch-fleet-bootstrap] %s\n' "$*"; }

ensure_epoch_package() {
  if [ "$OS" = "Darwin" ]; then
    export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
  fi
  if ! command -v npm >/dev/null 2>&1; then
    log "FAIL: npm not found. Install Node >=20 first."
    exit 1
  fi
  npm install -g "@kyanitelabs/epoch@$VERSION"
}

node_bin() {
  if [ "$OS" = "Darwin" ] && [ -x /opt/homebrew/bin/node ]; then
    echo /opt/homebrew/bin/node
  elif [ -x /usr/local/bin/node ]; then
    echo /usr/local/bin/node
  else
    command -v node
  fi
}

cli_path() {
  if [ "$OS" = "Darwin" ]; then
    if [ -f /opt/homebrew/lib/node_modules/@kyanitelabs/epoch/dist/index.js ]; then
      echo /opt/homebrew/lib/node_modules/@kyanitelabs/epoch/dist/index.js
      return
    fi
    if [ -f /usr/local/lib/node_modules/@kyanitelabs/epoch/dist/index.js ]; then
      echo /usr/local/lib/node_modules/@kyanitelabs/epoch/dist/index.js
      return
    fi
  fi
  if [ -f /usr/local/lib/node_modules/@kyanitelabs/epoch/dist/index.js ]; then
    echo /usr/local/lib/node_modules/@kyanitelabs/epoch/dist/index.js
    return
  fi
  local root
  root="$(npm root -g)"
  echo "$root/@kyanitelabs/epoch/dist/index.js"
}

install_macos_sender() {
  local node cli plist
  node="$(node_bin)"
  cli="$(cli_path)"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.epoch"
  "$node" "$cli" telemetry enable --yes --endpoint "$ENDPOINT"
  plist="$HOME/Library/LaunchAgents/com.kyanitelabs.epoch.telemetry-submit.plist"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.kyanitelabs.epoch.telemetry-submit</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>EPOCH_TELEMETRY_SUBMIT_INTERVAL_HOURS=0 $node $cli telemetry submit --endpoint $ENDPOINT &gt;&gt; $HOME/.epoch/telemetry-submit.launchd.log 2&gt;&amp;1 || true</string></array>
<key>StartInterval</key><integer>3600</integer><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>$HOME/.epoch/telemetry-submit.launchd.log</string>
<key>StandardErrorPath</key><string>$HOME/.epoch/telemetry-submit.launchd.log</string>
</dict></plist>
PLIST
  launchctl unload "$plist" >/dev/null 2>&1 || true
  launchctl load "$plist"
  launchctl start com.kyanitelabs.epoch.telemetry-submit || true
  "$node" "$cli" telemetry status
}

install_systemd_sender() {
  local node cli
  node="$(node_bin)"
  cli="$(cli_path)"
  mkdir -p "$HOME/.epoch"
  "$node" "$cli" telemetry enable --yes --endpoint "$ENDPOINT"
  if [ "$(id -u)" -ne 0 ]; then
    log "FAIL: systemd sender install must run as root on Linux hosts."
    exit 1
  fi
  cat >/etc/systemd/system/epoch-telemetry-submit.service <<UNIT
[Unit]
Description=Submit Epoch anonymous telemetry
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=EPOCH_TELEMETRY_SUBMIT_INTERVAL_HOURS=0
ExecStart=$node $cli telemetry submit --endpoint $ENDPOINT
SuccessExitStatus=0 1
User=root
UNIT
  cat >/etc/systemd/system/epoch-telemetry-submit.timer <<UNIT
[Unit]
Description=Hourly Epoch telemetry submit

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now epoch-telemetry-submit.timer >/dev/null
  systemctl restart epoch-telemetry-submit.service || true
  "$node" "$cli" telemetry status
}

install_receiver_container() {
  if [ "$(id -u)" -ne 0 ]; then
    log "FAIL: receiver install must run as root."
    exit 1
  fi
  command -v docker >/dev/null 2>&1 || {
    log "FAIL: docker not found"
    exit 1
  }
  # Container paths/names are env-configurable; internal hostnames are not
  # stored in this public repo (defaults use a neutral prefix).
  local compose_dir="${EPOCH_RECEIVER_COMPOSE_DIR:-/srv/containers/epoch}"
  local container_name="${EPOCH_RECEIVER_CONTAINER:-epoch-http}"
  mkdir -p /srv/apps/epoch "$compose_dir" /srv/data/epoch
  cat >/srv/apps/epoch/Dockerfile <<DOCKER
FROM node:22-bookworm-slim
RUN npm install -g @kyanitelabs/epoch@$VERSION
ENV EPOCH_TRANSPORT=http \\
    EPOCH_HOST=0.0.0.0 \\
    EPOCH_PORT=$PORT \\
    HOME=/home/node
USER node
CMD ["node", "/usr/local/lib/node_modules/@kyanitelabs/epoch/dist/index.js"]
DOCKER
  cat >"$compose_dir/docker-compose.yml" <<YAML
name: $container_name
services:
  epoch:
    build:
      context: /srv/apps/epoch
      dockerfile: Dockerfile
    image: epoch-http:$VERSION
    container_name: $container_name
    restart: unless-stopped
    environment:
      EPOCH_TRANSPORT: http
      EPOCH_HOST: 0.0.0.0
      EPOCH_PORT: "$PORT"
      HOME: /home/node
      TZ: America/Los_Angeles
    ports:
      - "127.0.0.1:$PORT:$PORT"
    volumes:
      - /srv/data/epoch:/home/node/.epoch
YAML
  (cd "$compose_dir" && docker compose up -d --build)
  curl -fsS "http://127.0.0.1:$PORT/health"
  printf '\n'
  local script_dir
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  if [ -x "$script_dir/install-epoch-receiver-watchdog.sh" ]; then
    bash "$script_dir/install-epoch-receiver-watchdog.sh" "$script_dir/epoch-receiver-watchdog.sh"
  fi
}

ensure_epoch_package
case "$ROLE" in
sender)
  if [ "$OS" = "Darwin" ]; then install_macos_sender; else install_systemd_sender; fi
  ;;
mac-consolidator)
  [ "$OS" = "Darwin" ] || {
    log "FAIL: mac-consolidator role requires macOS"
    exit 1
  }
  install_macos_sender
  bash "$(cd "$(dirname "$0")" && pwd)/install-weekly-consolidate.sh"
  ;;
receiver)
  install_systemd_sender
  install_receiver_container
  ;;
*)
  log "FAIL: unknown role '$ROLE'"
  exit 1
  ;;
esac
