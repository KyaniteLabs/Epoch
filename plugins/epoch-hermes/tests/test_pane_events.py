"""Agent-to-Desktop events contain only bounded view state, never task text."""
import json
import sys
from types import ModuleType

import pytest

from conftest import fake_cmd, load_plugin


@pytest.fixture
def broadcasts(monkeypatch):
    calls = []
    bridge = ModuleType("hermes_cli.plugin_events")
    bridge.broadcast_plugin_event = lambda *args: calls.append(args)
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_events", bridge)
    return calls


@pytest.mark.parametrize("body,method", [("epoch: 1/2/3h", "monte_carlo"), ("", "reference_class")])
def test_estimate_emits_only_invalidation(plugin, make_ctx, tmp_path, broadcasts, body, method):
    make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    result = json.loads(plugin._tool({"title": "Private title", "body": body}))
    assert result["method"] == method
    assert broadcasts == [("epoch", "data.updated", {})]


def test_failed_estimate_does_not_emit(plugin, make_ctx, broadcasts):
    make_ctx({"default": {"epoch_command": "epoch-not-installed"}})
    plugin._tool({"title": "Private"})
    plugin._tool({"title": "Private", "optimistic": -1})
    assert broadcasts == []


def test_hooks_refresh_bindings_and_actuals(plugin, board, make_ctx, tmp_path, broadcasts):
    make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    tid = board.create("Private card", "epoch: 1/2/3h")
    rid = board.claim(tid)
    assert plugin.claimed_job(tid, None, rid) == "estimated"
    assert broadcasts == [("epoch", "data.updated", {})]
    broadcasts.clear()
    board.complete(tid, rid, seconds=7200)
    assert plugin.completed_job(tid, None, rid) == "recorded"
    assert broadcasts == [("epoch", "data.updated", {})]


@pytest.mark.parametrize("command,emits", [
    ("pert-estimate --optimistic 1 --most-likely 2 --pessimistic 3", True),
    ("record-actual --estimate-id synthetic --actual-hours 2", True),
    ("data status", False), ("telemetry status", False), ("serve", False),
])
def test_slash_refreshes_successful_writes(plugin, monkeypatch, broadcasts, command, emits):
    monkeypatch.setattr(plugin, "run_epoch", lambda *args: {"ok": True, "data": {}})
    plugin._slash(command)
    assert broadcasts == ([("epoch", "data.updated", {})] if emits else [])


def test_failed_slash_does_not_emit(plugin, monkeypatch, broadcasts):
    monkeypatch.setattr(plugin, "run_epoch", lambda *args: {"ok": False, "error": "unavailable"})
    plugin._slash("pert-estimate --optimistic 1 --most-likely 2 --pessimistic 3")
    assert broadcasts == []


@pytest.mark.parametrize("view", ["bars", "cdf", "dots"])
def test_registered_show_selects_real_view(plugin, make_ctx, broadcasts, view):
    ctx = make_ctx({"default": {}})
    tool = ctx.tools["epoch_show"]
    assert tool["schema"]["parameters"]["properties"]["view"]["enum"] == ["bars", "cdf", "dots"]
    out = tool["handler"]({"view": view, "item_id": "t_42"})
    assert view in out and "t_42" in out and "open and enabled" in out
    assert broadcasts == [("epoch", "view.set", {"view": view, "item_id": "t_42"})]


def test_show_without_item(plugin, broadcasts):
    assert "bars" in plugin._show({"view": "bars"})
    assert broadcasts == [("epoch", "view.set", {"view": "bars"})]


@pytest.mark.parametrize("args", [
    None, [], "bars", {}, {"view": []}, {"view": "unknown"}, {"view": "x" * 1000},
    {"view": "bars", "item_id": ""}, {"view": "bars", "item_id": "x" * 81},
    {"view": "bars", "item_id": "/home/private"}, {"view": "bars", "item_id": 1},
    {"view": "bars", "item_id": None}, {"view": "bars", "item_id": "t_a\n"},
    {"view": "bars", "text": "private"},
])
def test_show_rejects_invalid_input(plugin, broadcasts, args):
    assert "error" in plugin._show(args).lower()
    assert broadcasts == []


def test_show_id_boundary(plugin, broadcasts):
    plugin._show({"view": "dots", "item_id": "t" * 80})
    assert broadcasts == [("epoch", "view.set", {"view": "dots", "item_id": "t" * 80})]


def test_invalid_events_never_reach_bridge(plugin, broadcasts):
    for name, payload in [("unknown", {}), ("data.updated", {"text": "private"}),
                          ("view.set", {"view": "other"}), ("view.set", [])]:
        assert not plugin._broadcast_pane_event(name, payload)
    assert broadcasts == []


def test_hermes_absent_is_safe(monkeypatch):
    monkeypatch.setitem(sys.modules, "hermes_cli", None)
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_events", None)
    mod = load_plugin()
    monkeypatch.setattr(mod, "run_epoch", lambda *args: {"ok": True, "data": {"p50": 1, "p90": 2}})
    assert json.loads(mod._tool({"title": "Private", "body": "epoch: 1/2/3h"}))["method"] == "monte_carlo"
    assert "open and enabled" in mod._show({"view": "bars"})
    assert "Capabilities -> Plugins" in mod._slash("status")
    assert "error" in mod._tool({"optimistic": 1})


@pytest.mark.parametrize("failure", [RuntimeError, SystemExit])
def test_bridge_failure_does_not_break_estimates(plugin, broadcasts, monkeypatch, make_ctx, tmp_path, failure):
    def fail(*args):
        raise failure("transport unavailable")
    monkeypatch.setattr(sys.modules["hermes_cli.plugin_events"], "broadcast_plugin_event", fail)
    make_ctx({"default": {"epoch_command": fake_cmd(tmp_path)}})
    assert json.loads(plugin._tool({"title": "Private", "body": "epoch: 1/2/3h"}))["method"] == "monte_carlo"
    assert "open and enabled" in plugin._show({"view": "cdf"})
