"""Kai #11 recovery path (pass 4, @58e3280): an Epoch ledger ``duplicate`` is not proof the audit
comment was delivered. Must fail on 58e3280 and pass after the fix.
"""
from __future__ import annotations

import json

import pytest

from conftest import calls, fake_cmd
from test_f11_f12_f13 import _FailOnceBoard


def _estimated_and_completed(plugin, board, make_ctx, tmp_path):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    s = plugin.snapshot_settings()
    assert plugin.claimed_job(tid, None, rid, s) == "estimated"
    board.complete(tid, rid, seconds=3600)
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))
    return ctx, tid, rid, s, shown


def _actual_comments(board, tid):
    return [b for b in board.bodies(tid) if "[epoch:actual" in b]


def _records(tmp_path):
    return [c for c in calls(tmp_path) if c.get("argv", [None])[0] == "batch-record-actuals"]


def test_f11_crash_after_cli_append_before_binding_commit_still_comments(plugin, board, make_ctx,
                                                                        tmp_path):
    """Epoch append succeeded, process died before _binding_mark_recorded: retry sees duplicate."""
    _ctx, tid, rid, s, shown = _estimated_and_completed(plugin, board, make_ctx, tmp_path)
    ref = plugin._binding_get(s, tid, None, rid)["ref"]
    # The CLI append that "crashed" before the local binding commit.
    entry = {"estimate_id": ref, "actual_hours": 1.0, "notes": "crashed attempt",
             "calibration_provenance": plugin.AUTO_WALLCLOCK}
    res = plugin.run_epoch(["batch-record-actuals", "--entries", json.dumps([entry])], s)
    assert res.get("ok") and res["data"]["succeeded"] == 1
    assert plugin._binding_get(s, tid, None, rid).get("recorded") is False
    assert _actual_comments(board, tid) == []

    assert plugin.record_actual_for_run(tid, None, rid, shown, s) == "duplicate"
    bodies = _actual_comments(board, tid)
    assert len(bodies) == 1, board.bodies(tid)
    assert f"run={rid}" in bodies[0] and f"ref={ref}" in bodies[0]
    assert "already" in bodies[0].lower()  # truthful: we did not record it this time
    b = plugin._binding_get(s, tid, None, rid)
    assert b["recorded"] is True and b["actual_commented"] is True
    # Further retries are terminal and do not double-post or re-record.
    assert plugin.record_actual_for_run(tid, None, rid, shown, s) == "already_recorded"
    assert len(_actual_comments(board, tid)) == 1
    assert len(_records(tmp_path)) == 2  # crashed append + the one duplicate probe


def test_f11_crash_after_cli_duplicate_comment_failure_is_retried(plugin, board, make_ctx, tmp_path):
    """Duplicate path whose notice post fails must leave delivery pending, not done."""
    ctx, tid, rid, s, shown = _estimated_and_completed(plugin, board, make_ctx, tmp_path)
    ref = plugin._binding_get(s, tid, None, rid)["ref"]
    entry = {"estimate_id": ref, "actual_hours": 1.0, "notes": "crashed attempt",
             "calibration_provenance": plugin.AUTO_WALLCLOCK}
    assert plugin.run_epoch(["batch-record-actuals", "--entries", json.dumps([entry])], s)["ok"]

    ctx.board = _FailOnceBoard(board, fail_on=1)
    with pytest.raises(plugin.BoardError):
        plugin.record_actual_for_run(tid, None, rid, shown, s)
    assert plugin._binding_get(s, tid, None, rid).get("actual_commented") is False
    ctx.board = board
    assert plugin.record_actual_for_run(tid, None, rid, shown, s) == "duplicate"
    assert len(_actual_comments(board, tid)) == 1
    assert len(_records(tmp_path)) == 2  # retry delivered without probing Epoch again


def test_f11_concurrent_duplicate_recorder_vs_failed_comment(plugin, board, make_ctx, tmp_path,
                                                            monkeypatch):
    """A records + stores pending body, then BoardError; B (raced past the binding check) gets
    ``duplicate``. B must not mark the audit comment delivered without posting it."""
    ctx, tid, rid, s, shown = _estimated_and_completed(plugin, board, make_ctx, tmp_path)
    stale = plugin._binding_get(s, tid, None, rid)  # what B read before A committed
    assert stale["recorded"] is False

    # Recorder A: ledger append OK, binding stores pending body, comment post fails.
    ctx.board = _FailOnceBoard(board, fail_on=1)
    with pytest.raises(plugin.BoardError):
        plugin.record_actual_for_run(tid, None, rid, shown, s)
    ctx.board = board
    a = plugin._binding_get(s, tid, None, rid)
    assert a["recorded"] is True and a["actual_commented"] is False and a["actual_comment_body"]
    assert _actual_comments(board, tid) == []

    # Recorder B: its binding read predates A's commit, so it goes to the CLI and gets duplicate.
    real_get = plugin._binding_get
    seen = {"n": 0}

    def racing_get(*args, **kw):
        seen["n"] += 1
        return dict(stale) if seen["n"] == 1 else real_get(*args, **kw)

    monkeypatch.setattr(plugin, "_binding_get", racing_get)
    plugin.record_actual_for_run(tid, None, rid, shown, s)
    monkeypatch.setattr(plugin, "_binding_get", real_get)

    # Next retry (outbox replay of A) must not be a silent terminal no-op.
    plugin.record_actual_for_run(tid, None, rid, shown, s)
    bodies = _actual_comments(board, tid)
    assert len(bodies) == 1, board.bodies(tid)
    assert bodies[0] == a["actual_comment_body"]  # A's real "recorded" audit body, not a notice
    final = plugin._binding_get(s, tid, None, rid)
    assert final["status"] == "recorded" and final["actual_commented"] is True
    assert len(_records(tmp_path)) == 2  # A's append + B's duplicate probe; no third record
