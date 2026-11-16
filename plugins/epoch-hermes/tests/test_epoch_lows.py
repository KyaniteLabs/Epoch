"""Small fixes: sub-hour wording, no home paths in posted errors, outbox retries on completion."""
import os
import sys

from conftest import load_plugin


def test_hours_below_one_print_as_minutes():
    p = load_plugin()
    assert p._fmt_estimate_hours(0.004) == "1m"
    assert p._fmt_estimate_hours(0.25) == "15m"
    assert p._fmt_estimate_hours(0.999) == "60m"
    assert p._fmt_estimate_hours(1) == "1.0h"
    assert p._fmt_estimate_hours(20.8) == "20.8h"


def test_failure_text_never_carries_the_home_path(tmp_path, monkeypatch):
    p = load_plugin()
    home = tmp_path / "someone"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    script = tmp_path / "boom.py"
    script.write_text("import sys\nprint(sys.argv[1] + '/.epoch/ledger is locked', file=sys.stderr)\nsys.exit(2)\n")
    res = p.run_epoch(["x"], {"epoch_command": f"{sys.executable} {script} {home}"})
    assert res["ok"] is False
    assert str(home) not in res["error"] and "~/.epoch/ledger is locked" in res["error"]


def test_error_text_redacts_home_from_cli_and_exception_messages(tmp_path, monkeypatch):
    p = load_plugin()
    home = tmp_path / "private-home"
    monkeypatch.setenv("HOME", str(home))
    for error in (f"permission denied: {home}/plugin-data/epoch", {
            "message": f"permission denied: {home}/plugin-data/epoch",
    }):
        text = p._error_text({"error": error})
        assert str(home) not in text
        assert "~/plugin-data/epoch" in text


def test_completion_retries_the_outbox_at_most_every_interval(monkeypatch):
    p = load_plugin()
    replays = []
    monkeypatch.setattr(p, "replay_outbox", lambda: replays.append(1) or [])
    monkeypatch.setattr(p, "_cfg", lambda key, settings=None: False)  # record_actuals off
    clock = [1_000_000.0]
    monkeypatch.setattr(p.time, "time", lambda: clock[0])
    p._on_completed(task_id="t1")
    p._on_completed(task_id="t2")
    assert replays == [1]
    clock[0] += p.OUTBOX_REPLAY_INTERVAL_SECONDS + 1
    p._on_completed(task_id="t3")
    assert replays == [1, 1]


def test_finished_bindings_are_pruned_after_retention():
    p = load_plugin()
    now = 10_000_000.0
    old = now - p.BINDING_RETENTION_SECONDS - 1
    data = {
        "b:done:1": {"ref": "r", "recorded": True, "status": "recorded", "created_at": old,
                     "estimate_comment_body": "e", "estimate_commented": True,
                     "actual_comment_body": "a", "actual_commented": True},
        "b:ended:2": {"ref": "r", "recorded": False, "run_ended": "blocked", "created_at": old},
        "b:pending:3": {"ref": "r", "recorded": True, "status": "recorded", "created_at": old,
                        "actual_comment_body": "a", "actual_commented": False},
        "b:open:4": {"ref": "r", "recorded": False, "created_at": old},
        "b:fresh:5": {"ref": "r", "recorded": True, "status": "recorded", "created_at": now - 60},
        "b:legacy:6": {"ref": "r", "recorded": True, "status": "recorded"},
    }
    p._prune_finished_bindings(data, now=now)
    assert sorted(data) == ["b:fresh:5", "b:legacy:6", "b:open:4", "b:pending:3"]
    assert data["b:legacy:6"]["created_at"] == now, "untimestamped bindings start their clock"


def test_new_bindings_carry_a_timestamp(tmp_path):
    p = load_plugin()
    settings = {"epoch_data_dir": str(tmp_path)}
    p._binding_put_ref(settings, "t", "b", 1, "ref-1")
    assert isinstance(p._binding_get(settings, "t", "b", 1)["created_at"], float)
