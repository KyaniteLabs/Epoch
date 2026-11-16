"""E2: the outbox replay runs at most two jobs at once."""
from __future__ import annotations

import threading
import time
from pathlib import Path


PLUGIN_DIR = Path(__file__).resolve().parent.parent
def test_outbox_replay_runs_at_most_two_jobs_at_once(plugin, make_ctx):
    make_ctx({"default": {}})
    gauge = {"now": 0, "peak": 0, "done": 0}
    lock = threading.Lock()

    def fake_runner(task_id, board, run_id, settings, attempt=0):
        with lock:
            gauge["now"] += 1
            gauge["peak"] = max(gauge["peak"], gauge["now"])
        time.sleep(0.03)
        with lock:
            gauge["now"] -= 1
            gauge["done"] += 1
        return "ok"

    plugin._JOBS = {"claimed": fake_runner}
    for i in range(20):
        plugin._outbox_put({"id": f"claimed:-:t{i}:1", "kind": "claimed", "task_id": f"t{i}",
                            "board": None, "run_id": 1, "settings": {}, "created_at": time.time(),
                            "attempts": 0, "lease_until": 0})
    workers = plugin.replay_outbox()
    for t in workers:
        t.join(20)
    assert gauge["done"] == 20
    assert gauge["peak"] == 2
    assert len(workers) <= 2



def test_queued_job_whose_lease_lapsed_runs_once(plugin, make_ctx, monkeypatch):
    """A second replay takes over queued jobs whose lease lapsed before a worker reached them.

    Two workers hold the first two jobs, so the other four wait in the first pool's queue past a
    tiny lease. A second replay (another process in real life) re-picks and finishes them. When the
    first pool's workers then reach those jobs they must see they were taken over, not run them again.
    """
    make_ctx({"default": {}})
    monkeypatch.setattr(plugin, "_lease_seconds", lambda settings: 0.05)
    gate = threading.Event()
    runs: dict = {}
    lock = threading.Lock()

    def fake_runner(task_id, board, run_id, settings, attempt=0):
        with lock:
            runs[task_id] = runs.get(task_id, 0) + 1
        if task_id in ("t0", "t1"):
            assert gate.wait(10)
        return "ok"

    plugin._JOBS = {"claimed": fake_runner}
    for i in range(6):
        plugin._outbox_put({"id": f"claimed:-:t{i}:1", "kind": "claimed", "task_id": f"t{i}",
                            "board": None, "run_id": 1, "settings": {}, "created_at": time.time() - (10 - i),
                            "attempts": 0, "lease_until": 0, "owner_pid": 0})
    first = plugin.replay_outbox()
    time.sleep(0.2)  # the queued jobs' leases lapse while both workers are held
    second = plugin.replay_outbox()
    deadline = time.time() + 5
    while time.time() < deadline and sum(runs.get(f"t{i}", 0) for i in range(2, 6)) < 4:
        time.sleep(0.01)
    gate.set()
    for t in first + second:
        t.join(10)
    assert runs == {f"t{i}": 1 for i in range(6)}


def test_job_is_not_run_when_the_ownership_check_never_ran(plugin, make_ctx, monkeypatch):
    """If the outbox update fails (a lock timeout, say) the claim cannot be verified, so the worker
    leaves the job for a later replay instead of running it unchecked."""
    make_ctx({"default": {}})
    runs = []
    plugin._JOBS = {"claimed": lambda task_id, board, run_id, settings, attempt=0: runs.append(task_id) or "ok"}
    job = {"id": "claimed:-:t0:1", "kind": "claimed", "task_id": "t0", "board": None, "run_id": 1,
           "settings": {}, "created_at": time.time(), "attempts": 0, "lease_until": 0, "owner_pid": 0}
    plugin._outbox_put(job)
    real = plugin._outbox_update
    monkeypatch.setattr(plugin, "_outbox_update", lambda fn: None)  # the update failed, quietly
    assert plugin._claim_for_start(job) is False
    for t in plugin._start_pool([job]):
        t.join(10)
    assert runs == []
    monkeypatch.setattr(plugin, "_outbox_update", real)
    assert plugin._claim_for_start(job) is True


def test_job_is_not_run_when_the_claim_could_not_be_written(plugin, make_ctx, monkeypatch):
    """claim() succeeds in memory but the write to disk fails: the lease never landed, so the job
    must not start (another replay could otherwise run it too)."""
    ctx = make_ctx({"default": {}})
    runs = []
    plugin._JOBS = {"claimed": lambda task_id, board, run_id, settings, attempt=0: runs.append(task_id) or "ok"}
    job = {"id": "claimed:-:t0:1", "kind": "claimed", "task_id": "t0", "board": None, "run_id": 1,
           "settings": {}, "created_at": time.time(), "attempts": 0, "lease_until": 0, "owner_pid": 0}
    plugin._outbox_put(job)

    def boom(*args, **kwargs):
        raise OSError("disk full")

    # Run the mutator (the claim succeeds in memory), then fail the write.
    real_update = getattr(ctx.state, "update", None)
    if callable(real_update):
        def update_then_fail(key, mutator, default=None):
            mutator(ctx.state.get(key, default) or {})
            raise OSError("disk full")
        monkeypatch.setattr(ctx.state, "update", update_then_fail)
    monkeypatch.setattr(plugin, "_write_json_file", boom)
    assert plugin._claim_for_start(job) is False
    for t in plugin._start_pool([job]):
        t.join(10)
    assert runs == []
