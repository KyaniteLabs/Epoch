"""Native regression tests for Kai's REQUEST CHANGES findings on Epoch PR #273.

Each test names the finding it pins. Run: ``python -m pytest plugins/epoch-hermes/tests``.
"""
from __future__ import annotations

import json
import re
import sys
import threading
import time
from pathlib import Path

import pytest

from conftest import PROFILE, PLUGIN_DIR, calls, fake_cmd


def _run_in_profile(profile, fn, *args, **kw):
    tok = PROFILE.set(profile)
    try:
        return fn(*args, **kw)
    finally:
        PROFILE.reset(tok)


def _record_calls(tmp):
    return [c for c in calls(tmp) if c["argv"][0] == "batch-record-actuals"]


def _estimate_calls(tmp):
    return [c for c in calls(tmp) if c["argv"][0] in ("monte-carlo-schedule", "reference-class-estimate")]


# ---------------------------------------------------------------- finding 1: profile context


def test_f1_background_job_keeps_the_hook_profile(plugin, board, make_ctx, tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(a, "default")},
                    "coder": {"epoch_command": fake_cmd(b, "coder")}})
    tid = board.create("Fix crash", "epoch: 1/2/4h")
    rid = board.claim(tid)
    _run_in_profile("coder", ctx.hooks["kanban_task_claimed"], task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    # settings: the coder profile's epoch_command ran, never the default one
    assert [c["tag"] for c in _estimate_calls(b)] == ["coder"]
    assert _estimate_calls(a) == []
    # board/state: every board call and outbox write happened under the originating profile
    assert {p for p, _, _ in ctx.dispatch_calls} == {"coder"}
    assert ctx.state_store.get("coder", {}).get("outbox") == {}
    assert "default" not in ctx.state_store or not ctx.state_store["default"].get("outbox")


def test_f1_settings_snapshot_taken_in_hook_context(plugin, make_ctx, tmp_path):
    make_ctx({"default": {"iterations": 111}, "coder": {"iterations": 222}})
    assert _run_in_profile("coder", plugin.snapshot_settings)["iterations"] == 222
    assert _run_in_profile("default", plugin.snapshot_settings)["iterations"] == 111


# ---------------------------------------------------------------- finding 2: event order


@pytest.mark.parametrize("order", ["claim_then_complete", "complete_before_estimate"])
def test_f2_actual_recorded_in_both_event_orders(plugin, board, make_ctx, tmp_path, order):
    gate = tmp_path / "release"
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path, "d", FAKE_EPOCH_BLOCK_FILE=gate)}})
    tid = board.create("Add feature", "epoch: 1/2/3h")
    rid = board.claim(tid)
    if order == "claim_then_complete":
        gate.touch()
        ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
        assert plugin.wait_for_inflight(15)
        board.complete(tid, rid, seconds=2 * 3600)
        ctx.hooks["kanban_task_completed"](task_id=tid, run_id=rid)
    else:
        ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)  # estimate blocks on gate
        time.sleep(0.3)
        board.complete(tid, rid, seconds=2 * 3600)
        ctx.hooks["kanban_task_completed"](task_id=tid, run_id=rid)  # finds no estimate yet
        time.sleep(0.3)
        gate.touch()
    assert plugin.wait_for_inflight(15)
    recs = _record_calls(tmp_path)
    assert len(recs) == 1, recs
    assert recs[0]["entries"][0]["actual_hours"] == 2.0
    bodies = board.bodies(tid)
    assert sum("[epoch:actual" in b for b in bodies) == 1
    assert sum("[epoch:estimate" in b for b in bodies) == 1


def test_f2_repeated_completion_is_idempotent(plugin, board, make_ctx, tmp_path):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    board.complete(tid, rid, seconds=3600)
    for _ in range(3):
        ctx.hooks["kanban_task_completed"](task_id=tid, run_id=rid)
        assert plugin.wait_for_inflight(15)
    assert sum("[epoch:actual" in b for b in board.bodies(tid)) == 1
    assert len(_record_calls(tmp_path)) == 1  # later calls short-circuit on the board marker


