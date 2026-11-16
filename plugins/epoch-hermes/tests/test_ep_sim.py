"""EP-sim: the desktop shows the configured iteration count, not a fixed 5,000."""
import sys
from pathlib import Path

from test_e5_e6_dashboard import PLUGIN_DIR, _api, _client


def test_tasks_route_reports_configured_iterations(monkeypatch):
    api = _api()
    monkeypatch.setitem(sys.modules, "hermes_cli", None)
    monkeypatch.setattr(api, "_settings", lambda mod: {"iterations": 1234})
    assert _client(api).get("/tasks").json()["iterations"] == 1234


def test_desktop_label_is_not_hard_coded():
    js = (Path(PLUGIN_DIR) / "desktop" / "plugin.js").read_text()
    assert "5,000" not in js
    assert "tasks.iterations" in js
