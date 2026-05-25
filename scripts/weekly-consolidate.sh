#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Epoch — Weekly fleet consolidation and self-improvement
#
# Runs on the Mac mini. Gathers data from all reachable machines, merges,
# runs self-improve, and commits the updated reference database to the repo.
#
# Designed to be run via launchd weekly. Safe to run manually too.
#
# Schedule: Every Monday at 3 AM local time
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- Config -----------------------------------------------------------------
REPO_DIR="${EPOCH_REPO_DIR:-$HOME/workspaces/Epoch}"
EPOCH_BIN="${EPOCH_BIN:-$(command -v epoch || echo /opt/homebrew/bin/epoch)}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
NUC_HOST="${EPOCH_NUC_HOST:-simon@100.113.174.74}"
NUC_DATA_DIR="${EPOCH_NUC_DATA_DIR:-/srv/data/epoch}"
LAPTOP_HOST="${EPOCH_LAPTOP_HOST:-100.97.231.117}"
BRANCH="${EPOCH_CONSOLIDATE_BRANCH:-main}"
PR_BRANCH="chore/weekly-reference-db-update"
LOG_FILE="${HOME}/.epoch/consolidate.log"

# ---- Logging ----------------------------------------------------------------
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >>"$LOG_FILE" 2>/dev/null || true; }

# ---- Preflight --------------------------------------------------------------
log "=== Epoch Weekly Consolidation Start ==="

if [ ! -d "$REPO_DIR/.git" ]; then
  log "FAIL: $REPO_DIR is not a git repo. Aborting."
  exit 1
fi

cd "$REPO_DIR"

# Make sure we're on main and up to date
git fetch origin "$BRANCH" 2>/dev/null || true
git switch "$BRANCH" 2>/dev/null || true
git pull --ff-only 2>/dev/null || log "WARN: could not pull latest (offline or conflicts)"

# Build to ensure dist is current
log "Building..."
pnpm run build --silent 2>/dev/null || pnpm run build 2>&1 | tail -3

# ---- Create consolidation dir -----------------------------------------------
CONSOLIDATE_DIR="$(mktemp -d)"
trap 'rm -r "$CONSOLIDATE_DIR" 2>/dev/null || true' EXIT

# ---- 1. Mac mini (local) data -----------------------------------------------
log "Gathering Mac mini local data..."
if [ -f "$HOME/.epoch/estimates.jsonl" ]; then
  cp "$HOME/.epoch/estimates.jsonl" "$CONSOLIDATE_DIR/"
  cp "$HOME/.epoch/feedback.jsonl" "$CONSOLIDATE_DIR/"
  cp "$HOME/.epoch/telemetry.jsonl" "$CONSOLIDATE_DIR/" 2>/dev/null || true
  cp "$HOME/.epoch/config.json" "$CONSOLIDATE_DIR/" 2>/dev/null || true
  MAC_ESTIMATES=$(wc -l <"$CONSOLIDATE_DIR/estimates.jsonl" | tr -d ' ')
  MAC_ACTUALS=$(wc -l <"$CONSOLIDATE_DIR/feedback.jsonl" | tr -d ' ')
  log "  Mac mini: $MAC_ESTIMATES estimates, $MAC_ACTUALS actuals"
else
  MAC_ESTIMATES=0
  MAC_ACTUALS=0
  log "  Mac mini: no local data"
fi

