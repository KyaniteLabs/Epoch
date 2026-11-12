"""Hill-climb 2026-11-11: a failed outbox write must not be silent."""
import json
import logging


def test_outbox_write_failure_is_logged_at_warning(plugin, make_ctx, caplog):
    ctx = make_ctx({"default": {}})

    class Broken:
        def update(self, *a, **k):
            raise OSError("disk full")

    ctx.state = Broken()
    with caplog.at_level(logging.DEBUG, logger=plugin.logger.name):
        plugin._outbox_put({"id": "estimate:-:t1:1"})
    hits = [r for r in caplog.records if "outbox" in r.getMessage()]
    assert hits and max(r.levelno for r in hits) >= logging.WARNING


# ---------------------------------------------------------------- F13: gateway ledger reads
import os
import re
import sys
import textwrap
import time
from pathlib import Path

import pytest

from conftest import PLUGIN_DIR, calls

FAKE = f"{sys.executable} {Path(__file__).parent / 'fake_epoch.py'}"


@pytest.mark.parametrize("raw", [
    "get-pending-estimates", "accuracy-trend", "feedback-health", "data status",
    "reference-class-estimate --task-type feature --complexity 3",
])
def test_f13_gateway_refuses_ledger_reads_unless_opted_in(plugin, make_ctx, tmp_path, monkeypatch, raw):
    monkeypatch.setenv("HERMES_PLATFORM", "telegram")
    make_ctx({"default": {"epoch_command": FAKE, "epoch_data_dir": str(tmp_path)}})
    out = plugin._slash(raw)
    assert "ledger" in out and "gateway" in out and calls(tmp_path) == []
    make_ctx({"default": {"epoch_command": FAKE, "epoch_data_dir": str(tmp_path),
                          "allow_ledger_read_on_gateway": True}})
    plugin._slash(raw)
    assert len(calls(tmp_path)) == 1


def test_f13_gateway_still_allows_pure_calculators(plugin, make_ctx, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PLATFORM", "telegram")
    make_ctx({"default": {"epoch_command": FAKE, "epoch_data_dir": str(tmp_path)}})
    plugin._slash("pert-estimate --optimistic 1 --most-likely 2 --pessimistic 4")
    plugin._slash("parse-duration 2h30m")
    assert [c["argv"][0] for c in calls(tmp_path)] == ["pert-estimate", "parse-duration"]


def test_f13_local_use_is_unchanged(plugin, make_ctx, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PLATFORM", "cli")
    make_ctx({"default": {"epoch_command": FAKE, "epoch_data_dir": str(tmp_path)}})
    plugin._slash("get-pending-estimates")
    assert [c["argv"][0] for c in calls(tmp_path)] == ["get-pending-estimates"]


def test_f13_setting_is_in_the_manifest():
    text = (PLUGIN_DIR / "plugin.yaml").read_text()
    assert re.search(r"^  allow_ledger_read_on_gateway:$", text, re.M)


# ---------------------------------------------------------------- F30: timeout kills the group
def test_f30_timeout_kills_the_whole_process_group(plugin, make_ctx, tmp_path):
    pidfile = tmp_path / "child.pid"
    npx = tmp_path / "fake-npx"
    npx.write_text(textwrap.dedent(f"""\
        #!/bin/sh
        sleep 300 &
        echo $! > {pidfile}
        wait
        """))
    npx.chmod(0o755)
    make_ctx({"default": {"epoch_command": str(npx), "epoch_data_dir": str(tmp_path / "d"),
                          "timeout_seconds": 1}})
    res = plugin.run_epoch(["get-current-time"])
    assert "timed out" in res["error"]
    pid = int(pidfile.read_text())
    for _ in range(50):
        if not _running(pid):
            break
        time.sleep(0.1)
    else:
        os.kill(pid, 9)  # clean up our own sleeper before failing
        pytest.fail("the sleeping grandchild survived the timeout")


def _running(pid):
    """True while pid runs. A zombie does not count: in a CI container the orphaned
    grandchild is reparented to a PID 1 that may never reap it."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False
    except OSError:
        pass  # no /proc (macOS): fall back to a signal probe
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


# ---------------------------------------------------------------- L-F2: env allowlist
def test_lf2_node_options_never_reaches_the_child(plugin, make_ctx, tmp_path, monkeypatch):
    monkeypatch.setenv("NODE_OPTIONS", "--require /tmp/evil.js")
    monkeypatch.setenv("PATH", os.environ.get("PATH", "/usr/bin"))
    make_ctx({"default": {"epoch_command": FAKE, "epoch_data_dir": str(tmp_path)}})
    assert "NODE_OPTIONS" not in plugin._scrubbed_env(plugin.snapshot_settings())
    plugin.run_epoch(["get-current-time"])
    assert "NODE_OPTIONS" not in calls(tmp_path)[0]["env_keys"]
    assert "NODE_OPTIONS" not in plugin._ENV_ALLOW


def test_lf2_docs_name_the_variables_that_reach_the_child(plugin):
    text = (PLUGIN_DIR / "plugin.yaml").read_text() + (PLUGIN_DIR / "README.md").read_text()
    for var in plugin._ENV_ALLOW:
        assert var.lower() in text.lower(), f"{var} reaches the child but is not documented"
    assert "NODE_OPTIONS" in text  # documented as dropped


# ---------------------------------------------------------------- F01: version agreement
def test_f01_manifest_version_and_changelog_agree():
    """One story: the npm package and its tag are 0.8.0; the plugin ships as plugin.yaml says, and
    everything since the tag sits under Unreleased (no released heading newer than the package)."""
    text = (PLUGIN_DIR / "plugin.yaml").read_text()
    version = re.search(r'^version: "(\d+\.\d+\.\d+)"$', text, re.M).group(1)
    root = PLUGIN_DIR.parent.parent
    package = json.loads((root / "package.json").read_text())["version"]
    changelog = (root / "CHANGELOG.md").read_text()
    released = re.findall(r"^## \[(\d+\.\d+\.\d+)\]", changelog, re.M)
    assert released[0] == package, (released[:3], package)
    assert changelog.index("## [Unreleased]") < changelog.index(f"## [{package}]")
    assert "share-data" in changelog[: changelog.index(f"## [{package}]")]
    readme = (PLUGIN_DIR / "README.md").read_text()
    assert "0.8.0 refuses" not in readme and f"{version} refuses" in readme
