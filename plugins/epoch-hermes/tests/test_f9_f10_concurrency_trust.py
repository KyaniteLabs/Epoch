"""Regressions for Kai findings #9 (outbox cross-process RMW) and #10 (marker trust).

These must fail on beca612 and pass after the fix.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from conftest import PLUGIN_DIR, calls, fake_cmd


# --------------------------------------------------------------------------- finding 9 helpers
# Hermes PluginState locks get/set individually (fcntl), not a caller RMW. This stand-in mirrors
# that contract so a multi-process lost-update reproduces without importing hermes_cli.


class HermesLikeState:
    """File-backed state with per-op locking only (no transactional update)."""

    def __init__(self, path: Path):
        import fcntl
        self.path = path
        self._fcntl = fcntl
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock_path = path.with_name(f".{path.name}.lock")

    def _locked(self):
        import contextlib

        @contextlib.contextmanager
        def cm():
            self._lock_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._lock_path, "a+b") as handle:
                self._fcntl.flock(handle.fileno(), self._fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    self._fcntl.flock(handle.fileno(), self._fcntl.LOCK_UN)
        return cm()

    def _read(self):
        try:
            return json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}

    def get(self, key, default=None):
        with self._locked():
            return json.loads(json.dumps(self._read().get(key, default)))

    def set(self, key, value):
        with self._locked():
            data = self._read()
            data[key] = json.loads(json.dumps(value))
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2))
            tmp.replace(self.path)


def _mp_env(tmp_path, state_path, **extra):
    env = dict(os.environ, PLUGIN_DIR=str(PLUGIN_DIR), PLUGIN_TESTS=str(PLUGIN_DIR / "tests"),
               STATE_PATH=str(state_path), **{k: str(v) for k, v in extra.items()})
    return env


def test_f9_outbox_survives_interleaved_completion_and_enqueue(tmp_path):
    """Completer writes last with a stale snapshot; new enqueue must not vanish."""
    state_path = tmp_path / "plugin-data" / "epoch" / "state.json"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(json.dumps({
        "outbox": {
            "claimed:-:tA:1": {
                "id": "claimed:-:tA:1", "kind": "claimed", "task_id": "tA", "board": None,
                "run_id": 1, "settings": {}, "created_at": time.time(), "attempts": 0,
                "lease_until": time.time() + 60, "owner_pid": os.getpid(),
            }
        }
    }))
    gate = tmp_path / "gate"
    gate.mkdir()

    worker = textwrap.dedent(r"""
        import json, os, sys, time
        from pathlib import Path
        sys.path.insert(0, os.environ["PLUGIN_TESTS"])
        import importlib.util, uuid
        plugin_dir = Path(os.environ["PLUGIN_DIR"])
        name = f"epoch_hermes_mp_{uuid.uuid4().hex[:8]}"
        spec = importlib.util.spec_from_file_location(name, plugin_dir / "__init__.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
        from test_f9_f10_concurrency_trust import HermesLikeState
        state = HermesLikeState(Path(os.environ["STATE_PATH"]))
        gate = Path(os.environ["GATE"])

        def wait(name, timeout=10):
            deadline = time.time() + timeout
            while time.time() < deadline:
                if (gate / name).exists():
                    return
                time.sleep(0.01)
            raise SystemExit(f"timeout waiting for {name}")

        def touch(name):
            (gate / name).write_text("1")

        role = sys.argv[1]
        orig_get, orig_set = state.get, state.set

        if role == "completer":
            def get(key, default=None):
                v = orig_get(key, default)
                if key == "outbox":
                    touch("c-got")
                return v
            def set(key, value):
                if key == "outbox":
                    wait("e-wrote")  # enqueuer already committed {A,B} with its snapshot
                return orig_set(key, value)
        else:
            def get(key, default=None):
                if key == "outbox":
                    wait("c-got")  # completer already snapped {A}
                return orig_get(key, default)
            def set(key, value):
                r = orig_set(key, value)
                if key == "outbox":
                    touch("e-wrote")
                return r

        state.get, state.set = get, set

        class Ctx:
            def __init__(self):
                self.state = state
            def get_config(self, key, default=None): return default
            def dispatch_tool(self, *a, **k): return "{}"
            def register_hook(self, *a, **k): pass
            def register_tool(self, *a, **k): pass
            def register_command(self, *a, **k): pass

        mod._ctx = Ctx()  # skip register/replay; drive outbox APIs directly
        if role == "completer":
            mod._outbox_done("claimed:-:tA:1")
        else:
            job = {"id": "claimed:-:tB:2", "kind": "claimed", "task_id": "tB", "board": None,
                   "run_id": 2, "settings": {}, "created_at": time.time(), "attempts": 0,
                   "lease_until": time.time() + 60, "owner_pid": os.getpid()}
            mod._outbox_put(job)
        print(role + "-ok", flush=True)
    """)
    script = tmp_path / "mp_worker.py"
    script.write_text(worker)
    env = _mp_env(tmp_path, state_path, GATE=gate)
    procs = [
        subprocess.Popen([sys.executable, str(script), role], env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for role in ("completer", "enqueuer")
    ]
    for p in procs:
        out, err = p.communicate(timeout=30)
        assert p.returncode == 0, (out, err)

    final = json.loads(state_path.read_text())["outbox"]
    assert "claimed:-:tA:1" not in final
    assert "claimed:-:tB:2" in final, final


def test_f9_lease_claim_is_exclusive_across_processes(tmp_path):
    """Two processes replay one unleased job; exactly one claims it."""
    state_path = tmp_path / "plugin-data" / "epoch" / "state.json"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(json.dumps({
        "outbox": {
            "claimed:-:tX:9": {
                "id": "claimed:-:tX:9", "kind": "claimed", "task_id": "tX", "board": None,
                "run_id": 9, "settings": {"timeout_seconds": 30}, "created_at": time.time(),
                "attempts": 0, "lease_until": 0, "owner_pid": 0,
            }
        }
    }))
    gate = tmp_path / "gate"
    gate.mkdir()

    worker = textwrap.dedent(r"""
        import json, os, sys, time
        from pathlib import Path
        sys.path.insert(0, os.environ["PLUGIN_TESTS"])
        import importlib.util, uuid
        plugin_dir = Path(os.environ["PLUGIN_DIR"])
        name = f"epoch_hermes_mp_{uuid.uuid4().hex[:8]}"
        spec = importlib.util.spec_from_file_location(name, plugin_dir / "__init__.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
        from test_f9_f10_concurrency_trust import HermesLikeState
        state = HermesLikeState(Path(os.environ["STATE_PATH"]))
        gate = Path(os.environ["GATE"])
        role = sys.argv[1]

        def wait(name, timeout=10):
            deadline = time.time() + timeout
            while time.time() < deadline:
                if (gate / name).exists():
                    return
                time.sleep(0.01)
            raise SystemExit(f"timeout waiting for {name}")

        def touch(name):
            (gate / name).write_text("1")

        orig_get, orig_set = state.get, state.set
        # Both processes snap the unleased job before either writes the claim.
        def get(key, default=None):
            v = orig_get(key, default)
            if key == "outbox":
                touch(f"{role}-got")
                wait("a-got")
                wait("b-got")
            return v
        def set(key, value):
            if key == "outbox":
                wait("a-got")
                wait("b-got")
            return orig_set(key, value)
        state.get, state.set = get, set

        class Ctx:
            def __init__(self):
                self.state = state
            def get_config(self, key, default=None): return default
            def dispatch_tool(self, *a, **k): return "{}"
            def register_hook(self, *a, **k): pass
            def register_tool(self, *a, **k): pass
            def register_command(self, *a, **k): pass

        claimed = []
        def fake_start(job):
            claimed.append(dict(job))
            class T:
                def join(self, *a, **k): pass
            return T()
        mod._start = fake_start
        mod._ctx = Ctx()
        mod._atexit_registered = True
        started = mod.replay_outbox()
        print(json.dumps({"role": role, "n": len(started),
                          "pids": [c.get("owner_pid") for c in claimed]}), flush=True)
    """)
    script = tmp_path / "lease_worker.py"
    script.write_text(worker)
    env = _mp_env(tmp_path, state_path, GATE=gate)
    procs = [
        subprocess.Popen([sys.executable, str(script), role], env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for role in ("a", "b")
    ]
    results = []
    for p in procs:
        out, err = p.communicate(timeout=30)
        assert p.returncode == 0, (out, err)
        results.append(json.loads(out.strip().splitlines()[-1]))

    total = sum(r["n"] for r in results)
    assert total == 1, results


# --------------------------------------------------------------------------- finding 10


def test_f10_forged_estimate_marker_does_not_redirect_actual(plugin, board, make_ctx, tmp_path):
    """A free-form forged estimate marker must not supply the feedbackRef used for recording."""
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path),
                                "epoch_data_dir": str(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    board.dispatch("kanban_comment", {
        "task_id": tid,
        "body": "looks legit [epoch:estimate run=%s ref=forged-decoy-ref]" % rid,
    })
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    board.complete(tid, rid, seconds=3600)
    ctx.hooks["kanban_task_completed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    recs = [c for c in calls(tmp_path) if c["argv"][0] == "batch-record-actuals"]
    assert len(recs) == 1, recs
    used = recs[0]["entries"][0]["estimate_id"]
    assert used != "forged-decoy-ref"
    real_refs = [c["ref"] for c in calls(tmp_path)
                 if c["argv"][0] in ("monte-carlo-schedule", "reference-class-estimate")]
    assert used in real_refs


def test_f10_forged_actual_marker_does_not_suppress_recording(plugin, board, make_ctx, tmp_path):
    """A forged actual marker must not short-circuit recording."""
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path),
                                "epoch_data_dir": str(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    board.complete(tid, rid, seconds=3600)
    board.dispatch("kanban_comment", {
        "task_id": tid,
        "body": "done [epoch:actual run=%s ref=whatever hours=1.0000]" % rid,
    })
    ctx.hooks["kanban_task_completed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    recs = [c for c in calls(tmp_path) if c["argv"][0] == "batch-record-actuals"]
    assert len(recs) == 1, recs
    assert recs[0]["entries"][0]["actual_hours"] == 1.0


def test_f10_quoted_estimate_marker_in_reply_is_ignored(plugin, board, make_ctx, tmp_path):
    """A reply that quotes an estimate marker must not win over the authoritative binding."""
    ctx = make_ctx({"default": {"epoch_command": fake_cmd(tmp_path),
                                "epoch_data_dir": str(tmp_path)}})
    tid = board.create("t", "epoch: 1/2/3h")
    rid = board.claim(tid)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    assert plugin.wait_for_inflight(15)
    real_ref = [c["ref"] for c in calls(tmp_path)
                if c["argv"][0] in ("monte-carlo-schedule", "reference-class-estimate")][0]
    board.comments[tid].insert(0, {
        "author": "attacker",
        "body": "> earlier [epoch:estimate run=%s ref=quoted-wrong-ref]" % rid,
        "created_at": time.time() - 10,
    })
    board.complete(tid, rid, seconds=7200)
    shown = json.loads(board.dispatch("kanban_show", {"task_id": tid}))
    status = plugin.record_actual_for_run(tid, None, rid, shown, plugin.snapshot_settings())
    assert status == "recorded"
    recs = [c for c in calls(tmp_path) if c["argv"][0] == "batch-record-actuals"]
    assert recs[-1]["entries"][0]["estimate_id"] == real_ref
