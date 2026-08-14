#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Epoch — Consolidate data from all machines and rebuild reference database
#
# Pulls estimates, feedback, and telemetry from all configured machines,
# merges them into a single EPOCH_DATA_DIR, runs self-improve, and copies
# the resulting reference database back to the repo's bundled location.
#
# Usage:
#   bash scripts/consolidate-and-improve.sh
#
# Environment:
#   EPOCH_MAC_MINI_HOST    - Tailscale IP or hostname (required; fleet
#                            addresses are not stored in this public repo)
#   EPOCH_MAC_MINI_USER    - SSH user for Mac mini (default: current user)
#   EPOCH_NUC_HOST         - Tailscale IP or hostname (required)
#   EPOCH_NUC_USER         - SSH user for NuC (default: current user)
#   EPOCH_NUC_DATA_DIR     - Data dir on NuC (default: /srv/data/epoch)
#   EPOCH_REPO_DIR         - Local Epoch repo (default: script's parent dir)
# ---------------------------------------------------------------------------
set -euo pipefail

MAC_HOST="${EPOCH_MAC_MINI_HOST:?EPOCH_MAC_MINI_HOST must be set (Tailscale IP or hostname)}"
MAC_USER="${EPOCH_MAC_MINI_USER:-}"
NUC_HOST="${EPOCH_NUC_HOST:?EPOCH_NUC_HOST must be set (Tailscale IP or hostname)}"
NUC_USER="${EPOCH_NUC_USER:-}"
NUC_DATA_DIR="${EPOCH_NUC_DATA_DIR:-/srv/data/epoch}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${EPOCH_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# SSH prefixes
MAC_SSH="${MAC_USER:+$MAC_USER@}$MAC_HOST"
NUC_SSH="${NUC_USER:+$NUC_USER@}$NUC_HOST"

echo "Epoch Data Consolidation & Self-Improvement"
echo "============================================="
echo ""
echo "Laptop:  local (~/.epoch/)"
echo "Mac mini: $MAC_SSH"
echo "NuC:      $NUC_SSH ($NUC_DATA_DIR)"
echo "Repo:     $REPO_DIR"
echo ""

# ---- 1. Create temp consolidation dir ---------------------------------------
CONSOLIDATE_DIR="$(mktemp -d)"
trap 'echo "Cleaning up $CONSOLIDATE_DIR"; rm -r "$CONSOLIDATE_DIR" 2>/dev/null || true' EXIT

echo "[1/6] Gathering laptop data..."
if [ -f ~/.epoch/estimates.jsonl ]; then
  cp ~/.epoch/estimates.jsonl "$CONSOLIDATE_DIR/"
  cp ~/.epoch/feedback.jsonl "$CONSOLIDATE_DIR/"
  cp ~/.epoch/telemetry.jsonl "$CONSOLIDATE_DIR/" 2>/dev/null || true
  cp ~/.epoch/config.json "$CONSOLIDATE_DIR/" 2>/dev/null || true
  LAPTOP_ESTIMATES=$(wc -l < "$CONSOLIDATE_DIR/estimates.jsonl" | tr -d ' ')
  LAPTOP_ACTUALS=$(wc -l < "$CONSOLIDATE_DIR/feedback.jsonl" | tr -d ' ')
  echo "  Laptop: $LAPTOP_ESTIMATES estimates, $LAPTOP_ACTUALS actuals"
else
  LAPTOP_ESTIMATES=0
  LAPTOP_ACTUALS=0
  echo "  Laptop: no local data found"
fi

# ---- 2. Append Mac mini data ------------------------------------------------
echo "[2/6] Gathering Mac mini data..."
MAC_ESTIMATES=0
MAC_ACTUALS=0
if ssh -o ConnectTimeout=10 "$MAC_SSH" 'test -f ~/.epoch/estimates.jsonl' 2>/dev/null; then
  ssh -o ConnectTimeout=10 "$MAC_SSH" 'cat ~/.epoch/estimates.jsonl' >> "$CONSOLIDATE_DIR/estimates.jsonl" 2>/dev/null || true
  ssh -o ConnectTimeout=10 "$MAC_SSH" 'cat ~/.epoch/feedback.jsonl' >> "$CONSOLIDATE_DIR/feedback.jsonl" 2>/dev/null || true
  ssh -o ConnectTimeout=10 "$MAC_SSH" 'cat ~/.epoch/telemetry.jsonl' >> "$CONSOLIDATE_DIR/telemetry.jsonl" 2>/dev/null || true
  MAC_ESTIMATES=$(ssh -o ConnectTimeout=10 "$MAC_SSH" 'wc -l < ~/.epoch/estimates.jsonl' 2>/dev/null | tr -d ' ' || echo 0)
  MAC_ACTUALS=$(ssh -o ConnectTimeout=10 "$MAC_SSH" 'wc -l < ~/.epoch/feedback.jsonl' 2>/dev/null | tr -d ' ' || echo 0)
  echo "  Mac mini: $MAC_ESTIMATES estimates, $MAC_ACTUALS actuals"
