"""Real-Hermes, separate-process regression tests (Kai findings 1, 2, 4, 6, 7, 8).

Each step runs in its own Python process with its own ``HERMES_HOME`` (dispatcher profile ``A``,
assignee profile ``B``) against one shared Kanban board, loading the plugin through Hermes' real
plugin discovery so hooks fire from Hermes' own ``kanban_db`` transitions.

Skipped unless ``HERMES_AGENT_SRC`` points at a hermes-agent checkout. ``HERMES_PYTHON`` selects
an interpreter with Hermes' dependencies installed (default: this interpreter).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import FAKE_EPOCH, PLUGIN_DIR

HERMES_SRC = os.environ.get("HERMES_AGENT_SRC")
HERMES_PY = os.environ.get("HERMES_PYTHON", sys.executable)
DRIVER = Path(__file__).resolve().parent / "hermes_driver.py"

pytestmark = pytest.mark.skipif(not HERMES_SRC, reason="set HERMES_AGENT_SRC to run real-Hermes e2e tests")


class Env:
    def __init__(self, root: Path, extra_env_by_profile=None):
        self.root, self.ledger = root, root / "ledger"
        (root / "kb").mkdir(parents=True)
        for prof in ("A", "B"):
            home = root / prof
            (home / "plugins").mkdir(parents=True)
            (home / "plugins" / "epoch").symlink_to(PLUGIN_DIR)
            extra = " ".join(f"{k}={v}" for k, v in (extra_env_by_profile or {}).get(prof, {}).items())
            cmd = f"env FAKE_EPOCH_TAG={prof} EPOCH_DATA_DIR={self.ledger} {extra} {sys.executable} {FAKE_EPOCH}"
            (home / "config.yaml").write_text(
                "plugins:\n  enabled: [epoch]\n  entries:\n    epoch:\n      settings:\n"
                f"        epoch_command: {json.dumps(cmd)}\n        timeout_seconds: 30\n")

    def env(self, prof):
        e = dict(os.environ, HERMES_AGENT_SRC=HERMES_SRC, HERMES_KANBAN_HOME=str(self.root / "kb"),
                 HERMES_HOME=str(self.root / prof))
        e.pop("HERMES_KANBAN_TASK", None)
        e.pop("HERMES_KANBAN_DB", None)
        if prof == "B":
            e["HERMES_PROFILE"] = "coder"
        return e

    def run(self, prof, *args, timeout=60):
        p = subprocess.run([HERMES_PY, str(DRIVER), *map(str, args)], env=self.env(prof),
                           capture_output=True, text=True, timeout=timeout)
        assert p.returncode == 0, p.stderr[-2000:]
        lines = [l for l in p.stdout.splitlines() if l.startswith("{")]
        return json.loads(lines[-1]) if lines else None

    def popen(self, prof, *args):
        return subprocess.Popen([HERMES_PY, str(DRIVER), *map(str, args)], env=self.env(prof),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def calls(self):
        p = self.ledger / "calls.jsonl"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def comments(self, tid):
        return [c["body"] for c in self.run("A", "show", tid)["comments"]]


def _records(env):
    return [c for c in env.calls() if c["argv"][0] == "batch-record-actuals"]


def test_e2e_dispatcher_and_worker_profiles(tmp_path):
    """F1+F4+F6+F7: claim in dispatcher profile A, complete in assignee profile B, normal exits."""
    env = Env(tmp_path)
    tid = env.run("A", "create", "Fix crash", "epoch: 1/2/3h")["task_id"]
    rid = env.run("A", "claim", tid)["run_id"]  # process exits right after the claim
    est = [c for c in env.calls() if c["argv"][0] == "monte-carlo-schedule"]
    assert [(c["tag"], c["hermes_home"]) for c in est] == [("A", str(tmp_path / "A"))]
    env.run("A", "backdate", rid, 2 * 3600)
    env.run("B", "complete", tid, rid)
    recs = _records(env)
    assert [(c["tag"], c["hermes_home"]) for c in recs] == [("B", str(tmp_path / "B"))]
    entry = recs[0]["entries"][0]
    assert entry["estimate_id"] == est[0]["ref"]
    assert entry["calibration_provenance"] == "auto_wallclock"
    assert 1.99 <= entry["actual_hours"] <= 2.01
    bodies = env.comments(tid)
    assert sum(f"[epoch:estimate run={rid} " in b for b in bodies) == 1
    assert sum(f"[epoch:actual run={rid} " in b and "status=" not in b for b in bodies) == 1
    # no profile-scoped association was needed: B never saw A's plugin state
    assert not (tmp_path / "B" / "plugin-data").exists() or "ref:" not in "".join(
        p.read_text() for p in (tmp_path / "B" / "plugin-data").rglob("state.json"))


def test_e2e_completion_before_estimate(tmp_path):
    """F2: the worker completes while the dispatcher's estimate is still running."""
    gate = tmp_path / "release"
    env = Env(tmp_path, {"A": {"FAKE_EPOCH_BLOCK_FILE": gate}})
    tid = env.run("A", "create", "Short task", "epoch: 1/2/3h")["task_id"]
    claim = env.popen("A", "claim", tid)  # estimate blocks on the gate; atexit wait keeps it alive
    rid = json.loads(claim.stdout.readline())["run_id"]
    env.run("A", "backdate", rid, 3600)
    env.run("B", "complete", tid, rid)  # finds no estimate marker yet
    assert _records(env) == []
    gate.touch()
    assert claim.wait(timeout=60) == 0
    recs = _records(env)
    assert len(recs) == 1 and recs[0]["tag"] == "A"  # claim side reconciled after posting
    assert recs[0]["entries"][0]["calibration_provenance"] == "auto_wallclock"
    bodies = env.comments(tid)
    assert sum("[epoch:estimate" in b for b in bodies) == 1
    assert sum("[epoch:actual" in b for b in bodies) == 1