def test_f2_concurrent_recorders_record_once(plugin, board, make_ctx, tmp_path):
    """Both sides reach record at once: Epoch's duplicate rejection keeps it to one actual."""
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    board.complete(tid, rid, seconds=3600)
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))
    s = plugin.snapshot_settings()
    out = []
    ts = [threading.Thread(target=lambda: out.append(plugin.record_actual_for_run(tid, None, rid, shown, s)))
          for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    # The lock is now polled (E3), so the loser may arrive after the winner finished and see
    # "already_recorded" instead of Epoch's "duplicate". Either way exactly one actual lands.
    assert sorted(out)[1] == "recorded" and sorted(out)[0] in ("duplicate", "already_recorded")
    assert sum("[epoch:actual" in b for b in board.bodies(tid)) == 1


# ---------------------------------------------------------------- finding 3: explicit > hints


@pytest.mark.parametrize("where", ["title", "body"])
def test_f3_explicit_triple_overrides_text_hints(plugin, make_ctx, tmp_path, where):
    make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    title, body = ("Task epoch: 1/2/3h", "") if where == "title" else ("Task", "epoch: 1/2/3h")
    out = json.loads(plugin._tool({"title": title, "body": body,
                                   "optimistic": 10, "most_likely": 20, "pessimistic": 30}))
    assert out["method"] == "monte_carlo"
    task = json.loads(_estimate_calls(tmp_path)[-1]["argv"][2])[0]
    assert (task["optimistic"], task["most_likely"], task["pessimistic"]) == (1.25, 2.5, 3.75)
    assert "explicit 10/20/30h" in out["summary"]


@pytest.mark.parametrize("where", ["title", "body"])
def test_f3_hint_in_title_or_body_is_used(plugin, make_ctx, tmp_path, where):
    make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    title, body = ("Task epoch: 2/4/8h", "") if where == "title" else ("Task", "notes\nestimate: 1-2-3 d")
    r = plugin.estimate(title, body)
    task = json.loads(_estimate_calls(tmp_path)[-1]["argv"][2])[0]
    expected = (0.25, 0.5, 1.0) if where == "title" else (1.0, 2.0, 3.0)
    assert (task["optimistic"], task["most_likely"], task["pessimistic"]) == expected
    assert r["method"] == "monte_carlo"


@pytest.mark.parametrize("args,needle", [
    ({"optimistic": -1, "most_likely": 2, "pessimistic": 3}, "must be > 0"),
    ({"optimistic": 1, "most_likely": 2}, "missing pessimistic"),
    ({"optimistic": 5, "most_likely": 2, "pessimistic": 3}, "optimistic <= most_likely"),
    ({"optimistic": 1, "most_likely": 2, "pessimistic": float("inf")}, "finite"),
    ({"optimistic": 1, "most_likely": 2, "pessimistic": 1e9}, "exceeds"),
    ({"optimistic": "x", "most_likely": 2, "pessimistic": 3}, "must be a number"),
    ({"optimistic": True, "most_likely": 2, "pessimistic": 3}, "must be a number"),
])
def test_f3_invalid_explicit_triple_is_rejected_not_downgraded(plugin, make_ctx, tmp_path, args, needle):
    make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    out = json.loads(plugin._tool({"title": "t", **args}))
    assert needle in out["error"]
    assert _estimate_calls(tmp_path) == []  # never silently fell back to reference class


@pytest.mark.parametrize("hint", ["estimate: 1..2/3/4h", "epoch: 5/2/1h", "epoch: 0/1/2", "epoch: 1/2"])
def test_f3_malformed_hint_fails_visibly(plugin, make_ctx, tmp_path, hint):
    make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    r = plugin.estimate("Add widget", hint)  # must not raise
    assert r["method"] == "reference_class"
    assert r["hint_error"] and "Ignored" in r["summary"]
    out = json.loads(plugin._tool({"title": "Add widget", "body": hint}))
    assert out["hint_error"]


@pytest.mark.parametrize("hint,expected", [
    ("epoch: 30/45/90 min", (0.5, 0.75, 1.5)),
    ("epoch: 30/45/90m", (0.5, 0.75, 1.5)),
    ("estimate: 1-2-3 weeks", (40.0, 80.0, 120.0)),
    ("epoch: 1/2/3 days", (8.0, 16.0, 24.0)),
    ("epoch: 2/4/10h", (2.0, 4.0, 10.0)),
])
def test_hint_units_convert_to_hours(plugin, hint, expected):
    hint_out, problem = plugin.find_hint("", hint)
    assert problem is None
    assert tuple(hint_out.values()) == pytest.approx(expected)


@pytest.mark.parametrize("hint", ["epoch: 1/2/3 sprints", "epoch: 1/2/3 months", "estimate: 5/8/13 points",
                                  "epoch: 10/20/30 secs", "epoch: 1/2/3 fortnights",
                                  "epoch: 1/2/3 business days", "epoch: 1/2/3 person-days",
                                  "epoch: 1/2/3 ms", "epoch: 1/2/3 M",
                                  "epoch: 1/2/3 story-points",
                                  "epoch: 2/4/10 business days, roughly",
                                  "epoch: 2/4/10 business days for the migration",
                                  "epoch: 3/5/8 story points (rough)",
                                  "epoch: 1/2/4 fortnights, maybe more",
                                  "epoch: 2/4/10 dev days - owner",
                                  "epoch: 2/4/10 for the API",
                                  "epoch: 2/4/10 días",
                                  "estimate: 1/2/26 ship date, tbc",
                                  "epoch: 1/2/3 fortnights to finish this task",
                                  "epoch: 1/2/3 ms per operation",
                                  "epoch: 2/4/10, sprints", "epoch: 2/4/10 (sprints)",
                                  "epoch: 2/4/10; months",
                                  "epoch: 2/4/10 - weeks of work", "epoch: 2/4/10 ~sprints"])
def test_hint_with_unknown_unit_is_refused_not_read_as_hours(plugin, hint):
    hint_out, problem = plugin.find_hint("", hint)
    assert hint_out is None and ("unit" in problem or "text after the estimate" in problem)


@pytest.mark.parametrize("hint,expected", [
    ("epoch: 2/4/10 roughly", (2.0, 4.0, 10.0)),
    ("epoch: 2/4/10 approx", (2.0, 4.0, 10.0)),
    ("epoch: 2/4/10 maybe", (2.0, 4.0, 10.0)),
    ("epoch: 2/4/10 days, roughly", (16.0, 32.0, 80.0)),
    ("epoch: 2/4/10 (rough)", (2.0, 4.0, 10.0)),
    ("epoch: 2/4/10!", (2.0, 4.0, 10.0)),
    ("epoch: 2/4/10h for the API", (2.0, 4.0, 10.0)),
])
def test_hint_allows_units_and_unitless_qualifiers(plugin, hint, expected):
    hint_out, problem = plugin.find_hint("", hint)
    assert problem is None
    assert tuple(hint_out.values()) == pytest.approx(expected)


@pytest.mark.parametrize("hint,expected", [
    ("epoch: 2/4/10 (hours)", (2.0, 4.0, 10.0)),
    ("epoch: 2/4/10 (h)", (2.0, 4.0, 10.0)),
    ("epoch: 2/4/10 *days*", (16.0, 32.0, 80.0)),
    ("epoch: 2/4/10 _days_", (16.0, 32.0, 80.0)),
    ("epoch: 2/4/10 `d`", (16.0, 32.0, 80.0)),
    ("epoch: 2/4/10. Then prose", (2.0, 4.0, 10.0)),
    ("epoch: 2/4/10. Then the API", (2.0, 4.0, 10.0)),
])
def test_hint_structural_unit_wrappers_and_sentence_end(plugin, hint, expected):
    hint_out, problem = plugin.find_hint("", hint)
    assert problem is None
    assert tuple(hint_out.values()) == pytest.approx(expected)


@pytest.mark.parametrize("hint,expects_text", [
    ("epoch: 2/4/10 day(s)", False),
    ("epoch: 2/4/10 week's work", False),
    ("epoch: 2/4/10 h/day", False),
    ("epoch: 2/4/10 for the API", True),
    ("epoch: 2/4/10 — owner", True),
])
def test_hint_rejects_invalid_first_token_without_claiming_a_unit(plugin, hint, expects_text):
    hint_out, problem = plugin.find_hint("", hint)
    assert hint_out is None
    assert problem
    if expects_text:
        assert "text after the estimate" in problem
    else:
        assert "malformed unit" in problem


def test_f3_prose_without_numbers_is_not_a_hint(plugin):
    assert plugin.find_hint("Estimate: TBD", "epoch: later") == (None, None)


def test_slash_error_redacts_home_path(plugin, make_ctx, monkeypatch):
    make_ctx({"default": {}})
    monkeypatch.setattr(plugin, "run_epoch", lambda *_args, **_kwargs: {
        "ok": False, "error": f"cannot read {Path.home()}/private/data"})
    result = plugin._slash("pert-estimate --optimistic 1 --most-likely 2 --pessimistic 3")
    assert str(Path.home()) not in result
    assert "~/private/data" in result


# ---------------------------------------------------------------- finding 4: cross-profile


def test_f4_dispatcher_and_assignee_profiles_share_board_correlation(plugin, board, make_ctx, tmp_path):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path, "dispatcher")},
                    "coder": {"epoch_command": fake_cmd(tmp_path, "worker")}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    _run_in_profile("default", ctx.hooks["kanban_task_claimed"], task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    board.complete(tid, rid, seconds=5400)
    _run_in_profile("coder", ctx.hooks["kanban_task_completed"], task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    recs = _record_calls(tmp_path)
    assert [r["tag"] for r in recs] == ["worker"]
    est_ref = _estimate_calls(tmp_path)[0]["ref"]
    assert recs[0]["entries"][0]["estimate_id"] == est_ref
    # neither profile's private state carries the association
    for prof in ("default", "coder"):
        assert not any(k.startswith("ref:") for k in ctx.state_store.get(prof, {}))


# ---------------------------------------------------------------- finding 5: stale reclaim


def test_f5_late_result_from_reclaimed_run_is_dropped(plugin, board, make_ctx, tmp_path):
    gate = tmp_path / "release-old"
    old_cmd = fake_cmd(tmp_path, "old", FAKE_EPOCH_BLOCK_FILE=gate)
    ctx = make_ctx({"old": {"epoch_command": old_cmd}, "new": {"epoch_command": fake_cmd(tmp_path, "new")}})
    tid = board.create("t", "epoch: 1/2/3h")
    r1 = board.claim(tid)
    _run_in_profile("old", ctx.hooks["kanban_task_claimed"], task_id=tid, run_id=r1)  # paused
    time.sleep(0.3)
    board.reclaim(tid, r1)
    board.now += 600
    r2 = board.claim(tid)
    _run_in_profile("new", ctx.hooks["kanban_task_claimed"], task_id=tid, run_id=r2)
    deadline = time.time() + 10
    while not any(f"run={r2}" in b for b in board.bodies(tid)) and time.time() < deadline:
        time.sleep(0.05)
    gate.touch()  # old estimator finishes late
    assert plugin.wait_for_inflight(15)
    estimates = [b for b in board.bodies(tid) if "[epoch:estimate" in b]
    assert len(estimates) == 1 and f"run={r2}" in estimates[0]
    board.complete(tid, r2, seconds=1800)
    _run_in_profile("new", ctx.hooks["kanban_task_completed"], task_id=tid, run_id=r2)
    assert plugin.wait_for_inflight(15)
    recs = _record_calls(tmp_path)
    new_ref = next(c["ref"] for c in _estimate_calls(tmp_path) if c["tag"] == "new")
    assert len(recs) == 1 and recs[0]["entries"][0]["estimate_id"] == new_ref
    assert recs[0]["entries"][0]["actual_hours"] == 0.5  # run 2's own time basis, not task age


def test_f5_completion_of_old_run_never_uses_new_runs_estimate(plugin, board, make_ctx, tmp_path):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    r1 = board.claim(tid)
    board.reclaim(tid, r1)
    r2 = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=r2)
    assert plugin.wait_for_inflight(15)
    ctx.hooks["kanban_task_completed"](task_id=tid, run_id=r1)
    assert plugin.wait_for_inflight(15)
    assert _record_calls(tmp_path) == []


# ---------------------------------------------------------------- finding 6: lifecycle


def test_f6_unfinished_job_survives_in_outbox_and_replays(plugin, board, make_ctx, tmp_path):
    gate = tmp_path / "never-yet"
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path, FAKE_EPOCH_BLOCK_FILE=gate),
                                "timeout_seconds": 30}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(0.3) is False  # bounded wait gives up...
    box = ctx.state.get("outbox")
    assert list(box) == [f"claimed:-:{tid}:{rid}"]  # ...but the job is durable
    # Simulate a fresh process loading the plugin later: lease expired, replay finishes the job.
    gate.touch()
    plugin.wait_for_inflight(15)  # let the abandoned thread end (a killed process would not)
    box[f"claimed:-:{tid}:{rid}"]["lease_until"] = 0
    ctx.state.set("outbox", box)
    from conftest import load_plugin
    fresh = load_plugin()
    fresh.register(ctx)
    assert fresh.wait_for_inflight(15)
    assert sum("[epoch:estimate" in b for b in board.bodies(tid)) == 1  # no duplicate post
    assert ctx.state.get("outbox") == {}