else
  echo "  Mac mini: unreachable or no data"
fi

# ---- 3. Copy NuC receiver records -------------------------------------------
echo "[3/6] Gathering NuC receiver records..."
NUC_RECORDS=0
if ssh -o ConnectTimeout=10 "$NUC_SSH" "test -f $NUC_DATA_DIR/telemetry-records.jsonl" 2>/dev/null; then
  ssh -o ConnectTimeout=10 "$NUC_SSH" "cat $NUC_DATA_DIR/telemetry-records.jsonl" > "$CONSOLIDATE_DIR/telemetry-records.jsonl" 2>/dev/null || true
  NUC_RECORDS=$(wc -l < "$CONSOLIDATE_DIR/telemetry-records.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
  echo "  NuC: $NUC_RECORDS received telemetry records"
else
  echo "  NuC: unreachable or no data"
fi

# ---- 4. Summary before self-improve -----------------------------------------
TOTAL_ESTIMATES=$(wc -l < "$CONSOLIDATE_DIR/estimates.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
TOTAL_ACTUALS=$(wc -l < "$CONSOLIDATE_DIR/feedback.jsonl" 2>/dev/null | tr -d ' ' || echo 0)

echo ""
echo "Consolidated data:"
echo "  Estimates:  $TOTAL_ESTIMATES ($LAPTOP_ESTIMATES laptop + $MAC_ESTIMATES mac-mini)"
echo "  Actuals:    $TOTAL_ACTUALS ($LAPTOP_ACTUALS laptop + $MAC_ACTUALS mac-mini)"
echo "  Receiver:   $NUC_RECORDS records"
echo ""

# ---- 5. Run self-improve on consolidated data -------------------------------
echo "[4/6] Running self-improve on consolidated data..."
cd "$REPO_DIR"

# Build first to make sure dist is current
pnpm run build --silent 2>/dev/null || pnpm run build 2>&1 | tail -3

# Check before
BEFORE_FACTOR=$(EPOCH_DATA_DIR="$CONSOLIDATE_DIR" node dist/index.js data status 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d['referenceDatabase']['sampleSize'])" 2>/dev/null || echo "unknown")
echo "  Before: sample size $BEFORE_FACTOR"

EPOCH_DATA_DIR="$CONSOLIDATE_DIR" node dist/index.js self-improve 2>&1

# Check after
AFTER_FACTOR=$(EPOCH_DATA_DIR="$CONSOLIDATE_DIR" node dist/index.js data status 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f\"{d['referenceDatabase']['sampleSize']} (factor {d['referenceDatabase']['source']})\")" 2>/dev/null || echo "unknown")
echo "  After: $AFTER_FACTOR"

# ---- 6. Copy to repo and machines -------------------------------------------
echo "[5/6] Copying improved reference database..."
cp "$CONSOLIDATE_DIR/reference-database.json" "$REPO_DIR/src/data/reference-database.json"
echo "  → $REPO_DIR/src/data/reference-database.json"

# Copy to Mac mini
if ssh -o ConnectTimeout=10 "$MAC_SSH" 'test -d ~/.epoch' 2>/dev/null; then
  scp -o ConnectTimeout=10 "$CONSOLIDATE_DIR/reference-database.json" "$MAC_SSH:~/.epoch/reference-database.json" 2>/dev/null && echo "  → $MAC_SSH:~/.epoch/reference-database.json" || echo "  Failed to copy to Mac mini"
fi

# Verify the new bundled DB
echo "[6/6] Verifying..."
node "$REPO_DIR/scripts/verify-reference-db.mjs" 2>&1

echo ""
echo "Done. The consolidated reference database is in:"
echo "  $REPO_DIR/src/data/reference-database.json"
echo ""
echo "To commit: cd $REPO_DIR && git add src/data/reference-database.json && git commit -m 'chore: update bundled reference database from consolidated fleet data'"