def test_e2e_hard_exit_job_replays_on_next_load(tmp_path):
    """F6: a one-shot process that os._exit()s mid-estimate loses nothing; the next load replays."""
    env = Env(tmp_path, {"A": {"FAKE_EPOCH_SLEEP": "1.5"}})
    tid = env.run("A", "create", "t", "epoch: 1/2/3h")["task_id"]
    env.run("A", "claim", tid, "--hard-exit")
    time.sleep(2.0)  # the orphaned fake-epoch child may finish, but nobody posts its result
    assert not any("[epoch:estimate" in b for b in env.comments(tid))
    state = json.loads(next((tmp_path / "A" / "plugin-data").rglob("state.json")).read_text())
    assert any(k.startswith("claimed:") for k in state["outbox"])
    env.run("A", "load")  # a later process in the dispatcher profile
    assert sum("[epoch:estimate" in b for b in env.comments(tid)) == 1
    state = json.loads(next((tmp_path / "A" / "plugin-data").rglob("state.json")).read_text())
    assert state["outbox"] == {}


def test_e2e_readme_install_command_parses_with_real_hermes(tmp_path):
    """F8: the README command parses with Hermes' real parser + resolver; --subdir does not."""
    code = (
        "import argparse, json, sys; sys.path.insert(0, %r)\n"
        "from hermes_cli.subcommands.plugins import build_plugins_parser\n"
        "from hermes_cli.plugins_cmd import _resolve_git_url\n"
        "p = argparse.ArgumentParser(); sp = p.add_subparsers(dest='cmd')\n"
        "build_plugins_parser(sp, cmd_plugins=lambda a: None)\n"
        "ns = p.parse_args(['plugins', 'install', 'KyaniteLabs/Epoch/plugins/epoch-hermes'])\n"
        "print(json.dumps(_resolve_git_url(ns.identifier)))\n"
        "try:\n"
        "    p.parse_args(['plugins', 'install', 'KyaniteLabs/Epoch', '--subdir', 'plugins/epoch-hermes'])\n"
        "    print('SUBDIR_ACCEPTED')\n"
        "except SystemExit:\n"
        "    print('SUBDIR_REJECTED')\n" % HERMES_SRC)
    p = subprocess.run([HERMES_PY, "-c", code], capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr[-1500:]
    lines = p.stdout.strip().splitlines()
    assert json.loads(lines[0]) == ["https://github.com/KyaniteLabs/Epoch.git", "plugins/epoch-hermes"]
    assert lines[-1] == "SUBDIR_REJECTED"
    readme = (PLUGIN_DIR / "README.md").read_text()
    assert "hermes plugins install KyaniteLabs/Epoch/plugins/epoch-hermes" in readme