def test_f6_failed_jobs_retry_then_expire(plugin, board, make_ctx, tmp_path):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path, FAKE_EPOCH_MODE="nonzero")}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    assert ctx.state.get("outbox")[f"claimed:-:{tid}:{rid}"]["attempts"] == 1
    assert sum("will retry" in b for b in board.bodies(tid)) == 1
    for _ in range(plugin.OUTBOX_MAX_ATTEMPTS + 1):
        plugin.replay_outbox()
        plugin.wait_for_inflight(15)
    assert ctx.state.get("outbox") == {}
    assert sum("will retry" in b for b in board.bodies(tid)) == 1  # said once, not per retry


def test_f6_atexit_wait_is_registered(plugin, make_ctx):
    import atexit
    make_ctx({"default": {}})
    assert plugin._atexit_registered is True


# ---------------------------------------------------------------- finding 7: provenance


@pytest.mark.parametrize("seconds,status", [
    (2 * 3600, "recorded"),      # normal
    (60, "rejected"),            # < 0.05h
    (13 * 3600, "rejected"),     # > 12h
    (int(0.15 * 3600), "rejected"),  # >= 10x off a 2h estimate (0.15h)
])
def test_f7_wallclock_actuals_carry_auto_wallclock_provenance(plugin, board, make_ctx, tmp_path, seconds, status):
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    board.complete(tid, rid, seconds=seconds)
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))
    assert plugin.completed_job(tid, None, rid, plugin.snapshot_settings()) == status
    rec = _record_calls(tmp_path)[-1]
    assert rec["argv"][0] == "batch-record-actuals"
    entry = rec["entries"][0]
    assert entry["calibration_provenance"] == "auto_wallclock"
    assert entry["actual_hours"] == round(seconds / 3600, 4)  # no 0.01h clamp
    assert not any(a == "record-actual" for c in calls(tmp_path) for a in c["argv"][:1])
    if status == "rejected":
        assert any("sanity gate" in b for b in board.bodies(tid))
        # rejected runs are marked so they are not retried forever
        assert plugin.completed_job(tid, None, rid, plugin.snapshot_settings()) == "already_recorded"


