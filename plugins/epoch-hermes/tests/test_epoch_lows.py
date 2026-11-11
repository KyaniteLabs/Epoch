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
