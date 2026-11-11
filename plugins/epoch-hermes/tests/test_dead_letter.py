"""An outbox job the plugin gives up on is written down, never dropped silently."""
import json
import time


def _job(attempts, created_at=None):
    return {"id": "claimed:-:t9:1", "kind": "claimed", "task_id": "t9", "board": None,
            "run_id": 1, "settings": {}, "created_at": created_at or time.time(),
            "attempts": attempts, "last_error": "BoardError: gone", "lease_until": 0}


def _box(ctx, plugin):
    return ctx.state.get(plugin.OUTBOX_KEY, {})


def test_exhausted_job_is_dead_lettered_and_counted(plugin, make_ctx, tmp_path):
    ctx = make_ctx({"default": {}})
    job = _job(plugin.OUTBOX_MAX_ATTEMPTS)
    job["settings"] = {"epoch_data_dir": str(tmp_path)}
    plugin._outbox_put(job)
    assert job["id"] in _box(ctx, plugin)
    assert plugin.replay_outbox() == []
    assert job["id"] not in _box(ctx, plugin)
    (row,) = [json.loads(x) for x in (tmp_path / plugin.DEAD_LETTER_FILE).read_text().splitlines()]
    assert row["reason"] == "attempts_exhausted" and row["task_id"] == "t9"
    assert row["last_error"] == "BoardError: gone"
    assert plugin.dead_letter_count({"epoch_data_dir": str(tmp_path)}) == 1


def test_too_old_job_is_dead_lettered(plugin, make_ctx, tmp_path):
    make_ctx({"default": {}})
    job = _job(0, created_at=time.time() - plugin.OUTBOX_MAX_AGE_SECONDS - 60)
    job["settings"] = {"epoch_data_dir": str(tmp_path)}
    plugin._outbox_put(job)
    plugin.replay_outbox()
    row = json.loads((tmp_path / plugin.DEAD_LETTER_FILE).read_text())
    assert row["reason"] == "too_old"


def test_data_status_reports_the_dead_letter_count(plugin, make_ctx, tmp_path, monkeypatch):
    make_ctx({"default": {"epoch_data_dir": str(tmp_path)}})
    monkeypatch.setattr(plugin, "run_epoch", lambda args, **_: {"ok": True, "data": {"humanReadable": "Ledger: 3 rows"}})
    assert plugin._slash("data status").endswith("abandoned after retries: 0.")
    (tmp_path / plugin.DEAD_LETTER_FILE).write_text('{"id": "a"}\n{"id": "b"}\n')
    out = plugin._slash("data status")
    assert out.startswith("Ledger: 3 rows") and "abandoned after retries: 2 " in out
    assert str(tmp_path) not in out   # a gateway user never sees a host path
    assert "abandoned" not in plugin._slash("pert-estimate --optimistic 1 --most-likely 2 --pessimistic 3")
