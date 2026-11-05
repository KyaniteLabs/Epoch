"""Regressions for Kai findings #11 (comment delivery vs binding), #12 (JSON empty-on-error),
#13 (tempfile umask loses 0600). Must fail on bf1a52d and pass after the fix.
"""
from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path

import pytest

from conftest import PROFILE, calls, fake_cmd, load_plugin


# --------------------------------------------------------------------------- #11 helpers


class _FailOnceBoard:
    """Wrap FakeBoard so the Nth kanban_comment raises BoardError once."""

    def __init__(self, board, fail_on=1):
        self._board = board
        self._fail_on = fail_on
        self._comments = 0
        self.lock = board.lock

    def __getattr__(self, name):
        return getattr(self._board, name)

    def dispatch(self, tool, args):
        if tool == "kanban_comment":
            self._comments += 1
            if self._comments == self._fail_on:
                return json.dumps({"error": "transient board failure"})
        return self._board.dispatch(tool, args)


def test_f11_claim_retries_estimate_comment_after_transient_board_error(plugin, board, make_ctx, tmp_path):
    """Binding must not suppress the estimate comment when the first post raises."""
    flaky = _FailOnceBoard(board, fail_on=1)
    # Re-wire make_ctx's registered ctx onto the flaky board.
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    ctx.board = flaky
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    # Drive claimed_job directly so we can catch + retry without outbox timing.
    s = plugin.snapshot_settings()
    with pytest.raises(plugin.BoardError):
        plugin.claimed_job(tid, None, rid, s)
    # Binding exists (ref persisted) but no comment yet.
    assert board.bodies(tid) == []
    status = plugin.claimed_job(tid, None, rid, s)
    assert status.startswith("estimated")
    bodies = board.bodies(tid)
    assert any("[epoch:estimate" in b for b in bodies), bodies
    assert any("Epoch" in b or "P50" in b or "estimate" in b.lower() for b in bodies)


def test_f11_completion_retries_actual_comment_without_rerecording(plugin, board, make_ctx, tmp_path):
    """recorded=True before comment must still deliver the audit comment on retry."""
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    s = plugin.snapshot_settings()
    assert plugin.claimed_job(tid, None, rid, s) == "estimated"
    assert any("[epoch:estimate" in b for b in board.bodies(tid))
    board.complete(tid, rid, seconds=3600)
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))

    # First completion: Epoch records OK, then comment fails.
    flaky = _FailOnceBoard(board, fail_on=1)
    ctx.board = flaky
    with pytest.raises(plugin.BoardError):
        plugin.record_actual_for_run(tid, None, rid, shown, s)
    assert sum("[epoch:actual" in b for b in board.bodies(tid)) == 0
    # Exactly one batch-record-actuals so far.
    recs = [c for c in calls(tmp_path) if c.get("argv", [None])[0] == "batch-record-actuals"]
    assert len(recs) == 1

    # Retry: must post the comment without a second Epoch record.
    status = plugin.record_actual_for_run(tid, None, rid, shown, s)
    assert status in ("recorded", "already_recorded")
    assert sum("[epoch:actual" in b for b in board.bodies(tid)) == 1
    recs2 = [c for c in calls(tmp_path) if c.get("argv", [None])[0] == "batch-record-actuals"]
    assert len(recs2) == 1  # no re-record


