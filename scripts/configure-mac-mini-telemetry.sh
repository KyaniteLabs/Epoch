#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" || "${EPOCH_DRY_RUN:-}" == "1" ]]; then
  DRY_RUN=1
fi

if [[ "$DRY_RUN" != "1" && "${EPOCH_CONFIRM_OPS:-}" != "1" ]]; then
  cat >&2 <<'MSG'
This operational script changes local Epoch telemetry configuration and submits queued telemetry.
Review the endpoint first, then rerun with EPOCH_CONFIRM_OPS=1.
Use --dry-run to inspect the resolved checkout and endpoint without changing anything.
MSG
  exit 1
fi

ENDPOINT="${EPOCH_TELEMETRY_ENDPOINT:-}"
if [[ -z "$ENDPOINT" ]]; then
  echo "Set EPOCH_TELEMETRY_ENDPOINT to the telemetry receiver URL before running this script." >&2
  exit 1
fi

candidate_dirs=(
  "$HOME/workspaces/kyanite-labs/Epoch"
  "$HOME/workspaces/Epoch"
  "$HOME/Epoch"
)

repo=""
for dir in "${candidate_dirs[@]}"; do
  if [[ -f "$dir/package.json" ]] && grep -q '"@kyanitelabs/epoch"' "$dir/package.json"; then
    repo="$dir"
    break
  fi
done

if [[ -z "$repo" ]]; then
  while IFS= read -r dir; do
    if [[ -f "$dir/package.json" ]] && grep -q '"@kyanitelabs/epoch"' "$dir/package.json"; then
      repo="$dir"
      break
    fi
  done < <(find "$HOME" -maxdepth 6 -type d -name Epoch 2>/dev/null)
fi

if [[ -z "$repo" ]]; then
  echo "Could not find an Epoch checkout under $HOME."
  echo "Clone Epoch first, then rerun this script."
  exit 1
fi

cd "$repo"
echo "Using Epoch checkout: $repo"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY RUN: would configure telemetry endpoint: $ENDPOINT"
  echo "DRY RUN: would run telemetry preview, enable, status, and submit from $repo"
  exit 0
fi

if [[ ! -f dist/index.js ]]; then
  echo "dist/index.js is missing; installing and building..."
  pnpm install
  pnpm run build
fi

node dist/index.js telemetry preview
node dist/index.js telemetry enable --yes --endpoint "$ENDPOINT"
node dist/index.js telemetry status
node dist/index.js telemetry submit || echo "Initial telemetry submit skipped or failed; queued records remain local for the next run."

echo "Done. Endpoint configured: $ENDPOINT"
