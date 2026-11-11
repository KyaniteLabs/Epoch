"""A run whose completion hook never fired here still gets its actual recorded (roast E1)."""
from __future__ import annotations

import json
import logging
import time

from conftest import PROFILE, calls, fake_cmd


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


def test_dead_bindings_are_filtered_before_reconcile_sample(plugin, make_ctx, tmp_path, monkeypatch):
    make_ctx({"default": {"epoch_data_dir": str(tmp_path)}})
    settings = {"epoch_data_dir": str(tmp_path), "record_actuals": True}
    live_key = plugin._binding_key("t_live", None, 99)
    plugin._bindings_update(settings, lambda data: data.update({
        **{f"-:gone{i}:{i}": {"ref": f"dead-{i}"} for i in range(30)},
        live_key: {"ref": "live-ref"},
    }))
    dead_path = plugin._dead_letter_path(settings)
    dead_path.write_text("".join(json.dumps({"id": plugin._job_id("completed", f"gone{i}", None, i)}) + "\n"
                            for i in range(30)))
    plugin._outbox_update(lambda box: box.update({
        plugin._job_id("completed", "t_live", None, 99): {"id": plugin._job_id("completed", "t_live", None, 99)}
    }))
    sampled = []
    monkeypatch.setattr(plugin.random, "sample", lambda population, count: sampled.extend(population) or population[:count])
    monkeypatch.setattr(plugin, "show_task", lambda *_: {"runs": []})

    plugin.reconcile_missed_actuals(settings, limit=1)

    assert sampled == []  # dead and outbox IDs are removed before the bounded sample


def test_corrupt_dead_letter_line_does_not_hide_valid_ids(plugin, make_ctx, tmp_path):
    make_ctx({"default": {"epoch_data_dir": str(tmp_path)}})
    path = plugin._dead_letter_path({"epoch_data_dir": str(tmp_path)})
    path.write_text('{"id":"valid-before"}\nnot-json\n{"id":"valid-after"}\n')

    assert plugin._dead_letter_ids({"epoch_data_dir": str(tmp_path)}) == {"valid-before", "valid-after"}


def test_dead_lettered_actual_is_not_enqueued_again(plugin, make_ctx, tmp_path, monkeypatch):
    make_ctx({"default": {"epoch_data_dir": str(tmp_path)}})
    settings = plugin.snapshot_settings()
    key = plugin._binding_key("t_dead", None, 7)
    plugin._bindings_update(settings, lambda data: data.__setitem__(key, {"ref": "ref-dead"}))
    monkeypatch.setattr(plugin, "show_task", lambda *_: {"runs": [{
        "id": 7, "outcome": "completed", "started_at": 1, "ended_at": 2,
    }]})
    job = {"id": plugin._job_id("completed", "t_dead", None, 7), "kind": "completed",
           "task_id": "t_dead", "board": None, "run_id": 7, "settings": settings,
           "created_at": time.time(), "attempts": plugin.OUTBOX_MAX_ATTEMPTS,
           "last_error": "permanent failure"}
    plugin._dead_letter(job, "attempts_exhausted")

    assert plugin.reconcile_missed_actuals(settings) == 0
    assert plugin._job_id("completed", "t_dead", None, 7) not in make_ctx_state(plugin)


def make_ctx_state(plugin):
    return plugin._ctx.state.get(plugin.OUTBOX_KEY, {})


def test_reconcile_runs_epoch_jobs_sequentially(plugin, make_ctx, tmp_path, monkeypatch):
    make_ctx({"default": {"epoch_data_dir": str(tmp_path), "record_actuals": False}})
    settings = {"epoch_data_dir": str(tmp_path), "record_actuals": True}
    bindings = {plugin._binding_key(f"t_{i}", None, i): {"ref": f"ref-{i}"}
                for i in range(4)}
    plugin._bindings_update(settings, lambda data: data.update(bindings))
    monkeypatch.setattr(plugin, "show_task", lambda task_id, _board: {"runs": [{
        "id": int(task_id[2:]), "outcome": "completed", "started_at": 1, "ended_at": 2,
    }]})
    active = peak = 0

    def slow_completed(*_args, **_kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        time.sleep(0.03)
        active -= 1
        return "done"

    monkeypatch.setitem(plugin._JOBS, "completed", slow_completed)
    assert plugin.reconcile_missed_actuals(settings, limit=4) == 4
    assert plugin.wait_for_inflight(5)
    assert peak == 1


def test_maybe_reconcile_keeps_dispatcher_context(plugin, board, make_ctx, tmp_path, monkeypatch):
    ctx = make_ctx({"default": {}, "dispatcher": {"epoch_data_dir": str(tmp_path)}})
    task_id = board.create("completed task")
    run_id = board.claim(task_id)
    board.complete(task_id, run_id)
    settings = {"epoch_data_dir": str(tmp_path), "record_actuals": True}
    key = plugin._binding_key(task_id, None, run_id)
    plugin._bindings_update(settings, lambda data: data.__setitem__(key, {"ref": "ref-1"}))
    monkeypatch.setattr(plugin, "_reconcile_last", 0.0)

    token = PROFILE.set("dispatcher")
    try:
        thread = plugin._maybe_reconcile()
    finally:
        PROFILE.reset(token)
    assert thread is not None
    thread.join(5)
    assert ("dispatcher", "kanban_show") in [call[:2] for call in ctx.dispatch_calls]
