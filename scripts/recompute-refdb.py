#!/usr/bin/env python3
"""Recompute reference-database.json with per-tool correction factors."""

import json, os, sys
from pathlib import Path
from collections import defaultdict

EPOCH_DIR = Path.home() / ".epoch"
ESTIMATES_FILE = EPOCH_DIR / "estimates.jsonl"
FEEDBACK_FILE = EPOCH_DIR / "feedback.jsonl"
REF_DB = Path(__file__).parent.parent / "src" / "data" / "reference-database.json"

def load_jsonl(path):
    records = []
    if not path.exists():
        return records
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return records

def extract_hours(outputs):
    if isinstance(outputs.get("totalHours"), (int, float)):
        return outputs["totalHours"]
    if isinstance(outputs.get("estimatedHours"), (int, float)):
        return outputs["estimatedHours"]
    if isinstance(outputs.get("estimatedMinutes"), (int, float)):
        return outputs["estimatedMinutes"] / 60
    if isinstance(outputs.get("estimatedSeconds"), (int, float)):
        return outputs["estimatedSeconds"] / 3600
    if isinstance(outputs.get("expected"), (int, float)):
        unit = outputs.get("unit", "hours")
        scales = {"hours": 1, "days": 8, "weeks": 40, "months": 160}
        return outputs["expected"] * scales.get(unit, 1)
    if isinstance(outputs.get("personMonthsLlmAdjusted"), (int, float)):
        return outputs["personMonthsLlmAdjusted"] * 160
    if isinstance(outputs.get("correctedEstimate"), (int, float)):
        return outputs["correctedEstimate"]
    return None

def main():
    print("Loading data...")
    estimates = load_jsonl(ESTIMATES_FILE)
    feedback = load_jsonl(FEEDBACK_FILE)
    print(f"  {len(estimates)} estimates, {len(feedback)} feedback records")

    # Build actuals map
    actuals_map = {}
    for a in feedback:
        actuals_map[a["estimateId"]] = a

    # Match estimates to actuals
    matched = []
    for est in estimates:
        act = actuals_map.get(est["id"])
        if not act:
            continue
        est_hours = extract_hours(est.get("outputs", {}))
        if est_hours is None or est_hours <= 0:
            continue
        actual = act.get("actualHours", 0)
        if actual <= 0:
            continue

        task_type = est.get("inputs", {}).get("task_type")
        if not task_type:
            tool = est.get("tool", "")
            if "pert" in tool or "cocomo" in tool or "sprint" in tool:
                task_type = "feature"
            elif "token" in tool:
                task_type = "infrastructure"
            elif "calibrate" in tool or "reference" in tool:
                task_type = "testing"
            else:
                task_type = "feature"

        matched.append({
            "tool": est.get("tool", "unknown"),
            "taskType": task_type,
            "estimatedHours": est_hours,
            "actualHours": actual,
            "ratio": actual / est_hours,
        })

    print(f"  {len(matched)} matched estimate→actual pairs\n")

    # Compute per-(tool, taskType) correction factors
    tool_task_ratios = defaultdict(list)
    task_type_ratios = defaultdict(list)

    for r in matched:
        tool_task_ratios[(r["tool"], r["taskType"])].append(r["ratio"])
        task_type_ratios[r["taskType"]].append(r["ratio"])

    def median(lst):
        s = sorted(lst)
        mid = len(s) // 2
        if len(s) % 2 == 0:
            return (s[mid - 1] + s[mid]) / 2
        return s[mid]

    # Per-tool correction factors
    tool_factors = {}
    for (tool, tt), ratios in sorted(tool_task_ratios.items()):
        if len(ratios) < 3:
            print(f"  SKIP {tool}/{tt}: only {len(ratios)} samples")
            continue
        med = max(0.5, min(3.0, round(median(ratios), 2)))
        tool_factors.setdefault(tool, {})[tt] = med
        mape = sum(abs(r - 1) for r in ratios) / len(ratios) * 100
        print(f"  {tool:30s} / {tt:16s}  n={len(ratios):4d}  median={med:.2f}  MAPE={mape:.1f}%")

    # Aggregate task-type factors (all tools combined, for backward compat)
    task_factors = {}
    for tt, ratios in sorted(task_type_ratios.items()):
        med = max(0.5, min(3.0, round(median(ratios), 2)))
        task_factors[tt] = med

    # Global correction factor
    all_ratios = [r["ratio"] for r in matched]
    global_factor = round(median(all_ratios), 2) if all_ratios else 1.44

    # Load existing reference DB and update
    with open(REF_DB) as f:
        db = json.load(f)

    db["taskTypeCorrectionFactors"] = task_factors
    db["toolTaskCorrectionFactors"] = tool_factors
    db["globalCorrectionFactor"] = global_factor
    db["source"] = "self-improvement-real-data-tool-aware"
    db["generatedAt"] = "2026-05-02T00:00:00Z"
    db["sampleSize"] = db.get("sampleSize", 0) + len(matched)

    with open(REF_DB, "w") as f:
        json.dump(db, f, indent=2)

    print(f"\n=== Updated {REF_DB} ===")
    print(f"Task-type factors: {json.dumps(task_factors, indent=2)}")
    print(f"Global factor: {global_factor}")
    print(f"Tool-specific tools: {list(tool_factors.keys())}")

    # Show the key difference for reference_class_estimate
    print("\n=== KEY: reference_class_estimate factors (tool-specific) ===")
    ref_class_factors = tool_factors.get("reference_class_estimate", {})
    for tt, f in sorted(ref_class_factors.items()):
        agg = task_factors.get(tt, 1.8)
        diff = f - agg
        print(f"  {tt:16s}  tool-specific={f:.2f}  aggregate={agg:.2f}  diff={diff:+.2f}")

if __name__ == "__main__":
    main()
