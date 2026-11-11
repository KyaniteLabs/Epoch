"""A run whose completion hook never fired here still gets its actual recorded (roast E1)."""
from __future__ import annotations

import json
import logging

from conftest import calls, fake_cmd


def _records(tmp_path):
    return [c for c in calls(tmp_path) if c["argv"][0] == "batch-record-actuals"]


def _binding(plugin):
    path = plugin._epoch_data_dir(plugin.snapshot_settings()) / plugin.BINDINGS_FILE
    return json.loads(path.read_text())


def _claim_only(plugin, board, ctx, title="t", body="epoch: 1/2/3h"):
    tid = board.create(title, body)
    rid = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    return tid, rid


def test_a_missed_completion_is_recorded_with_a_warning(plugin, board, make_ctx, tmp_path, caplog):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid, rid = _claim_only(plugin, board, ctx)
    board.complete(tid, rid, seconds=3600)  # the worker profile finished it; no hook fired here
    assert not _records(tmp_path)
    with caplog.at_level(logging.WARNING):
        assert plugin.reconcile_missed_actuals(plugin.snapshot_settings()) == 1
        assert plugin.wait_for_inflight(15)
    assert len(_records(tmp_path)) == 1
    assert sum("[epoch:actual" in b for b in board.bodies(tid)) == 1
    assert any("never recorded" in r.getMessage() for r in caplog.records)
    # Recorded now, so a second pass has nothing to do.
    assert plugin.reconcile_missed_actuals(plugin.snapshot_settings()) == 0


def test_running_and_ended_runs_are_left_alone(plugin, board, make_ctx, tmp_path):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    running, _ = _claim_only(plugin, board, ctx, "a")
    ended, ended_rid = _claim_only(plugin, board, ctx, "b")
    board.reclaim(ended, ended_rid)
    assert plugin.reconcile_missed_actuals(plugin.snapshot_settings()) == 0
    assert plugin.wait_for_inflight(15)
    assert not _records(tmp_path)
    rows = _binding(plugin)
    assert [v.get("run_ended") for k, v in rows.items() if f":{ended}:" in k] == ["reclaimed"]
    assert all(not v.get("run_ended") for k, v in rows.items() if f":{running}:" in k)


def test_reconcile_respects_record_actuals_off(plugin, board, make_ctx, tmp_path):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path), "record_actuals": False,
                                "comment_on_claim": True}})
    tid, rid = _claim_only(plugin, board, ctx)
    board.complete(tid, rid)
    assert plugin.reconcile_missed_actuals(plugin.snapshot_settings()) == 0


def test_a_new_claim_triggers_a_throttled_pass(plugin, board, make_ctx, tmp_path, monkeypatch):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid, rid = _claim_only(plugin, board, ctx)
    board.complete(tid, rid, seconds=3600)
    monkeypatch.setattr(plugin, "_reconcile_last", 0.0)  # interval elapsed since load
    _claim_only(plugin, board, ctx, "next")
    for t in __import__("threading").enumerate():
        if t.name == "epoch-reconcile":
            t.join(15)
    assert plugin.wait_for_inflight(15)
    assert len(_records(tmp_path)) == 1
    # Within the interval, claims do not start another pass.
    assert plugin._maybe_reconcile() is None


def test_failing_bindings_cannot_starve_the_backlog(plugin, board, make_ctx, tmp_path):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid, rid = _claim_only(plugin, board, ctx)
    board.complete(tid, rid, seconds=3600)
    settings = plugin.snapshot_settings()

    def add_dead(data):
        for i in range(40):  # tasks the board no longer knows
            data[f"-:t_gone{i}:{i}"] = {"ref": f"r{i}", "recorded": False}

    plugin._bindings_update(settings, add_dead)
    for _ in range(100):  # chance of never sampling the live one: (36/41)**100, about 2e-6
        plugin.reconcile_missed_actuals(settings, limit=5)
        assert plugin.wait_for_inflight(15)
        if _records(tmp_path):
            break
    assert len(_records(tmp_path)) == 1