# ---------------------------------------------------------------- finding 8: README


def test_f8_readme_install_command_uses_owner_repo_subdir():
    readme = (PLUGIN_DIR / "README.md").read_text()
    assert "--subdir" not in readme
    assert "hermes plugins install KyaniteLabs/Epoch/plugins/epoch-hermes" in readme


# ---------------------------------------------------------------- CLI error paths


@pytest.mark.parametrize("mode,needle", [("nonzero", "exited 3"), ("garbage", "no JSON envelope")])
def test_run_epoch_error_paths(plugin, make_ctx, tmp_path, mode, needle):
    make_ctx({"default": {"epoch_command": fake_cmd(tmp_path, FAKE_EPOCH_MODE=mode)}})
    res = plugin.run_epoch(["reference-class-estimate"])
    assert res["ok"] is False and needle in res["error"]


def test_run_epoch_timeout(plugin, make_ctx, tmp_path):
    make_ctx({"default": {"epoch_command": fake_cmd(tmp_path, FAKE_EPOCH_MODE="timeout"),
                          "timeout_seconds": 1}})
    res = plugin.run_epoch(["reference-class-estimate"])
    assert res == {"ok": False, "error": "epoch timed out after 1s"}


def test_run_epoch_missing_binary(plugin, make_ctx):
    make_ctx({"default": {"epoch_command": "definitely-not-a-real-epoch-binary"}})
    assert "not runnable" in plugin.run_epoch(["x"])["error"]


