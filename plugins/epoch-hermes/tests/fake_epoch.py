#!/usr/bin/env python3
"""Deterministic stand-in for the Epoch CLI used by the plugin tests.

State lives in $EPOCH_DATA_DIR (default ./.fake-epoch): calls.jsonl logs every argv (plus the
caller's FAKE_EPOCH_TAG/HERMES_HOME), actuals.json mirrors Epoch's one-actual-per-estimate rule
and the auto_wallclock write-time gate (0.05–12h, <10x the estimate).

Knobs: FAKE_EPOCH_BLOCK_FILE — a monte-carlo/reference call waits until this file exists;
FAKE_EPOCH_SLEEP — seconds to sleep on estimate calls; FAKE_EPOCH_MODE=timeout|nonzero|garbage.
"""
import fcntl
import json
import os
import sys
import time
import uuid

data_dir = os.environ.get("EPOCH_DATA_DIR") or os.path.join(os.getcwd(), ".fake-epoch")
os.makedirs(data_dir, exist_ok=True)
argv = sys.argv[1:]
cmd = argv[0] if argv else ""
opts = {argv[i]: argv[i + 1] for i in range(1, len(argv) - 1) if argv[i].startswith("--")}


def log(extra=None):
    with open(os.path.join(data_dir, "calls.jsonl"), "a") as f:
        f.write(json.dumps({"argv": argv, "tag": os.environ.get("FAKE_EPOCH_TAG"),
                            "hermes_home": os.environ.get("HERMES_HOME"),
                            "env_keys": sorted(os.environ), "telemetry": os.environ.get("EPOCH_TELEMETRY"),
                            **(extra or {})}) + "\n")


mode = os.environ.get("FAKE_EPOCH_MODE", "")
if mode == "timeout":
    time.sleep(30)
if mode == "nonzero":
    print("boom", file=sys.stderr)
    sys.exit(3)
if mode == "garbage":
    print("not json at all")
    sys.exit(0)

if cmd in ("monte-carlo-schedule", "reference-class-estimate"):
    block = os.environ.get("FAKE_EPOCH_BLOCK_FILE")
    if block:
        deadline = time.time() + 20
        while not os.path.exists(block) and time.time() < deadline:
            time.sleep(0.02)
    time.sleep(float(os.environ.get("FAKE_EPOCH_SLEEP", "0") or 0))
    ref = "est-" + uuid.uuid4().hex[:12]
    if cmd == "monte-carlo-schedule":
        task = json.loads(opts["--tasks"])[0]
        ml_days = float(task["most_likely"])
        est_hours = ml_days * 8
        data = {"p50": ml_days, "p80": ml_days * 1.2, "p90": ml_days * 1.3, "p95": ml_days * 1.4,
                "feedbackRef": ref}
    else:
        est_hours = 4.0
        data = {"correctedEstimate": est_hours, "confidence": "medium", "feedbackRef": ref}
    with open(os.path.join(data_dir, "estimates.jsonl"), "a") as f:
        f.write(json.dumps({"id": ref, "hours": est_hours}) + "\n")
    log({"ref": ref})
    print(json.dumps({"ok": True, "data": data}))
    sys.exit(0)

if cmd == "batch-record-actuals":
    entries = json.loads(opts["--entries"])
    estimates = {}
    path = os.path.join(data_dir, "estimates.jsonl")
    if os.path.exists(path):
        for line in open(path):
            e = json.loads(line)
            estimates[e["id"]] = e["hours"]
    lock = open(os.path.join(data_dir, ".lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    apath = os.path.join(data_dir, "actuals.json")
    actuals = json.load(open(apath)) if os.path.exists(apath) else {}
    errors, ok = [], 0
    for e in entries:
        eid, hrs = e["estimate_id"], float(e["actual_hours"])
        reason = None
        if hrs <= 0:
            reason = "below_threshold"
        elif eid in actuals:
            reason = "duplicate"
        elif e.get("calibration_provenance") == "auto_wallclock":
            est = estimates.get(eid)
            ratio_bad = est is not None and est > 0 and (hrs / est >= 10 or est / hrs >= 10)
            if hrs < 0.05 or hrs > 12 or ratio_bad:
                reason = "auto_wallclock_out_of_bounds"
        if reason:
            errors.append(f"Failed to record actual for estimate {eid} (reason: {reason})")
        else:
            actuals[eid] = e
            ok += 1
    json.dump(actuals, open(apath, "w"))
    log({"entries": entries})
    if ok == 0:
        print(json.dumps({"ok": False, "error": {"isError": True, "message": f"All {len(entries)} entries failed to record. First failure: {errors[0]}"}}))
    else:
        print(json.dumps({"ok": True, "data": {"total": len(entries), "succeeded": ok, "failed": len(errors), "errors": errors}}))
    sys.exit(0)

log()
print(json.dumps({"ok": True, "data": {"humanReadable": f"fake {cmd}"}}))
