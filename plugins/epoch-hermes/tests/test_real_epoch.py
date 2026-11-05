"""Finding 7 against the real Epoch CLI: auto_wallclock actuals hit Epoch's own sanity gate.

Uses ``EPOCH_CLI`` (e.g. ``"node /path/to/Epoch/dist/index.js"``) or this repo's built
``dist/index.js``; skipped when neither is available. Writes only to a temp ``EPOCH_DATA_DIR``.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

REPO_DIST = Path(__file__).resolve().parents[3] / "dist" / "index.js"
CLI = os.environ.get("EPOCH_CLI") or (f"node {REPO_DIST}" if REPO_DIST.exists() and shutil.which("node") else "")

pytestmark = pytest.mark.skipif(not CLI, reason="no Epoch CLI (set EPOCH_CLI or build dist/)")


@pytest.mark.parametrize("seconds,status", [
    (2 * 3600, "recorded"),       # normal
    (60, "rejected"),             # < 0.05h
    (13 * 3600, "rejected"),      # > 12h
    (int(0.12 * 3600), "rejected"),  # >= 10x below a ~2h estimate
])
def test_real_epoch_gate(plugin, board, make_ctx, tmp_path, seconds, status):
    ledger = tmp_path / "ledger"
    ctx = make_ctx({"default": {"epoch_command": CLI, "epoch_data_dir": str(ledger), "iterations": 500}})
    tid = board.create("Add feature", "epoch: 1/2/3h")
    rid = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(60)
    assert any(f"[epoch:estimate run={rid} ref=" in b for b in board.bodies(tid)), board.bodies(tid)
    board.complete(tid, rid, seconds=seconds)
    assert plugin.completed_job(tid, None, rid, plugin.snapshot_settings()) == status
    feedback = [json.loads(l) for l in (ledger / "feedback.jsonl").read_text().splitlines()] \
        if (ledger / "feedback.jsonl").exists() else []
    actuals = [f for f in feedback if "actualHours" in json.dumps(f)]
    if status == "recorded":
        assert len(actuals) == 1
        assert "auto_wallclock" in json.dumps(actuals[0])
        # second attempt is a no-op (board marker) and Epoch would reject a duplicate anyway
        assert plugin.completed_job(tid, None, rid, plugin.snapshot_settings()) == "already_recorded"
    else:
        assert actuals == []
