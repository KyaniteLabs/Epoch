"""EP-LINT: a failing outbox job records its error (the closure used an out-of-scope name)."""
import time


def test_failed_job_keeps_its_error_and_bumps_attempts(plugin, make_ctx):
    ctx = make_ctx({"default": {}})

    def boom(task_id, board, run_id, settings, attempt=0):
        raise RuntimeError("board gone")

    plugin._JOBS = {"claimed": boom}
    job = {"id": "claimed:-:t1:1", "kind": "claimed", "task_id": "t1", "board": None, "run_id": 1,
           "settings": {}, "created_at": time.time(), "attempts": 0, "lease_until": 0}
    plugin._outbox_put(job)
    plugin._run_job(dict(job))
    row = ctx.state.get(plugin.OUTBOX_KEY, {})[job["id"]]
    assert row["attempts"] == 1
    assert row["last_error"] == "RuntimeError: board gone"
    assert row["lease_until"] == 0
