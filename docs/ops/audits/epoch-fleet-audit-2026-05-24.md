# Epoch Fleet Audit — 2026-05-24

## Status

**Not run live.** This audit was prepared during implementation of the data-contribution-and-machine-truth branch. SSH access to the fleet machines was not available during this session.

## Machine map

| Machine | Host | Status |
|---|---:|---|
| mac-mini | 100.115.175.18 | Not audited (SSH unavailable) |
| ubuntu-receiver | 100.113.174.74 | Not audited (SSH unavailable) |

## Next actions

1. Run `bash scripts/audit-epoch-fleet.sh` from a machine with SSH access to both hosts.
2. Redact any secrets from the output.
3. Replace this file with the actual audit output.
4. Verify Epoch CLI is installed and functional on both hosts.
5. Verify telemetry receiver is running on ubuntu-receiver (port 3099).
6. Verify Factory dashboard on mac-mini (port 8420).
7. Verify launchd telemetry submit on mac-mini.

## Commands to run

See `docs/ops/epoch-fleet-audit.md` for the full runbook.