def test_epoch_data_dir_setting_pins_the_ledger(plugin, make_ctx, tmp_path):
    ledger = tmp_path / "shared-ledger"
    make_ctx({"default": {"epoch_command": f"{sys.executable} {Path(__file__).parent / 'fake_epoch.py'}",
                          "epoch_data_dir": str(ledger)}})
    plugin.run_epoch(["reference-class-estimate", "--task-type", "feature", "--complexity", "3"])
    assert (ledger / "calls.jsonl").exists()


def test_plugin_imports_no_private_hermes_modules():
    src = (PLUGIN_DIR / "__init__.py").read_text()
    # The optional, public Desktop bridge is the sole Hermes import.
    imports = re.findall(r"^\s*(?:from|import)\s+(hermes_cli[\w.]*)", src, re.M)
    assert imports == ["hermes_cli.plugin_events"]
    assert "kanban_db" not in src


# ---------------------------------------------------------------- catalog gates (0.7.0)


def test_child_env_is_scrubbed_and_telemetry_forced_off(plugin, make_ctx, tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("EPOCH_TEST_SECRET", "nope")
    monkeypatch.setenv("EPOCH_TELEMETRY", "1")
    ledger = tmp_path / "ledger"
    make_ctx({"default": {"epoch_command": f"{sys.executable} {Path(__file__).parent / 'fake_epoch.py'}",
                          "epoch_data_dir": str(ledger)}})
    plugin.run_epoch(["reference-class-estimate", "--task-type", "feature", "--complexity", "3"])
    (call,) = calls(ledger)
    assert "OPENAI_API_KEY" not in call["env_keys"]
    assert "EPOCH_TEST_SECRET" not in call["env_keys"]
    assert "HERMES_HOME" not in call["env_keys"]
    assert call["telemetry"] == "0"
    assert set(call["env_keys"]) <= set(plugin._ENV_ALLOW) | {
        "EPOCH_DATA_DIR", "EPOCH_TELEMETRY", "NO_COLOR", "NO_UPDATE_NOTIFIER",
        "npm_config_update_notifier", "npm_config_fund", "LC_CTYPE",
        # macOS adds this to every process at exec, even under `env -i`; the plugin never passes it.
        "__CF_USER_TEXT_ENCODING"}


def test_scrubbed_env_keeps_path_and_pins_data_dir(plugin, make_ctx, tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_x")
    make_ctx({"default": {"epoch_data_dir": str(tmp_path / "d")}})
    env = plugin._scrubbed_env(plugin.snapshot_settings())
    assert env["PATH"] == "/usr/bin:/bin" and "GITHUB_TOKEN" not in env
    assert env["EPOCH_DATA_DIR"] == str(tmp_path / "d") and (tmp_path / "d").is_dir()


@pytest.mark.parametrize("hermes_home,expected", [
    ("{root}", "{root}/plugin-data/epoch"),
    ("{root}/profiles/coder", "{root}/plugin-data/epoch"),  # profiles share one ledger
])
def test_default_ledger_is_hermes_plugin_data(plugin, make_ctx, tmp_path, monkeypatch, hermes_home, expected):
    root = tmp_path / "hh"
    monkeypatch.delenv("EPOCH_DATA_DIR", raising=False)
    monkeypatch.setenv("HERMES_HOME", hermes_home.format(root=root))
    monkeypatch.setitem(sys.modules, "hermes_constants", None)  # exercise the no-Hermes fallback
    make_ctx({"default": {"epoch_data_dir": ""}})
    assert plugin._epoch_data_dir(plugin.snapshot_settings()) == Path(expected.format(root=root))


@pytest.mark.parametrize("raw,blocked", [
    ("serve", True), ("self-improve --apply", True), ("telemetry enable", True),
    ("telemetry share-data", True), ("--format table telemetry submit", True), ("data delete-data", True),
    ("share-data --output /tmp/x", True), ("share-data", True), ("telemetry export --output=/tmp/x", True),
    ("telemetry status", False), ("data where", False),
    ("pert-estimate --optimistic 1 --most-likely 2 --pessimistic 4", False),
])
def test_slash_refuses_unsafe_subcommands(plugin, make_ctx, tmp_path, raw, blocked):
    make_ctx({"default": {"epoch_command": f"{sys.executable} {Path(__file__).parent / 'fake_epoch.py'}",
                          "epoch_data_dir": str(tmp_path)}})
    plugin._slash(raw)
    assert (calls(tmp_path) == []) is blocked


def test_share_data_cannot_overwrite_files_from_gateway(plugin, make_ctx, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PLATFORM", "telegram")
    victim = tmp_path / "notes.txt"
    victim.write_text("keep me")
    make_ctx({"default": {"epoch_command": f"{sys.executable} {Path(__file__).parent / 'fake_epoch.py'}",
                          "epoch_data_dir": str(tmp_path)}})
    out = plugin._slash(f"share-data --output {victim}")
    assert "not available" in out and calls(tmp_path) == []
    assert victim.read_text() == "keep me"


def test_slash_ledger_writes_refused_on_gateway_unless_opted_in(plugin, make_ctx, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PLATFORM", "telegram")
    cmd = f"{sys.executable} {Path(__file__).parent / 'fake_epoch.py'}"
    make_ctx({"default": {"epoch_command": cmd, "epoch_data_dir": str(tmp_path)}})
    out = plugin._slash("record-actual --estimate-id x --actual-hours 2")
    assert "disabled on gateway" in out and calls(tmp_path) == []
    make_ctx({"default": {"epoch_command": cmd, "epoch_data_dir": str(tmp_path),
                          "allow_write_slash_on_gateway": True}})
    plugin._slash("record-actual --estimate-id x --actual-hours 2")
    assert [c["argv"][0] for c in calls(tmp_path)] == ["record-actual"]
    monkeypatch.setenv("HERMES_PLATFORM", "cli")
    make_ctx({"default": {"epoch_command": cmd, "epoch_data_dir": str(tmp_path)}})
    plugin._slash("record-actual --estimate-id x --actual-hours 2")
    assert len(calls(tmp_path)) == 2


def test_manifest_matches_catalog_gates():
    text = (PLUGIN_DIR / "plugin.yaml").read_text()  # CI venv has no PyYAML
    assert re.search(r'^requires_hermes: ">=0\.21\.6"$', text, re.M)
    assert re.search(r"^  allow_write_slash_on_gateway:$", text, re.M)
    desc = re.search(r'^description: "(.*)"$', text, re.M).group(1)
    assert "plugin-data/epoch" in desc and "scrubbed" in desc


def test_nonzero_exit_with_ok_envelope_is_a_failure(plugin, tmp_path):
    """A child that prints ``ok: true`` but exits non-zero must not read as success."""
    script = tmp_path / "liar.py"
    script.write_text('import json, sys\nprint(json.dumps({"ok": True, "data": {"feedbackRef": "f"}}))\nsys.exit(17)\n')
    res = plugin.run_epoch(["feedback"], {"epoch_command": f"{sys.executable} {script}",
                                          "epoch_data_dir": str(tmp_path)})
    assert res["ok"] is False and "exited 17" in res["error"]
    assert res["data"] == {"feedbackRef": "f"}  # structured payload kept for diagnosis
