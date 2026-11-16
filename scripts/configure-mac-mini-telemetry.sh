#!/usr/bin/env bash
set -euo pipefail

# Receiver endpoints are not stored in this public repo.
# Set EPOCH_TELEMETRY_ENDPOINT (e.g. https://your-receiver.example/v1/telemetry) before running.
ENDPOINT="${EPOCH_TELEMETRY_ENDPOINT:?EPOCH_TELEMETRY_ENDPOINT must be set (telemetry receiver URL)}"

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

# Entry-check verification: npm installs the `epoch` bin as a symlink to
# dist/index.js. The CLI once compared import.meta.url (realpath) with
# argv[1] (symlink path), always lost, and exited 0 with no output — every
# `epoch …` call through the bin name silently did nothing. Invoke the CLI
# through a symlink here so a regression fails at configure time, not months
# later in the telemetry pipeline.
echo "Verifying the CLI answers through a bin-style symlink..."
bin_dir="$(mktemp -d)"
trap 'rm -rf "$bin_dir"' EXIT
ln -sfn "$repo/dist/index.js" "$bin_dir/epoch"
if ! bin_version="$(node "$bin_dir/epoch" --version)"; then
  echo "FAIL: 'epoch --version' through a bin symlink exited non-zero." >&2
  echo "The entry check regressed; npm-installed users would get silent no-ops." >&2
  exit 1
fi
if [[ -z "$bin_version" ]]; then
  echo "FAIL: 'epoch --version' through a bin symlink printed nothing." >&2
  echo "The entry check regressed; npm-installed users would get silent no-ops." >&2
  exit 1
fi
expected_version="$(node -p 'require("./package.json").version')"
if [[ "$bin_version" != "$expected_version" ]]; then
  echo "FAIL: epoch --version printed '$bin_version', package.json says '$expected_version'." >&2
  exit 1
fi
echo "Entry check OK: epoch --version -> $bin_version"

# Hook verification: the agent-lifecycle hook must resolve a working CLI even
# after the Epoch checkout moves (the old hook hardcoded one checkout path and
# silently killed telemetry generation for months).
echo "Verifying the agent-lifecycle hook resolves a working Epoch CLI..."
if ! hook_check="$(node "$repo/scripts/epoch-lifecycle-hook.mjs" --check)"; then
  echo "FAIL: the agent-lifecycle hook could not resolve a working Epoch CLI." >&2
  echo "Set EPOCH_BIN to <checkout>/dist/index.js or fix the install, then rerun." >&2
  exit 1
fi
echo "Hook OK: $hook_check"

node dist/index.js telemetry enable --endpoint "$ENDPOINT"
node dist/index.js telemetry status
node dist/index.js telemetry submit || true

echo "Done. Endpoint configured: $ENDPOINT"
