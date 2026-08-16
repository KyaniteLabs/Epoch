# Epoch Fleet Audit Runbook

## Prerequisites

- SSH access to the fleet machines (addresses are not stored in this public
  repo — export them first):
  ```bash
  export EPOCH_MAC_MINI_HOST="<mac-mini Tailscale IP or hostname>"
  export EPOCH_UBUNTU_RECEIVER_HOST="<receiver Tailscale IP or hostname>"
  ```
- Tailscale connected
- Redact secrets before committing audit output. Audit reports contain live
  fleet topology (hostnames, addresses, ports) and are gitignored — do not
  commit them to this public repo.

## Quick audit

Run the convenience script:

```bash
bash scripts/audit-epoch-fleet.sh
```

Output is written to `docs/ops/audits/epoch-fleet-audit-<timestamp>.md` (gitignored — it contains fleet topology; do not commit it to this public repo).

## Manual Mac mini audit

```bash
# Requires EPOCH_MAC_MINI_HOST (see Prerequisites)
ssh "${EPOCH_MAC_MINI_HOST:?EPOCH_MAC_MINI_HOST not set}" '
set -e
echo "=== identity ==="
hostname
sw_vers 2>/dev/null || true
date
uptime

echo
echo "=== github runner ==="
ls -la "$HOME/github-runner-hermes_vps" 2>/dev/null || true
launchctl list | grep -Ei "github|runner|actions" || true

echo
echo "=== epoch repo candidates ==="
for d in "$HOME/workspaces/kyanite-labs/Epoch" "$HOME/workspaces/Epoch" "$HOME/Epoch"; do
  if [ -d "$d" ]; then
    echo "$d"
    git -C "$d" status --short 2>/dev/null || true
    git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || true
    git -C "$d" rev-parse --short HEAD 2>/dev/null || true
  fi
done

echo
echo "=== epoch data files ==="
find "$HOME/.epoch" -maxdepth 2 -type f -print 2>/dev/null | sort || true

echo
echo "=== epoch cli status ==="
command -v epoch || true
epoch telemetry status 2>/dev/null || true
epoch telemetry preview 2>/dev/null || true
epoch reference-db-status 2>/dev/null || true

echo
echo "=== launchd telemetry ==="
launchctl list | grep -Ei "epoch|telemetry" || true
launchctl print "gui/$(id -u)/com.kyanitelabs.epoch.telemetry-submit" 2>/dev/null || true

echo
echo "=== crontab ==="
crontab -l 2>/dev/null || true

echo
echo "=== factory dashboard port ==="
lsof -nP -iTCP:8420 -sTCP:LISTEN 2>/dev/null || true
curl -fsS http://127.0.0.1:8420 >/dev/null && echo "Factory dashboard local OK" || echo "Factory dashboard local not reachable"
'
```

## Manual Ubuntu receiver audit

```bash
# Requires EPOCH_UBUNTU_RECEIVER_HOST (see Prerequisites)
ssh "${EPOCH_UBUNTU_RECEIVER_HOST:?EPOCH_UBUNTU_RECEIVER_HOST not set}" '
set -e
echo "=== identity ==="
hostname
hostnamectl || true
date
uptime

echo
echo "=== epoch data dirs ==="
find "$HOME/.epoch" -maxdepth 2 -type f -print 2>/dev/null | sort || true
find /root/.epoch -maxdepth 2 -type f -print 2>/dev/null | sort || true

echo
echo "=== epoch cli status ==="
command -v epoch || true
epoch telemetry status 2>/dev/null || true
epoch telemetry preview 2>/dev/null || true
epoch reference-db-status 2>/dev/null || true

echo
echo "=== receiver files ==="
find "$HOME/.epoch" /root/.epoch -maxdepth 1 -type f \
  \( -name "telemetry-records.jsonl" -o -name "telemetry-receipts.jsonl" -o -name "telemetry-record-keys.jsonl" \) \
  -print 2>/dev/null | sort || true

echo
echo "=== systemd units/timers mentioning epoch/telemetry ==="
systemctl list-units --all | grep -Ei "epoch|telemetry" || true
systemctl list-timers --all | grep -Ei "epoch|telemetry" || true

echo
echo "=== listening ports ==="
ss -lntp | grep -E "3099|8420|epoch|node" || true

echo
echo "=== cron ==="
crontab -l 2>/dev/null || true
grep -RniE "epoch|telemetry|receiver" /etc/cron* 2>/dev/null || true
'
```

## Secrets rule

Never commit raw data files. Only commit:
- File counts and status summaries
- Redacted excerpts with secrets removed
- Boolean health indicators
