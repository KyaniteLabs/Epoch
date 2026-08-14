# Epoch / KyaniteLabs Machine Inventory (Schema Template)

This repository is public: it does not publish the actual fleet inventory —
no hostnames, Tailscale IPs, SSH users, or receiver endpoints. Keep the real
inventory in a private store (password manager, private wiki, or Tailscale
admin console) and inject addresses at runtime via environment variables
(see `scripts/` and `docs/ops/epoch-fleet-audit.md`).

> **History warning for the owner:** the original inventory table (real
> hostnames and Tailscale IPs) was previously committed to this repository.
> Removing it from this file removes it from `HEAD` only — it remains
> retrievable from git history until an explicit, user-approved history purge
> (e.g. `git filter-repo`) rewrites every ref and the remote is force-pushed.
> Do not rewrite history without explicit owner approval.

## Inventory schema

Record one row per machine in your private inventory using this schema:

| Field | Type | Description |
|---|---|---|
| Canonical name | string | Current name used by docs and scripts (e.g. the receiver, the build machine, the production VPS) |
| Address | string | Tailscale IP or hostname; supplied to scripts via env vars, never committed |
| OS | string | Operating system and version |
| Purpose | string | What Epoch/fleet role the machine plays |
| Historical aliases | string[] | Former names, kept for provenance only |

## Naming rule

Old machine labels are historical provenance labels only. Current docs and
scripts must use each machine's canonical name.

## Verification rule

Do not mark a machine healthy unless a fresh live command has been run and
pasted into the current (private) audit report.
