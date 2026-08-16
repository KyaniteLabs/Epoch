# Epoch Receiver Watchdog

The Epoch receiver host (internal hostnames are not stored in this public
repo; set `EPOCH_RECEIVER_TAILNET_HOST` from your private inventory) is
intentionally bound to localhost by Docker:

```text
127.0.0.1:3099 -> <receiver-container>:3099
```

Tailnet access is provided by Tailscale Serve:

```text
https://${EPOCH_RECEIVER_TAILNET_HOST}:3099 -> http://127.0.0.1:3099
```

`scripts/epoch-receiver-watchdog.sh` keeps that contract healthy without
printing raw telemetry. It checks local receiver health, tailnet health,
Tailscale Serve config, receiver record counts, and reference DB metadata. If
the container is down it restarts the Epoch compose service. If localhost is
healthy but tailnet health or Serve config is broken, it reapplies the Serve
mapping for port `3099`.

## Installed Receiver Units

```bash
systemctl status epoch-receiver-watchdog.timer
systemctl status epoch-receiver-watchdog.service
journalctl -u epoch-receiver-watchdog.service -n 80 --no-pager
```

The timer runs every 5 minutes. The latest aggregate-only status is written to:

```text
/srv/data/epoch/receiver-watchdog-status.json
/srv/data/epoch/receiver-watchdog-state.json
```

## Manual Install

Run as root on the receiver host:

```bash
bash scripts/install-epoch-receiver-watchdog.sh
```

From a workstation, copy the repo scripts to the receiver first, then run the
installer with the copied watchdog path.

## Verification

```bash
curl -fsS http://127.0.0.1:3099/health
curl -fsS "https://${EPOCH_RECEIVER_TAILNET_HOST:?}:3099/health"
tailscale serve status --json
cat /srv/data/epoch/receiver-watchdog-status.json
```

Expected health response:

```json
{"status":"ok","version":"0.2.9","tools":24}
```

## Integration Policy

The watchdog defaults `EPOCH_RECEIVER_INTEGRATE=0`. Receiver-side
self-improvement is deliberately left to the weekly telemetry integration pass
because the current `self-improve` path consumes the whole receiver JSONL file.
This avoids repeatedly inflating `sampleSize` during frequent uptime checks.

To run a one-off receiver integration through the watchdog:

```bash
EPOCH_RECEIVER_INTEGRATE=1 /srv/apps/epoch/bin/epoch-receiver-watchdog.sh
```

Only do this when the weekly integration state says new receiver records need
to be incorporated.
