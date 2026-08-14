#!/usr/bin/env bash
set -euo pipefail

# Fleet addresses are not stored in this public repo.
# Set EPOCH_MAC_MINI_HOST / EPOCH_UBUNTU_RECEIVER_HOST (Tailscale IP or hostname) before running.
MAC_HOST="${EPOCH_MAC_MINI_HOST:?EPOCH_MAC_MINI_HOST must be set (Tailscale IP or hostname)}"
UBUNTU_HOST="${EPOCH_UBUNTU_RECEIVER_HOST:?EPOCH_UBUNTU_RECEIVER_HOST must be set (Tailscale IP or hostname)}"
SSH_USER="${EPOCH_SSH_USER:-}"
SSH_PREFIX=""
if [[ -n "$SSH_USER" ]]; then
  SSH_PREFIX="$SSH_USER@"
fi

OUT_DIR="${EPOCH_AUDIT_OUT_DIR:-docs/ops/audits}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/epoch-fleet-audit-$STAMP.md"

{
  echo "# Epoch Fleet Audit — $STAMP"
  echo
  echo "## Machine map"
  echo
  echo "| Machine | Host |"
  echo "|---|---:|"
  echo "| mac-mini | $MAC_HOST |"
  echo "| ubuntu-receiver | $UBUNTU_HOST |"
  echo
  echo "## Mac mini"
  echo '```text'
  ssh "${SSH_PREFIX}${MAC_HOST}" 'hostname; date; uptime; launchctl list | grep -Ei "github|runner|actions|epoch|telemetry" || true; find "$HOME/.epoch" -maxdepth 2 -type f -print 2>/dev/null | sort || true; epoch telemetry status 2>/dev/null || true; epoch reference-db-status 2>/dev/null || true' 2>&1 || echo "(connection failed)"
  echo '```'
  echo
  echo "## Ubuntu receiver"
  echo '```text'
  ssh "${SSH_PREFIX}${UBUNTU_HOST}" 'hostnamectl || true; date; uptime; find "$HOME/.epoch" /root/.epoch -maxdepth 2 -type f -print 2>/dev/null | sort || true; epoch telemetry status 2>/dev/null || true; epoch reference-db-status 2>/dev/null || true; systemctl list-units --all | grep -Ei "epoch|telemetry" || true; ss -lntp | grep -E "3099|epoch|node" || true' 2>&1 || echo "(connection failed)"
  echo '```'
} > "$OUT"

echo "$OUT"
