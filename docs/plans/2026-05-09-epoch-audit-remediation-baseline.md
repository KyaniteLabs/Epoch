# Epoch Audit Remediation Baseline

> Historical archive: this captured the dirty working tree before the May 9, 2026
> remediation run. It is not current release state; use
> `docs/plans/2026-05-09-epoch-audit-remediation-report.md` and `README.md`
> for current verification truth.

- Branch: audit-remediation-2026-05-09
- Base commit: 29fbadb Add MCP Registry links and fix stale package reference

## Dirty files
```
 M docs/TELEMETRY.md
 M src/entries/cli.test.ts
 M src/entries/cli.ts
 M src/lib/telemetry-receiver.test.ts
 M src/lib/telemetry-receiver.ts
?? docs/plans/
?? scripts/backfill-telemetry.mjs
?? scripts/configure-mac-mini-telemetry.sh
?? scripts/install-telemetry-launchd.sh
```

## Diff stat
```
 docs/TELEMETRY.md                  | 12 +++++--
 src/entries/cli.test.ts            | 15 ++++++++
 src/entries/cli.ts                 | 14 ++++++--
 src/lib/telemetry-receiver.test.ts | 40 ++++++++++++++++++++-
 src/lib/telemetry-receiver.ts      | 71 ++++++++++++++++++++++++++++++++++----
 5 files changed, 139 insertions(+), 13 deletions(-)
```

## Diff name-status
```
M	docs/TELEMETRY.md
M	src/entries/cli.test.ts
M	src/entries/cli.ts
M	src/lib/telemetry-receiver.test.ts
M	src/lib/telemetry-receiver.ts
```

## Existing failing gates
- Expected from audit: pnpm test fails on HTTP telemetry dedupe test; pnpm run lint fails on existing lint baseline.
