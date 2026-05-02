#!/usr/bin/env bash
# Record cross-project work from the week of Apr 28 - May 2
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

echo "=== Recording cross-project dogfood data ==="

# CEO_Agents — 6 commits, major security/quality audit work
record_task bugfix large 4 6.0 "CEO_Agents: Fix 55 audit findings SSRF race conditions code quality"
record_task bugfix large 4 5.0 "CEO_Agents: Fix 39 issues across security code quality package config"
record_task bugfix medium 3 3.0 "CEO_Agents: Fix SSRF bypass IPv6-mapped hex unknown command NaN budget"
record_task bugfix medium 3 2.0 "CEO_Agents: Fix React key collisions flaky tests PostCSS vuln"
record_task bugfix small 2 1.5 "CEO_Agents: Fix remaining issues and audit TUI aesthetics"

# GITHUB_pipeline — 42 commits, massive pipeline infrastructure work
record_task feature xl 5 8.0 "GITHUB_pipeline: Add autonomous issue closer and redesign dashboard"
record_task feature large 4 5.0 "GITHUB_pipeline: Track all repos across personal account and org"
record_task feature large 4 6.0 "GITHUB_pipeline: Replace phantom workers with real triage LaunchAgent"
record_task bugfix medium 3 2.0 "GITHUB_pipeline: Fix auto-merge hanging on bad input when unauthenticated"
record_task bugfix large 4 4.0 "GITHUB_pipeline: Harden error handling fix model guard add worktree health check"
record_task bugfix large 4 5.0 "GITHUB_pipeline: Secure state files harden locking fix CI gaps Bash 3.2 compat"
record_task refactor large 4 4.0 "GITHUB_pipeline: Deepen architecture reliability and test fixes"
record_task bugfix large 4 4.0 "GITHUB_pipeline: Fix architecture reliability tests and docs"
record_task bugfix large 4 5.0 "GITHUB_pipeline: Fix security reliability and architecture issues from full audit"
record_task bugfix medium 3 3.0 "GITHUB_pipeline: Fix pipeline health failures stuck worker and runner visibility"
record_task bugfix small 2 1.0 "GITHUB_pipeline: Retry transient dashboard reads during issue surfacing"
record_task feature medium 2 1.5 "GITHUB_pipeline: Align LM Studio guard with launchd-managed model"
record_task feature medium 3 2.0 "GITHUB_pipeline: Protect local inference routing and capacity"
record_task refactor medium 2 1.5 "GITHUB_pipeline: Consolidate scheduler and dashboard cleanup state"
record_task bugfix small 2 1.0 "GITHUB_pipeline: Lock known pipeline failures with regression tests"
record_task bugfix small 2 1.0 "GITHUB_pipeline: Fallback missing target repos to central issue queue"
record_task bugfix small 1 0.5 "GITHUB_pipeline: Fallback cross-repo findings to pipeline issue queue"
record_task bugfix small 1 0.5 "GITHUB_pipeline: Keep issue creation resilient to missing repo labels"
record_task feature medium 2 2.0 "GITHUB_pipeline: Automate self-hosted issue surfacing"
record_task feature large 4 4.0 "GITHUB_pipeline: Replace stale dashboard repos with live-validated discovery"
record_task feature medium 3 3.0 "GITHUB_pipeline: Add Kyanite PR issue exporter"
record_task feature medium 3 2.5 "GITHUB_pipeline: Keep dashboard refreshed with Kyanite CI status"
record_task feature large 3 3.0 "GITHUB_pipeline: Export repo-pipeline findings as agent-ready issues"
record_task feature medium 2 2.0 "GITHUB_pipeline: Require protected local model in pipeline runs"
record_task feature small 2 1.0 "GITHUB_pipeline: Use recommended Q8 local inference guard"
record_task feature small 1 0.5 "GITHUB_pipeline: Protect persistent Q4 local inference"
record_task feature small 1 0.5 "GITHUB_pipeline: Keep one local inference winner loaded"
record_task feature medium 2 1.5 "GITHUB_pipeline: Make worker and inference strategy explicit"
record_task feature medium 3 2.0 "GITHUB_pipeline: Integrate runner policy into dashboard reality"
record_task feature medium 3 2.0 "GITHUB_pipeline: Codify runner lane strategy and budget guardrails"
record_task refactor small 1 0.5 "GITHUB_pipeline: Refresh migration decision docs"
record_task feature medium 2 2.0 "GITHUB_pipeline: Encode complementary Blacksmith control plane"
record_task feature medium 3 2.5 "GITHUB_pipeline: Make pipeline dashboard and cron operable"
record_task refactor medium 2 1.5 "GITHUB_pipeline: Deepen pipeline dashboard extract shared helpers deduplicate"

# noise.sh — 6 commits, music suite modules
record_task feature large 3 3.0 "noise.sh: Merge music suite modules lyrics-engine VoxForge"
record_task documentation medium 2 1.0 "noise.sh: Document noise.sh music suite module boundaries"
record_task feature medium 2 1.5 "noise.sh: Preserve lyrics-engine for noise.sh music suite"
record_task feature medium 2 1.5 "noise.sh: Preserve VoxForge for noise.sh music suite"
record_task infrastructure small 1 0.5 "noise.sh: CI migrate to self-hosted runners"

# Print-OS — 3 commits, 3D designer consolidation
record_task feature large 3 3.0 "Print-OS: Consolidate 3d Designer into Print OS"
record_task feature medium 2 2.0 "Print-OS: Preserve 3d Designer inside Print OS"

# OMC — 2 commits, dashboard refactor
record_task refactor large 3 3.0 "OMC: Split dashboard monolith into CSS JS modules extract offline data"
record_task refactor medium 2 1.5 "OMC: Deepen pipeline dashboard extract shared helpers deduplicate supervision"

# CI migrations across multiple repos (repetitive but real work)
record_task infrastructure small 1 0.5 "cerafica: CI migrate to self-hosted runners"
record_task infrastructure small 1 0.5 "Farm-to-Stars: CI migrate to self-hosted runner"
record_task infrastructure small 1 0.5 "creative-portfolio: CI migrate to self-hosted runners"
record_task infrastructure small 1 0.5 "tarot-content-creator: CI migrate to self-hosted runner"

# Blacksmith probes across repos
record_task infrastructure small 1 0.3 "Pottery-App: Add then remove Blacksmith probe"
record_task infrastructure small 1 0.3 "LifeOS: Add then remove Blacksmith probe"
record_task infrastructure small 1 0.3 "Syntax.sh: Add then remove Blacksmith probe"
record_task infrastructure small 1 0.3 "infra: Add then remove Blacksmith probe"

# Workspace init
record_task infrastructure medium 2 1.0 "puenteworks: Preserve PuenteWorks canonical workspace"

echo ""
echo "=== Done recording cross-project data ==="
