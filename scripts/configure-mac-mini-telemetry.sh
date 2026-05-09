#!/usr/bin/env bash
set -euo pipefail

if [[ "${EPOCH_CONFIRM_OPS:-}" != "1" ]]; then
  cat >&2 <<'MSG'
This operational script changes local Epoch telemetry configuration and submits queued telemetry.
Review the endpoint first, then rerun with EPOCH_CONFIRM_OPS=1.
MSG
  exit 1
fi

ENDPOINT="${EPOCH_TELEMETRY_ENDPOINT:-http://100.66.225.85:3099/v1/telemetry}"

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
