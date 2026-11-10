"""Desktop backend (dashboard/plugin_api.py): real Hermes Kanban in a temp HERMES_HOME, a fake Epoch.

Needs Hermes on the path (fastapi + hermes_cli); skipped otherwise.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import textwrap
import uuid
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("hermes_cli.kanban_db")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PLUGIN_DIR = Path(__file__).resolve().parent.parent

FAKE = textwrap.dedent('''
    import json, os, sys
    argv = sys.argv[1:]
    with open(os.environ["LOG"], "a") as f:
        f.write(json.dumps({"argv": argv, "data_dir": os.environ.get("EPOCH_DATA_DIR"),
                            "telemetry": os.environ.get("EPOCH_TELEMETRY")}) + "\\n")
    mode = os.environ.get("MODE", "")
    if mode == "old" and "--distribution" in argv:
        print(json.dumps({"ok": False, "error": {"message": "error: unknown option '--seed'"}})); sys.exit(1)
    if mode == "boom":
        print("kaboom", file=sys.stderr); sys.exit(2)
    task = json.loads(argv[argv.index("--tasks") + 1])[0]
    ml = float(task["most_likely"])
    data = {"p10": ml * .8, "p50": str(ml), "p80": ml * 1.2, "p90": ml * 1.3, "p95": ml * 1.4,
            "estimatedCost": 4036142.14,
            "riskEvents": [{"description": "Task ran over 1.5x its PERT expected time", "probability": 0.27, "impact": 0.31},
                           "junk", {"description": 5}]}
    if "--distribution" in argv:
        data["distribution"] = {"edges": [ml * .5, ml, ml * 1.5, ml * 2], "counts": [10, 70, 20], "p50Bin": 1, "p90Bin": 2}
        if mode == "badhist":
            data["distribution"] = {"edges": [3, 2, 1], "counts": [1, "x"]}
    print(json.dumps({"ok": True, "data": data}))
''')


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("EPOCH_DATA_DIR", raising=False)
    fake = tmp_path / "fake.py"
    fake.write_text(FAKE)
    log = tmp_path / "calls.jsonl"
    ledger = tmp_path / "ledger"
    ledger.mkdir()

    name = f"epoch_desktop_api_{uuid.uuid4().hex[:8]}"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(spec)
    sys.modules[name] = api
    spec.loader.exec_module(api)
    api._cache.clear()
    plugin = api._plugin()

    settings = {"epoch_command": f"env LOG={log} {sys.executable} {fake}", "epoch_data_dir": str(ledger)}

    def set_mode(mode=""):
        settings["epoch_command"] = f"env LOG={log} MODE={mode} {sys.executable} {fake}"
        api._cache.clear()

    monkeypatch.setattr(api, "_settings", lambda mod: {**mod.DEFAULTS, **settings})
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/epoch")

    from hermes_cli import kanban_db as kdb
    from hermes_cli import kanban_db_connect as kbc

    def card(title, body="", board=None):
        conn = kbc.connect(board=board)
        try:
            return kdb.create_task(conn, title=title, body=body)
        finally:
            conn.close()

    def calls():
        return [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []

    yield type("E", (), dict(client=TestClient(app), card=staticmethod(card), calls=staticmethod(calls),
                             ledger=ledger, api=api, plugin=plugin, set_mode=staticmethod(set_mode)))
    sys.modules.pop(name, None)


def tid(t):
    return t if isinstance(t, str) else t.id


def test_tasks_lists_open_cards_with_hints(env):
    a = tid(env.card("Ship export epoch: 8/16/40h"))
    b = tid(env.card("No hint here"))
    c = tid(env.card("Bad hint", "epoch: 9/2/1"))
    r = env.client.get("/api/plugins/epoch/tasks").json()
    by = {t["id"]: t for t in r["tasks"]}
    assert set(by) >= {a, b, c}
    assert by[a]["hint"] == {"optimistic": 8.0, "most_likely": 16.0, "pessimistic": 40.0}
    assert by[b]["hint"] is None and by[b]["hint_error"] is None
    assert by[c]["hint"] is None and by[c]["hint_error"]
    assert r["tasks"][0]["id"] == a  # cards with a hint lead


def test_forecast_runs_in_a_throwaway_data_dir(env):
    a = tid(env.card("Ship export epoch: 8/16/40h"))
    r = env.client.get("/api/plugins/epoch/forecast", params={"board": "default", "task_id": a}).json()
    assert r["ok"] is True
    assert r["percentiles_days"]["p50"] == 2.0  # 16h / 8, string coerced
    assert r["distribution"]["counts"] == [10, 70, 20]
    assert "estimatedCost" not in json.dumps(r)
    assert [x["description"] for x in r["risks"]] == ["Task ran over 1.5x its PERT expected time"]
    call, = env.calls()
    assert "--distribution" in call["argv"] and call["argv"][call["argv"].index("--seed") + 1] == "42"
    assert call["data_dir"] != str(env.ledger) and not Path(call["data_dir"]).exists()  # gone after the run
    assert call["telemetry"] == "0"
    assert list(env.ledger.iterdir()) == []  # viewing never writes the real ledger


def test_forecast_is_cached_per_triple(env):
    a = tid(env.card("One epoch: 1/2/3h"))
    b = tid(env.card("Two epoch: 1/2/3h"))
    for t in (a, b, a):
        assert env.client.get("/api/plugins/epoch/forecast", params={"task_id": t}).json()["ok"]
    assert len(env.calls()) == 1


def test_old_epoch_falls_back_without_distribution(env):
    env.set_mode("old")
    a = tid(env.card("Ship epoch: 8/16/40h"))
    r = env.client.get("/api/plugins/epoch/forecast", params={"task_id": a}).json()
    assert r["ok"] and r["distribution"] is None and r["needs_epoch_0_8"] and r["seed"] is None
    assert len(env.calls()) == 2


def test_malformed_histogram_is_dropped(env):
    env.set_mode("badhist")
    a = tid(env.card("Ship epoch: 8/16/40h"))
    r = env.client.get("/api/plugins/epoch/forecast", params={"task_id": a}).json()
    assert r["ok"] and r["distribution"] is None


def test_epoch_failure_is_an_error_not_a_crash(env):
    env.set_mode("boom")
    a = tid(env.card("Ship epoch: 8/16/40h"))
    r = env.client.get("/api/plugins/epoch/forecast", params={"task_id": a})
    assert r.status_code == 200 and r.json()["ok"] is False and "exited 2" in r.json()["error"]


def test_forecast_without_hint_says_how(env):
    a = tid(env.card("No hint"))
    r = env.client.get("/api/plugins/epoch/forecast", params={"task_id": a}).json()
    assert r["ok"] is False and "epoch:" in r["error"]
    assert env.calls() == []


@pytest.mark.parametrize("params,code", [
    ({"task_id": ""}, 400), ({"task_id": "../../etc/passwd"}, 400), ({"task_id": "t_1", "board": "a/b"}, 400),
    ({"task_id": "x" * 200}, 400), ({"task_id": "t_doesnotexist"}, 404),
])
def test_forecast_rejects_bad_refs(env, params, code):
    assert env.client.get("/api/plugins/epoch/forecast", params=params).status_code == code


def test_history_joins_estimates_with_actuals(env):
    est = [
        {"id": "e1", "tool": "monte_carlo_schedule", "inputs": {"tasks": json.dumps([{"name": "Webhook retries"}])},
         "outputs": {"p50": "1.5", "p90": 2.4}},
        {"id": "e2", "tool": "monte_carlo_schedule", "inputs": {"tasks": [{"name": "A"}, {"name": "B"}]},
         "outputs": {"p50": 3}},
        {"id": "e3", "tool": "reference_class_estimate", "outputs": {"p50": 1}},
        {"id": "e4", "tool": "monte_carlo_schedule", "outputs": {"p50": 1}},  # no actual
    ]
    (env.ledger / "estimates.jsonl").write_text("\n".join(json.dumps(e) for e in est) + "\nnot json\n")
    fb = [{"estimateId": "e1", "actualHours": 16, "reportedAt": "2026-11-02"},
          {"estimateId": "e2", "actualHours": 4, "reportedAt": "2026-11-05"},
          {"estimateId": "e3", "actualHours": 4, "reportedAt": "2026-11-06"},
          {"estimateId": "e1x", "actualHours": -1}]
    (env.ledger / "feedback.jsonl").write_text("\n".join(json.dumps(f) for f in fb) + "\n")
    items = env.client.get("/api/plugins/epoch/history").json()["items"]
    assert [i["name"] for i in items] == ["A +1", "Webhook retries"]
    assert items[1] == {"name": "Webhook retries", "p50_days": 1.5, "p90_days": 2.4, "actual_days": 2.0,
                        "reported_at": "2026-11-02"}
    assert items[0]["p90_days"] is None


def test_history_and_badges_survive_missing_or_corrupt_files(env):
    assert env.client.get("/api/plugins/epoch/history").json() == {"items": []}
    assert env.client.get("/api/plugins/epoch/badges").json() == {"tasks": {}}
    (env.ledger / env.plugin.BINDINGS_FILE).write_text("{not json")
    assert env.client.get("/api/plugins/epoch/badges").json() == {"tasks": {}}
    (env.ledger / env.plugin.BINDINGS_FILE).write_text("[1,2]")
    assert env.client.get("/api/plugins/epoch/badges").json() == {"tasks": {}}


def test_badges_take_the_newest_run(env):
    bindings = {
        "default:t_a:1": {"estimate_comment_body": "[epoch:estimate ref=x] Epoch estimate: P50 4.0h · P90 6.5h"},
        "default:t_a:3": {"estimate_comment_body": "Epoch estimate: P50 5.0h · P90 7.5h"},
        "ops:t_b:2": {"estimate_comment_body": "P50 1.0h · P90 2.0h"},
        "default:t_c:1": {"ref": "x"},
        "junk": {"estimate_comment_body": "P50 1.0h · P90 2.0h"},
        "default:t_d:1": "not a dict",
    }
    (env.ledger / env.plugin.BINDINGS_FILE).write_text(json.dumps(bindings))
    got = env.client.get("/api/plugins/epoch/badges").json()["tasks"]
    assert got == {"t_a": {"board": "default", "p50_hours": 5.0, "p90_hours": 7.5},
                   "t_b": {"board": "ops", "p50_hours": 1.0, "p90_hours": 2.0}}


def test_badge_regex_matches_what_the_plugin_posts(env):
    settings = env.api._settings(env.plugin)
    out = env.plugin._monte_carlo("Ship", {"optimistic": 8.0, "most_likely": 16.0, "pessimistic": 40.0}, "hint", settings)
    m = env.api._BODY_PCT_RE.search(out["summary"])
    assert m and float(m.group(1)) == 16.0 and float(m.group(2)) == 20.8
