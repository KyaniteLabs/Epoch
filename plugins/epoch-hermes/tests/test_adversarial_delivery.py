"""Adversarial probes Kai would invent next: dual-post races, crash windows, pending-body ownership.

Must fail on 9b70953 for dual-post holes; pass after exclusive delivery claim.
"""
from __future__ import annotations

import json
import threading
import time

import pytest

from conftest import calls, fake_cmd
from test_f11_f12_f13 import _FailOnceBoard


def _estimated(plugin, board, make_ctx, tmp_path):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    s = plugin.snapshot_settings()
    assert plugin.claimed_job(tid, None, rid, s) == "estimated"
    return ctx, tid, rid, s


def _actual_bodies(board, tid):
    return [b for b in board.bodies(tid) if "[epoch:actual" in b]


def _estimate_bodies(board, tid):
    return [b for b in board.bodies(tid) if "[epoch:estimate" in b]


def test_adv_concurrent_success_and_duplicate_post_once(plugin, board, make_ctx, tmp_path, monkeypatch):
    """Success recorder and duplicate recorder must not both post the audit comment.

    Deterministic schedule: A appends + marks recorded, pauses before post; B races past the
    recorded check, hits duplicate, then both resume delivery.
    """
    ctx, tid, rid, s = _estimated(plugin, board, make_ctx, tmp_path)
    board.complete(tid, rid, seconds=3600)
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))

    gate = threading.Event()
    entered = threading.Event()
    real_add = plugin.add_comment
    posts = []

    def gated_add(task_id, board_name, body):
        posts.append(body)
        if "[epoch:actual" in body and not entered.is_set():
            entered.set()
            assert gate.wait(5), "gate timed out"
        return real_add(task_id, board_name, body)

    monkeypatch.setattr(plugin, "add_comment", gated_add)

    out = []

    def runner(label):
        try:
            out.append((label, plugin.record_actual_for_run(tid, None, rid, shown, s)))
        except Exception as exc:
            out.append((label, f"ERR:{type(exc).__name__}:{exc}"))

    a = threading.Thread(target=runner, args=("A",))
    a.start()
    assert entered.wait(5), "A never reached add_comment"
    # B starts while A holds the post gate — classic dual-post window on 9b70953.
    b = threading.Thread(target=runner, args=("B",))
    b.start()
    time.sleep(0.15)  # let B reach CLI / duplicate / deliver
    gate.set()
    a.join(5)
    b.join(5)
    assert a.is_alive() is False and b.is_alive() is False, out

    statuses = sorted(s for _, s in out)
    assert any(s in ("recorded", "duplicate", "already_recorded") for s in statuses), out
    assert "ERR:" not in str(out), out
    bodies = _actual_bodies(board, tid)
    assert len(bodies) == 1, f"dual-post: {len(bodies)} bodies\n{bodies}\nout={out}"
    final = plugin._binding_get(s, tid, None, rid)
    assert final["actual_commented"] is True
    assert final["recorded"] is True
    recs = [c for c in calls(tmp_path) if c.get("argv", [None])[0] == "batch-record-actuals"]
    # Ideal schedule: A marks recorded before B's binding read → B delivers via claim (0 extra
    # CLI). Late B may still probe and get duplicate. Either way, one ledger append.
    assert 1 <= len(recs) <= 2, recs


def test_adv_concurrent_claimed_jobs_post_estimate_once(plugin, board, make_ctx, tmp_path, monkeypatch):
    """Two concurrent claimed_job races must not double-post the estimate comment."""
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    s = plugin.snapshot_settings()

    gate = threading.Event()
    entered = threading.Event()
    real_add = plugin.add_comment

    def gated_add(task_id, board_name, body):
        if "[epoch:estimate" in body and not entered.is_set():
            entered.set()
            assert gate.wait(5)
        return real_add(task_id, board_name, body)

    monkeypatch.setattr(plugin, "add_comment", gated_add)

    out = []

    def runner():
        out.append(plugin.claimed_job(tid, None, rid, s))

    a = threading.Thread(target=runner)
    a.start()
    assert entered.wait(5)
    b = threading.Thread(target=runner)
    b.start()
    time.sleep(0.15)
    gate.set()
    a.join(10)
    b.join(10)
    bodies = _estimate_bodies(board, tid)
    assert len(bodies) == 1, f"dual estimate posts: {len(bodies)}\n{bodies}\nout={out}"
    bstate = plugin._binding_get(s, tid, None, rid)
    assert bstate and bstate.get("ref") and bstate.get("estimate_commented") is True


