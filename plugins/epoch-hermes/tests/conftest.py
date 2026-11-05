"""Shared harness for the epoch-hermes plugin tests.

Unit tests use :class:`FakeCtx` — a stand-in for Hermes' PluginContext whose ``get_config`` and
``state`` are scoped by a ContextVar, exactly like Hermes resolves the active profile through
``_HERMES_HOME_OVERRIDE`` — plus an in-memory board behind ``dispatch_tool`` that speaks the
public ``kanban_show`` / ``kanban_comment`` contract. ``test_hermes_e2e.py`` repeats the key
scenarios against real Hermes in separate processes.
"""
from __future__ import annotations

import contextvars
import importlib.util
import itertools
import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parent.parent
FAKE_EPOCH = Path(__file__).resolve().parent / "fake_epoch.py"
PROFILE: contextvars.ContextVar[str] = contextvars.ContextVar("test_profile", default="default")


def load_plugin():
    name = f"epoch_hermes_under_test_{uuid.uuid4().hex[:8]}"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class FakeBoard:
    """Minimal kanban board: tasks, runs (with outcome/started_at/ended_at) and comments."""

    def __init__(self):
        self.lock = threading.Lock()
        self.tasks: dict = {}
        self.runs: dict = {}
        self.comments: dict = {}
        self._ids = itertools.count(1)
        self.now = 1_000_000

    def create(self, title, body=""):
        tid = f"t_{next(self._ids)}"
        self.tasks[tid] = {"id": tid, "title": title, "body": body, "status": "ready",
                           "current_run_id": None, "started_at": None, "completed_at": None}
        self.runs[tid], self.comments[tid] = [], []
        return tid

    def claim(self, tid):
        with self.lock:
            rid = next(self._ids)
            self.runs[tid].append({"id": rid, "profile": None, "status": "running", "outcome": None,
                                   "started_at": self.now, "ended_at": None})
            self.tasks[tid].update(current_run_id=rid, status="running", started_at=self.now)
            return rid

    def _end(self, tid, rid, outcome, seconds):
        with self.lock:
            run = next(r for r in self.runs[tid] if r["id"] == rid)
            run.update(outcome=outcome, status="done", ended_at=run["started_at"] + int(seconds))
            self.tasks[tid]["current_run_id"] = None
            if outcome == "completed":
                self.tasks[tid].update(status="done", completed_at=run["ended_at"])
            else:
                self.tasks[tid]["status"] = "ready"

    def complete(self, tid, rid, seconds=3600):
        self._end(tid, rid, "completed", seconds)

    def reclaim(self, tid, rid):
        self._end(tid, rid, "reclaimed", 60)

    def bodies(self, tid):
        return [c["body"] for c in self.comments[tid]]

    def dispatch(self, tool, args):
        tid = args.get("task_id")
        with self.lock:
            if tid not in self.tasks:
                return json.dumps({"error": f"task {tid} not found"})
            if tool == "kanban_show":
                return json.dumps({"task": dict(self.tasks[tid]),
                                   "runs": [dict(r) for r in self.runs[tid]],
                                   "comments": [dict(c) for c in self.comments[tid]]})
            if tool == "kanban_comment":
                self.comments[tid].append({"author": PROFILE.get(), "body": args["body"],
                                           "created_at": time.time()})
                return json.dumps({"ok": True})
        return json.dumps({"error": f"Unknown tool: {tool}"})


class FakeState:
    def __init__(self, store, lock):
        self._store, self._lock = store, lock

    def _bucket(self):
        return self._store.setdefault(PROFILE.get(), {})

    def get(self, key, default=None):
        with self._lock:
            return json.loads(json.dumps(self._bucket().get(key, default)))

    def set(self, key, value):
        with self._lock:
            self._bucket()[key] = json.loads(json.dumps(value))


class FakeCtx:
    """Profile-scoped like Hermes: config and state resolve PROFILE at access time."""

    def __init__(self, board, settings_by_profile):
        self.board = board
        self.settings_by_profile = settings_by_profile
        self.state_store: dict = {}
        self.state = FakeState(self.state_store, threading.Lock())
        self.hooks, self.tools, self.commands = {}, {}, {}
        self.dispatch_calls = []

    def get_config(self, key, default=None):
        settings = self.settings_by_profile.get(PROFILE.get(), {})
        if key == "epoch_command" and key not in settings:
            return "epoch-not-configured-in-this-test"  # never fall through to real npx
        return settings.get(key, default)

    def dispatch_tool(self, tool, args, **_):
        self.dispatch_calls.append((PROFILE.get(), tool, dict(args)))
        return self.board.dispatch(tool, args)

    def register_hook(self, name, cb):
        self.hooks[name] = cb

    def register_tool(self, name, **kw):
        self.tools[name] = kw

    def register_command(self, name, **kw):
        self.commands[name] = kw


def fake_cmd(tmp: Path, tag: str = "", **env) -> str:
    """An ``epoch_command`` that runs fake_epoch.py with a tag + env baked in."""
    pre = " ".join(f"{k}={v}" for k, v in {"FAKE_EPOCH_TAG": tag or "x", "EPOCH_DATA_DIR": str(tmp),
                                            **env}.items())
    return f"env {pre} {sys.executable} {FAKE_EPOCH}"


def calls(tmp: Path):
    p = Path(tmp) / "calls.jsonl"
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


@pytest.fixture
def plugin():
    return load_plugin()


@pytest.fixture
def board():
    return FakeBoard()


@pytest.fixture
def make_ctx(plugin, board):
    def _make(settings_by_profile):
        ctx = FakeCtx(board, settings_by_profile)
        plugin.register(ctx)
        return ctx
    yield _make
    plugin.wait_for_inflight(10)
