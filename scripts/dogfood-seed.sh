#!/usr/bin/env bash
# Record real estimate/actual pairs from Epoch project work this week
set -euo pipefail

API="http://127.0.0.1:3000/v1/tools"

record_task() {
  local task_type="$1"
  local scope="$2"
  local complexity="$3"
  local actual_hours="$4"
  local notes="$5"

  local resp
  resp=$(curl -s -X POST "$API/reference_class_estimate" \
    -H "Content-Type: application/json" \
    -d "{\"task_type\": \"$task_type\", \"scope\": \"$scope\", \"complexity\": $complexity, \"ai_native\": 1.0}")

  local ok
  ok=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null || echo "False")

  if [ "$ok" = "True" ]; then
    local token est
    token=$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(d.get('feedbackToken',''))" 2>/dev/null || echo "")
    est=$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(d.get('correctedEstimate',0))" 2>/dev/null || echo "0")

    if [ -n "$token" ] && [ "$token" != "None" ] && [ "$token" != "" ]; then
      curl -s -X POST "$API/record_actual" \
        -H "Content-Type: application/json" \
        -d "{\"estimate_id\": \"$token\", \"actual_hours\": $actual_hours, \"notes\": \"$notes\"}" > /dev/null
      echo "OK: $task_type/$scope c=$complexity est=${est}h actual=${actual_hours}h -- $notes"
    else
      echo "SKIP: no token for $task_type/$scope"
    fi
  else
    echo "FAIL: estimate failed for $task_type/$scope"
  fi
}

echo "=== Recording dogfood data for Epoch project work ==="

# Phase 1: Initial scaffolding (Apr 28-29)
record_task infrastructure large 4 6.0 "Initial project scaffolding: TypeScript toolchain"
record_task feature xl 5 12.0 "Core type definitions and Zod schemas for all 5 layers"
record_task feature large 4 8.0 "Temporal and calendar utilities Layers 1-2"
record_task feature xl 5 10.0 "Estimation and analytics algorithms Layers 3-5"
record_task feature large 3 5.0 "MCP tool registration wiring and server entry point"
record_task testing large 3 6.0 "Initial test suite to 87 percent coverage"

# Phase 2: Landing page + multi-surface (Apr 29-30)
record_task design medium 3 4.0 "Landing page with dark theme design system"
record_task feature large 4 7.0 "CLI REST API and AI discoverability surfaces"
record_task feature medium 2 2.0 "Pretty flag and list-tools CLI subcommand"
record_task bugfix medium 3 3.0 "Unify parameter names and harden dispatch"

# Phase 3: Self-improvement + data pipeline (Apr 30 - May 1)
record_task feature large 4 6.0 "Self-improvement engine with tool-aware correction factors"
record_task feature large 3 5.0 "Supplementary calibration data from 5 public sources"
record_task feature xl 4 8.0 "5 data-powered tools plus community data pipeline"
record_task feature medium 3 3.0 "AI native gradient on pert cocomo sprint reference-class"
record_task feature medium 3 4.0 "LLM-friendly response enrichment across all surfaces"
record_task testing large 3 5.0 "Real function-calling canary replacing text-prompt sim"

# Phase 4: Hardening + audit fixes (May 1)
record_task bugfix large 4 5.0 "Stress test findings 6 critical high severity fixes"
record_task bugfix medium 3 3.0 "Comprehensive QA remediation across all surfaces"
record_task bugfix medium 2 2.0 "Canary runner scoping bug and time regex validation"
record_task bugfix large 3 4.0 "Harden estimation pipeline and close audit findings"

# Phase 5: npm publish prep + CI (May 1)
record_task infrastructure large 3 4.0 "Package.json exports types files engines for npm publish"
record_task infrastructure large 3 5.0 "CI workflows Blacksmith OIDC trusted publishing dependabot"
record_task infrastructure medium 2 2.0 "ESLint flat config editorconfig branded types"
record_task feature medium 2 2.5 "5 missing CLI commands token-cost compare-models accuracy-trend schedule-risk cocomo-validate"
record_task infrastructure medium 3 3.0 "MCP annotations on all tools rate limiting 404 handler"
record_task refactor large 4 5.0 "Extract shared dispatchTimeMath unify time_math handler"
record_task bugfix small 2 1.0 "Division-by-zero caching rate limiting version consistency"

# Phase 6: Feedback loop + testing push (May 1-2)
record_task feature medium 3 3.0 "record_actual and get_pending_estimates MCP tools"
record_task feature small 2 1.5 "CLI commands for record-actual and get-pending-estimates"
record_task bugfix small 2 1.0 "Propagate record_actual failures flush telemetry on exit"
record_task testing large 3 4.0 "Telemetry tests 22 plus cost accuracy-trend edge cases"
record_task testing large 3 4.0 "Expand to 606 tests supplementary-data feedback tool wrappers"
record_task testing medium 2 2.0 "Entry point tests plus fix audit findings"

# Phase 7: Architecture unification (May 2)
record_task refactor large 4 5.0 "Unify dual tool registration into single source of truth"
record_task bugfix medium 3 2.0 "Critical path resolution error consistency docs accuracy"
record_task bugfix medium 2 1.5 "Close behavioral divergence gaps package hygiene"

# Phase 8: Scope + feedback + data (May 2 - today)
record_task feature large 4 4.0 "Real session baselines AI human gradient pipeline fixes"
record_task bugfix medium 3 2.5 "Rebuild baselines from task-level data remove false accuracy claims"
record_task feature medium 3 3.0 "Scope signal small medium large xl bands plus complexity multiplier"
record_task feature medium 2 2.0 "Scope DX medium default plus scopeGuide for LLM accuracy"
record_task feature medium 2 1.5 "Activate feedback loop feedbackToken plus actionable pending list"
record_task infrastructure large 3 3.0 "Expand data all 8 categories 808 samples"
record_task feature large 4 4.0 "Ground truth validation 6-model comparison against 182 real projects"
record_task feature medium 3 2.5 "Dogfooding infrastructure batch record actuals plus feedback health"

# Phase 9: Docs (ongoing)
record_task documentation large 3 4.0 "SEO-optimized README expanded metadata community data guide"
record_task documentation medium 2 2.0 "Rewrite README with human-friendly intro plus MCP explainer"
record_task documentation medium 3 3.0 "Landing page overhaul hero problem solution narrative"
record_task documentation medium 2 2.0 "Update tool examples to match actual API schemas"
record_task documentation small 1 0.5 "Fix utcOffset examples to match string type"

echo ""
echo "=== Done recording dogfood data ==="