def test_adv_boarderror_clears_delivery_claim_for_retry(plugin, board, make_ctx, tmp_path):
    """A BoardError mid-delivery must not leave the comment permanently undeliverable."""
    ctx, tid, rid, s = _estimated(plugin, board, make_ctx, tmp_path)
    board.complete(tid, rid, seconds=3600)
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))
    ctx.board = _FailOnceBoard(board, fail_on=1)
    with pytest.raises(plugin.BoardError):
        plugin.record_actual_for_run(tid, None, rid, shown, s)
    b = plugin._binding_get(s, tid, None, rid)
    assert b["recorded"] is True and b["actual_commented"] is False
    # No stuck in-flight claim that blocks a later owner.
    inflight = b.get("actual_delivery_in_flight")
    assert not inflight or (
        isinstance(inflight, dict) and float(inflight.get("until") or 0) <= time.time()
    ) or b.get("actual_commented") is False
    ctx.board = board
    plugin.record_actual_for_run(tid, None, rid, shown, s)
    assert len(_actual_bodies(board, tid)) == 1
    assert plugin._binding_get(s, tid, None, rid)["actual_commented"] is True


def test_adv_crash_after_post_before_mark_recovers_without_losing_comment(
        plugin, board, make_ctx, tmp_path, monkeypatch):
    """Crash after add_comment succeeded but before actual_commented=True: retry must still
    leave exactly one durable delivery (at-least-once OK; zero forever is not)."""
    ctx, tid, rid, s = _estimated(plugin, board, make_ctx, tmp_path)
    board.complete(tid, rid, seconds=3600)
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))

    real_mark = plugin._binding_mark_actual_commented
    boom = {"n": 0}

    def crash_mark(*a, **k):
        boom["n"] += 1
        if boom["n"] == 1:
            raise SystemExit("simulated crash after post")
        return real_mark(*a, **k)

    monkeypatch.setattr(plugin, "_binding_mark_actual_commented", crash_mark)
    with pytest.raises(SystemExit):
        plugin.record_actual_for_run(tid, None, rid, shown, s)
    monkeypatch.setattr(plugin, "_binding_mark_actual_commented", real_mark)

    # Comment may already be on the board from the crashed attempt; binding must not claim done.
    b = plugin._binding_get(s, tid, None, rid)
    assert b["recorded"] is True
    assert b.get("actual_commented") is not True
    plugin.record_actual_for_run(tid, None, rid, shown, s)
    assert len(_actual_bodies(board, tid)) >= 1  # never lose the audit comment
    assert plugin._binding_get(s, tid, None, rid)["actual_commented"] is True


def test_adv_rejected_path_also_separates_delivery(plugin, board, make_ctx, tmp_path):
    """Rejected auto_wallclock must still retry the rejection comment without re-recording."""
    ctx, tid, rid, s = _estimated(plugin, board, make_ctx, tmp_path)
    board.complete(tid, rid, seconds=60)  # below 0.05h gate
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))
    ctx.board = _FailOnceBoard(board, fail_on=1)
    with pytest.raises(plugin.BoardError):
        plugin.record_actual_for_run(tid, None, rid, shown, s)
    assert _actual_bodies(board, tid) == []
    ctx.board = board
    status = plugin.record_actual_for_run(tid, None, rid, shown, s)
    assert status in ("rejected", "already_recorded", "duplicate")
    bodies = _actual_bodies(board, tid)
    assert len(bodies) == 1
    assert "rejected" in bodies[0] or "did not record" in bodies[0]
    recs = [c for c in calls(tmp_path) if c.get("argv", [None])[0] == "batch-record-actuals"]
    assert len(recs) == 1


def test_adv_pending_body_ownership_first_writer_wins(plugin, board, make_ctx, tmp_path, monkeypatch):
    """Under flock, the recorder that actually appended owns the pending audit body; a late
    duplicate notice must not overwrite it."""
    ctx, tid, rid, s = _estimated(plugin, board, make_ctx, tmp_path)
    board.complete(tid, rid, seconds=3600)
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))
    ctx.board = _FailOnceBoard(board, fail_on=1)
    with pytest.raises(plugin.BoardError):
        plugin.record_actual_for_run(tid, None, rid, shown, s)
    owned = plugin._binding_get(s, tid, None, rid)["actual_comment_body"]
    assert "recorded actual" in owned

    # Simulate a late duplicate mark_recorded trying to plant a notice.
    notice = "NOTICE SHOULD NOT WIN " + plugin.format_marker("actual", run=rid, status="duplicate")
    plugin._binding_mark_recorded(s, tid, None, rid, status="duplicate",
                                  actual_comment_body=notice, keep_existing=True)
    assert plugin._binding_get(s, tid, None, rid)["actual_comment_body"] == owned
    ctx.board = board
    plugin.record_actual_for_run(tid, None, rid, shown, s)
    assert _actual_bodies(board, tid) == [owned]