def test_f11_crash_between_persist_and_comment_is_recoverable(plugin, board, make_ctx, tmp_path):
    """Simulate crash after binding persist, before comment: retry delivers comment only."""
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    s = plugin.snapshot_settings()
    # Persist binding the way claimed_job would, without posting.
    result = plugin.estimate("t", "epoch: 1/2/3h", settings=s)
    ref = result["feedbackRef"]
    assert ref
    body = f"{result['summary']} {plugin.format_marker('estimate', run=rid, ref=ref)}".strip()
    plugin._binding_put_ref(s, tid, None, rid, str(ref))
    # If the API supports storing the pending comment body, put it; otherwise the fix must.
    put = getattr(plugin, "_binding_put_ref", None)
    # Manually ensure pending delivery state as the fixed code would after a crash mid-flight:
    # ref present, estimate_commented false. Call the helper if the fix exposes it.
    if hasattr(plugin, "_binding_set_pending_estimate_comment"):
        plugin._binding_set_pending_estimate_comment(s, tid, None, rid, body)
    else:
        # Pre-fix shape: only ref. claimed_job must still recover after the fix.
        path = plugin._epoch_data_dir(s) / plugin.BINDINGS_FILE
        data = json.loads(path.read_text())
        key = plugin._binding_key(tid, None, rid)
        # Leave as-is (ref only) — fix should either re-estimate-comment from stored body
        # or treat missing estimate_commented as needing delivery. Seed body for the fix.
        data[key]["estimate_comment_body"] = body
        data[key]["estimate_commented"] = False
        path.write_text(json.dumps(data, indent=2))

    assert board.bodies(tid) == []
    status = plugin.claimed_job(tid, None, rid, s)
    assert status.startswith("estimated")
    assert any("[epoch:estimate" in b for b in board.bodies(tid))


# --------------------------------------------------------------------------- #12


def test_f12_bom_prefixed_valid_state_is_not_wiped(plugin, tmp_path):
    path = tmp_path / "state.json"
    prior = {"outbox": {"claimed:-:old:1": {"id": "claimed:-:old:1"}}, "other": {"keep": True}}
    path.write_bytes(b"\xef\xbb\xbf" + json.dumps(prior).encode("utf-8"))
    # Read must succeed (utf-8-sig) and preserve content through an outbox put.
    data = plugin._read_json_file(path)
    assert data["other"] == {"keep": True}
    assert "claimed:-:old:1" in data["outbox"]

    class Ctx:
        state = type("S", (), {"path": path})()

    plugin._ctx = Ctx()
    plugin._outbox_put({"id": "claimed:-:new:2", "kind": "claimed", "task_id": "new",
                        "board": None, "run_id": 2, "attempts": 0})
    final = json.loads(path.read_text(encoding="utf-8-sig"))
    assert "claimed:-:old:1" in final["outbox"]
    assert "claimed:-:new:2" in final["outbox"]
    assert final["other"] == {"keep": True}


def test_f12_malformed_json_is_not_overwritten(plugin, tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not-json", encoding="utf-8")
    before = path.read_bytes()
    with pytest.raises((RuntimeError, ValueError, json.JSONDecodeError)):
        plugin._read_json_file(path)

    class Ctx:
        state = type("S", (), {"path": path})()

    plugin._ctx = Ctx()
    plugin._outbox_put({"id": "claimed:-:x:1", "kind": "claimed", "task_id": "x",
                        "board": None, "run_id": 1, "attempts": 0})
    # File must remain untouched (outbox_update fails closed).
    assert path.read_bytes() == before


def test_f12_missing_file_means_empty(plugin, tmp_path):
    path = tmp_path / "nope.json"
    assert plugin._read_json_file(path) == {}


# --------------------------------------------------------------------------- #13


def test_f13_write_retains_mode_0600_under_umask022(plugin, tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{}", encoding="utf-8")
    os.chmod(path, 0o600)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600

    old = os.umask(0o022)
    try:
        plugin._write_json_file(path, {"outbox": {"a": 1}})
    finally:
        os.umask(old)

    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600, f"expected 0600 after write under umask022, got {oct(mode)}"
    assert json.loads(path.read_text()) == {"outbox": {"a": 1}}


def test_f13_new_file_is_created_private(plugin, tmp_path):
    path = tmp_path / "fresh.json"
    old = os.umask(0o022)
    try:
        plugin._write_json_file(path, {"x": 1})
    finally:
        os.umask(old)
    assert path.exists()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
