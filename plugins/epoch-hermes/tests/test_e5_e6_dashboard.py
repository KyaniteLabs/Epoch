"""E5 and E6: dashboard degrades without host Kanban; read_history reads a tail."""
from __future__ import annotations

import importlib.util
import json
import sys
import uuid
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parent.parent
def _api():
    pytest.importorskip("fastapi")
    spec = importlib.util.spec_from_file_location(
        f"epoch_api_w2_{uuid.uuid4().hex[:6]}", PLUGIN_DIR / "dashboard" / "plugin_api.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    return api


def _client(api):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(api.router)
    return TestClient(app)


def test_dashboard_degrades_when_host_kanban_cannot_be_imported(monkeypatch):
    api = _api()
    monkeypatch.setitem(sys.modules, "hermes_cli", None)
    c = _client(api)
    r = c.get("/tasks")
    assert r.status_code == 200
    body = r.json()
    assert body["tasks"] == [] and body["degraded"] is True
    assert any("Kanban" in e for e in body["errors"])
    assert c.get("/forecast", params={"board": "default", "task_id": "t1"}).status_code == 503
    assert c.get("/history").status_code == 200  # reads only the ledger, needs no host import


def test_read_history_reads_only_a_tail_of_a_huge_file(tmp_path, monkeypatch):
    api = _api()
    monkeypatch.setattr(api, "HISTORY_TAIL_BYTES", 1024 * 1024)
    filler = json.dumps({"id": "old", "tool": "pert", "outputs": {}, "pad": "x" * 150}) + "\n"
    est = tmp_path / "estimates.jsonl"
    with est.open("w", encoding="utf-8") as fh:
        for _ in range(100_000):  # about 17 MB
            fh.write(filler)
        fh.write(json.dumps({"id": "new1", "tool": "monte_carlo_schedule", "outputs": {"p50": 1, "p90": 2},
                             "inputs": {"tasks": [{"name": "recent"}]}}) + "\n")
    (tmp_path / "feedback.jsonl").write_text(
        json.dumps({"estimateId": "new1", "actualHours": 8, "reportedAt": "2026-01-01"}) + "\n")
    assert est.stat().st_size > 10 * 1024 * 1024
    assert len(api._jsonl(est)) < 10_000  # a tail, not the 100k rows
    items = api.read_history(tmp_path)
    assert [i["name"] for i in items] == ["recent"]



def test_tasks_survives_a_non_numeric_iterations_setting(monkeypatch):
    api = _api()
    mod = api._plugin()
    monkeypatch.setitem(sys.modules, "hermes_cli", None)
    monkeypatch.setattr(api, "_settings", lambda m: {**m.DEFAULTS, "iterations": "lots"})
    r = _client(api).get("/tasks")
    assert r.status_code == 200
    assert r.json()["iterations"] == mod.DEFAULTS["iterations"]
