"""The catalog demo drives the real claim/complete hooks and stays under 90s.

The subprocess never selects ``npx`` or a Hermes CLI, and it points HERMES_HOME
at the directory the test gives it.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
DEMO = PLUGIN_DIR / "scripts" / "demo.py"
FAKE_EPOCH = Path(__file__).resolve().parent / "fake_epoch.py"
REPO_ROOT = PLUGIN_DIR.parents[1]


def _run(env: dict, timeout: float = 90):
    started = time.monotonic()
    proc = subprocess.run(
        [sys.executable, str(DEMO)],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(REPO_ROOT),
    )
    return proc, time.monotonic() - started


def _base_env(tmp_path: Path) -> dict:
    env = os.environ.copy()
    env["EPOCH_DEMO_DIR"] = str(tmp_path / "demo")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def test_demo_posts_p50_p90_from_the_hooks_under_90s(tmp_path):
    env = _base_env(tmp_path)
    env["EPOCH_DEMO_COMMAND"] = f"{sys.executable} {FAKE_EPOCH}"
    proc, elapsed = _run(env)
    assert proc.returncode == 0, proc.stderr + proc.stdout
    assert "P50" in proc.stdout and "P90" in proc.stdout
    assert "[epoch:estimate" in proc.stdout
    assert "[epoch:actual" in proc.stdout
    assert "P90 n/a" not in proc.stdout
    assert f"hermes_home: {tmp_path / 'demo' / 'hermes-home'}" in proc.stdout
    assert "npx" not in proc.stdout
    assert elapsed < 90


def test_demo_refuses_npx_and_hermes_commands(tmp_path):
    for command in ("npx -y @kyanitelabs/epoch@0.7.0", "hermes update", "npm exec epoch"):
        env = _base_env(tmp_path)
        env["EPOCH_DEMO_COMMAND"] = command
        proc, _elapsed = _run(env, timeout=15)
        assert proc.returncode == 1, command
        assert "refuses" in proc.stderr
        assert not (tmp_path / "demo").exists()


def test_resolve_epoch_command_never_picks_npx_by_default(monkeypatch, tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("epoch_demo_resolve", DEMO)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "DIST_CLI", tmp_path / "missing.js")
    command, label = mod.resolve_epoch_command({})
    assert label == "bundled-fake"
    executable = command.split()[0]
    assert Path(executable).name not in {"npx", "npm", "hermes"}
    assert command.endswith(str(FAKE_EPOCH))
    with pytest.raises(SystemExit):
        mod.resolve_epoch_command({"EPOCH_DEMO_COMMAND": "npx -y @kyanitelabs/epoch@0.7.0"})


def test_plugin_uses_hermes_tool_api_and_has_no_hardcoded_secret():
    src = (PLUGIN_DIR / "__init__.py").read_text()
    manifest = (PLUGIN_DIR / "plugin.yaml").read_text()
    assert "ctx.dispatch_tool" in src or "dispatch_tool" in src
    assert "kanban_show" in src and "kanban_comment" in src
    assert "register_hook(\"kanban_task_claimed\"" in src
    assert "register_hook(\"kanban_task_completed\"" in src
    assert "requires_env: []" in manifest
    assert "auth.json" not in src
    assert "get_secret" not in src
    assert not re.search(
        r"(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16})",
        src,
    )


def test_catalog_draft_is_simons_to_open():
    text = (REPO_ROOT / "docs" / "catalog-pr.md").read_text()
    assert "KLH-325" in text
    assert "plugin-catalog/epoch.yaml" in text
    assert "kanban_task_claimed" in text
    assert "kanban_task_completed" in text
    assert "Simon opens" in text
    assert "sha:" in text
    assert "hermes update" in text
