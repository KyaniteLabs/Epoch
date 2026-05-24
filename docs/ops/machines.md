# Epoch / KyaniteLabs Machine Inventory

| Canonical name | Tailscale IP | OS | Purpose | Historical aliases |
|---|---:|---|---|---|
| ubuntu-receiver | 100.113.174.74 | Ubuntu | Epoch telemetry receiver / former Windows machine | windows-receiver |
| mac-mini | 100.115.175.18 | macOS | Self-hosted runner / Factory dashboard host | Mac mini |
| hermes-vps | 100.92.68.103 | Ubuntu 24.04 | Production Hermes/Kyanite VPS | srv1542844 |

## Naming rule

`windows-receiver` is a historical provenance label only. Current docs and scripts must call the host `ubuntu-receiver`.

## Verification rule

Do not mark a machine healthy unless a fresh live command has been run and pasted into the current audit report.