# ---- 2. NuC receiver records ------------------------------------------------
log "Gathering NuC receiver records..."
NUC_RECORDS=0
if ssh -o ConnectTimeout=10 "$NUC_HOST" "test -f $NUC_DATA_DIR/telemetry-records.jsonl" 2>/dev/null; then
  ssh -o ConnectTimeout=10 "$NUC_HOST" "cat $NUC_DATA_DIR/telemetry-records.jsonl" >"$CONSOLIDATE_DIR/telemetry-records.jsonl" 2>/dev/null || true
  NUC_RECORDS=$(wc -l <"$CONSOLIDATE_DIR/telemetry-records.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
  log "  NuC: $NUC_RECORDS received records"
else
  log "  NuC: unreachable (will skip)"
fi

# ---- 3. Laptop (opportunistic) ----------------------------------------------
log "Checking laptop ($LAPTOP_HOST)..."
LAPTOP_ESTIMATES=0
LAPTOP_ACTUALS=0
if ssh -o ConnectTimeout=5 "$LAPTOP_HOST" 'test -f ~/.epoch/estimates.jsonl' 2>/dev/null; then
  ssh -o ConnectTimeout=5 "$LAPTOP_HOST" 'cat ~/.epoch/estimates.jsonl' >>"$CONSOLIDATE_DIR/estimates.jsonl" 2>/dev/null || true
  ssh -o ConnectTimeout=5 "$LAPTOP_HOST" 'cat ~/.epoch/feedback.jsonl' >>"$CONSOLIDATE_DIR/feedback.jsonl" 2>/dev/null || true
  ssh -o ConnectTimeout=5 "$LAPTOP_HOST" 'cat ~/.epoch/telemetry.jsonl' >>"$CONSOLIDATE_DIR/telemetry.jsonl" 2>/dev/null || true
  LAPTOP_ESTIMATES=$(ssh -o ConnectTimeout=5 "$LAPTOP_HOST" 'wc -l < ~/.epoch/estimates.jsonl' 2>/dev/null | tr -d ' ' || echo 0)
  LAPTOP_ACTUALS=$(ssh -o ConnectTimeout=5 "$LAPTOP_HOST" 'wc -l < ~/.epoch/feedback.jsonl' 2>/dev/null | tr -d ' ' || echo 0)
  log "  Laptop: $LAPTOP_ESTIMATES estimates, $LAPTOP_ACTUALS actuals (reachable!)"
else
  log "  Laptop: offline (skipping, not an error)"
fi

# ---- 4. Summary -------------------------------------------------------------
TOTAL_ESTIMATES=$(wc -l <"$CONSOLIDATE_DIR/estimates.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
TOTAL_ACTUALS=$(wc -l <"$CONSOLIDATE_DIR/feedback.jsonl" 2>/dev/null | tr -d ' ' || echo 0)

log "Consolidated: $TOTAL_ESTIMATES estimates, $TOTAL_ACTUALS actuals, $NUC_RECORDS receiver records"

# ---- 5. Self-improve --------------------------------------------------------
log "Running self-improve on consolidated data..."

BEFORE_SIZE=$(EPOCH_DATA_DIR="$CONSOLIDATE_DIR" "$NODE_BIN" dist/index.js data status 2>/dev/null |
  python3 -c "import sys,json; print(json.loads(sys.stdin.read())['referenceDatabase']['sampleSize'])" 2>/dev/null)
BEFORE_SIZE="${BEFORE_SIZE:-unknown}"

EPOCH_DATA_DIR="$CONSOLIDATE_DIR" "$NODE_BIN" dist/index.js self-improve 2>&1 | while read -r line; do log "  $line"; done

AFTER_SIZE=$(EPOCH_DATA_DIR="$CONSOLIDATE_DIR" "$NODE_BIN" dist/index.js data status 2>/dev/null |
  python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f\"{d['referenceDatabase']['sampleSize']} samples\")" 2>/dev/null)
AFTER_SIZE="${AFTER_SIZE:-unknown}"

log "Reference DB: $BEFORE_SIZE → $AFTER_SIZE"

# ---- 6. Copy to repo --------------------------------------------------------
log "Updating bundled reference database..."
cp "$CONSOLIDATE_DIR/reference-database.json" "$REPO_DIR/src/data/reference-database.json"

# Verify (non-fatal — script may not exist on older checkouts)
if [ -f "$REPO_DIR/scripts/verify-reference-db.mjs" ]; then
  "$NODE_BIN" "$REPO_DIR/scripts/verify-reference-db.mjs" 2>&1 | while read -r line; do log "  $line"; done || log "WARN: verify failed"
else
  log "  Skipping verify (script not present in this checkout)"
fi

# ---- 7. Commit and push via PR (repo requires PRs for main) -----------------
log "Committing reference database update..."
cd "$REPO_DIR"

# Check if the reference DB actually changed
if git diff --quiet src/data/reference-database.json 2>/dev/null; then
  log "No changes to reference database. Skipping commit."
else
  STAMP=$(date -u +%Y-%m-%d)

  # Switch to PR branch BEFORE committing so main stays clean
  git branch -D "$PR_BRANCH" 2>/dev/null || true
  git checkout -b "$PR_BRANCH" 2>/dev/null || true

  git add src/data/reference-database.json
  git commit -m "chore: update bundled reference database ($STAMP consolidation)

Consolidated from: Mac mini ($MAC_ESTIMATES est, $MAC_ACTUALS act), \
Laptop ($LAPTOP_ESTIMATES est, $LAPTOP_ACTUALS act), \
NuC ($NUC_RECORDS records). \
Total: $TOTAL_ESTIMATES estimates, $TOTAL_ACTUALS actuals."

  git push origin "$PR_BRANCH" --force 2>&1 | while read -r line; do log "  $line"; done || log "WARN: push failed (may be offline)"

  # Create or update PR via GitHub CLI
  if command -v gh &>/dev/null; then
    EXISTING=$(gh pr list --head "$PR_BRANCH" --state open --json number -q '.[0].number' 2>/dev/null || echo "")
    if [ -n "$EXISTING" ]; then
      log "Updated existing PR #$EXISTING"
    else
      gh pr create \
        --title "chore: weekly reference database update ($STAMP)" \
        --body "Automated weekly consolidation of Epoch fleet data.

Consolidated from: Mac mini ($MAC_ESTIMATES est, $MAC_ACTUALS act), Laptop ($LAPTOP_ESTIMATES est, $LAPTOP_ACTUALS act), NuC ($NUC_RECORDS records). Total: $TOTAL_ESTIMATES estimates, $TOTAL_ACTUALS actuals.

This PR was auto-generated by the weekly consolidation launchd job on simons-mac-mini." \
        --base main \
        --head "$PR_BRANCH" \
        2>&1 | while read -r line; do log "  $line"; done || log "WARN: PR creation failed"
      log "Created new PR"
    fi
    # Auto-merge when CI passes
    gh pr merge "$PR_BRANCH" --squash --auto --delete-branch=false 2>&1 | while read -r line; do log "  $line"; done || true
  else
    log "WARN: gh CLI not available, cannot create PR"
  fi

  # Switch back to main and sync with origin to avoid divergence.
  # Only run the destructive hard-reset fallback after confirming checkout
  # switched away from the just-created PR branch.
  if git checkout main 2>/dev/null; then
    git pull --ff-only origin main 2>/dev/null || git reset --hard origin/main 2>/dev/null || true
  else
    log "WARN: failed to switch back to main; skipping origin/main hard reset"
  fi
  log "Committed and PR created/updated."
fi

# ---- 8. Update local Mac mini reference DB -----------------------------------
cp "$CONSOLIDATE_DIR/reference-database.json" "$HOME/.epoch/reference-database.json" 2>/dev/null && log "Updated local ~/.epoch/reference-database.json"

log "=== Consolidation Complete ==="
