#!/usr/bin/env python3
"""Show P50/P90 on a Kanban card by driving the real Epoch Hermes hooks.

This is an in-process demo. It loads ``plugins/epoch-hermes`` and fires
``kanban_task_claimed`` / ``kanban_task_completed`` against a throwaway board.
Board reads and writes go through the same ``ctx.dispatch_tool`` path the
plugin uses in Hermes (``kanban_show``, ``kanban_comment``). No secret is
required, so nothing is read from Hermes secret storage, ``auth.json``, or the
environment beyond the Epoch child allow-list.

The script does not install Hermes, run ``hermes update``, restart a gateway,
or talk to a live Hermes home. ``HERMES_HOME`` and the Epoch ledger are pointed
at a temporary directory for the run.

Engine, in order:

1. ``EPOCH_DEMO_COMMAND`` when set to a local command (not ``npx``, not ``hermes``).
2. This repo's built ``dist/index.js`` when Node can run it.
3. ``tests/fake_epoch.py``, which returns deterministic percentiles.

Finishes in under 90 seconds or exits 2. Usage::

    python plugins/epoch-hermes/scripts/demo.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

LIMIT_SECONDS = 90.0
PLUGIN_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_DIR.parents[1]
FAKE_EPOCH = PLUGIN_DIR / "tests" / "fake_epoch.py"
DIST_CLI = REPO_ROOT / "dist" / "index.js"
WALL_CLOCK_SECONDS = 3 * 3600


def resolve_epoch_command(env: dict[str, str] | None = None) -> tuple[str, str]:
    """Return ``(command, label)`` for the Epoch child. Never selects npx or hermes."""
    env = os.environ if env is None else env
    override = (env.get("EPOCH_DEMO_COMMAND") or "").strip()
    if override:
        _refuse_remote_command(override)
        return override, "EPOCH_DEMO_COMMAND"
    node = shutil.which("node")
    if DIST_CLI.is_file() and node:
        return f"{node} {DIST_CLI}", "local-dist"
    return f"{sys.executable} {FAKE_EPOCH}", "bundled-fake"


def _refuse_remote_command(command: str) -> None:
    first = command.split()[0] if command.split() else ""
    name = Path(first).name
    if name in {"npx", "npm", "hermes"} or name.startswith("hermes"):
        raise SystemExit(
            "demo refuses npx, npm, and hermes commands so it cannot download a package, "
            "update Hermes, or touch a gateway. Point EPOCH_DEMO_COMMAND at a local epoch "
            "binary, or leave it unset."
        )


def load_plugin():
    name = f"epoch_hermes_demo_{uuid.uuid4().hex[:8]}"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py")
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {PLUGIN_DIR / '__init__.py'}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class _Board:
    """In-memory board that speaks the public kanban_show / kanban_comment JSON."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.tasks: dict = {}
        self.runs: dict = {}
        self.comments: dict = {}
        self._ids = 0

    def create(self, title: str, body: str) -> str:
        self._ids += 1
        tid = f"t_{self._ids}"
        self.tasks[tid] = {
            "id": tid, "title": title, "body": body, "status": "ready",
            "current_run_id": None,
        }
        self.runs[tid] = []
        self.comments[tid] = []
        return tid

    def claim(self, tid: str, now: int) -> int:
        with self._lock:
            self._ids += 1
            rid = self._ids
            self.runs[tid].append({
                "id": rid, "status": "running", "outcome": None,
                "started_at": now, "ended_at": None,
            })
            self.tasks[tid].update(current_run_id=rid, status="running")
            return rid

    def complete(self, tid: str, rid: int, seconds: int) -> None:
        with self._lock:
            run = next(r for r in self.runs[tid] if r["id"] == rid)
            run.update(outcome="completed", status="done", ended_at=int(run["started_at"]) + int(seconds))
            self.tasks[tid].update(status="done", current_run_id=None, completed_at=run["ended_at"])

    def dispatch(self, tool: str, args: dict) -> str:
        tid = args.get("task_id")
        with self._lock:
            if tid not in self.tasks:
                return json.dumps({"error": f"task {tid} not found"})
            if tool == "kanban_show":
                return json.dumps({
                    "task": dict(self.tasks[tid]),
                    "runs": [dict(r) for r in self.runs[tid]],
                    "comments": [dict(c) for c in self.comments[tid]],
                })
            if tool == "kanban_comment":
                self.comments[tid].append({"author": "epoch", "body": args["body"]})
                return json.dumps({"ok": True})
        return json.dumps({"error": f"Unknown tool: {tool}"})


class _State:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict = {}

    def get(self, key, default=None):
        with self._lock:
            if key not in self._data:
                return default
            return json.loads(json.dumps(self._data[key]))

    def set(self, key, value) -> None:
        with self._lock:
            self._data[key] = json.loads(json.dumps(value))

    def update(self, key, mutator, default=None):
        with self._lock:
            current = self._data.get(key, default)
            current = json.loads(json.dumps(current))
            updated = mutator(current)
            self._data[key] = json.loads(json.dumps(updated))
            return json.loads(json.dumps(updated))


class _Ctx:
    def __init__(self, board: _Board, settings: dict) -> None:
        self.board = board
        self.settings = settings
        self.state = _State()
        self.hooks: dict = {}

    def get_config(self, key, default=None):
        if key in self.settings:
            return self.settings[key]
        return default

    def dispatch_tool(self, tool, args, **_):
        return self.board.dispatch(tool, args)

    def register_hook(self, name, cb) -> None:
        self.hooks[name] = cb

    def register_tool(self, name, **_kw) -> None:
        return None

    def register_command(self, name, **_kw) -> None:
        return None


def _prepare_home(root: Path) -> Path:
    ledger = root / "ledger"
    home = root / "hermes-home"
    ledger.mkdir(parents=True, exist_ok=True)
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(home)
    os.environ["EPOCH_DATA_DIR"] = str(ledger)
    os.environ["EPOCH_TELEMETRY"] = "0"
    return ledger


def main() -> int:
    started = time.monotonic()
    try:
        command, label = resolve_epoch_command()
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 1
    root = Path(os.environ.get("EPOCH_DEMO_DIR") or tempfile.mkdtemp(prefix="epoch-hermes-demo-"))
    ledger = _prepare_home(root)

    plugin = load_plugin()
    board = _Board()
    settings = {
        "epoch_command": command,
        "epoch_data_dir": str(ledger),
        "iterations": 400,
        "timeout_seconds": 40,
        "shutdown_wait_seconds": 2,
        "comment_on_claim": True,
        "record_actuals": True,
        "allow_write_slash_on_gateway": False,
    }
    ctx = _Ctx(board, settings)
    plugin.register(ctx)

    title = "Write the Epoch catalog listing"
    body = "Draft the Hermes catalog PR for Simon.\nepoch: 2/4/10h"
    tid = board.create(title, body)
    rid = board.claim(tid, now=1_700_000_000)
    ctx.hooks["kanban_task_claimed"](task_id=tid, run_id=rid)
    if not plugin.wait_for_inflight(40):
        print("estimate hook did not finish before the demo budget", file=sys.stderr)
        return 1
    board.complete(tid, rid, seconds=WALL_CLOCK_SECONDS)
    ctx.hooks["kanban_task_completed"](task_id=tid, run_id=rid)
    if not plugin.wait_for_inflight(20):
        print("completion hook did not finish before the demo budget", file=sys.stderr)
        return 1

    comments = [c["body"] for c in board.comments[tid]]
    estimate = next((c for c in comments if "[epoch:estimate" in c), "")
    actual = next((c for c in comments if "[epoch:actual" in c), "")
    elapsed = time.monotonic() - started

    print("Epoch Hermes demo — P50/P90 on a Kanban card")
    print(f"engine: {label}")
    print(f"command: {command}")
    print(f"hermes_home: {os.environ['HERMES_HOME']}")
    print(f"ledger: {ledger}")
    print(f"card: {title} ({tid})")
    print("hint: epoch: 2/4/10h")
    print()
    print("--- comment on claim ---")
    print(estimate or "(no estimate comment)")
    print()
    print("--- comment on complete ---")
    print(actual or "(no actual comment)")
    print()
    print(f"demo finished in {elapsed:.2f}s (limit {LIMIT_SECONDS:.0f}s)")

    if "P50" not in estimate or "P90" not in estimate:
        print("estimate comment is missing P50/P90", file=sys.stderr)
        return 1
    if "n/a" in estimate.split("P90", 1)[-1][:12]:
        print("P90 was not produced; the Epoch CLI is older than 0.7", file=sys.stderr)
        return 1
    if "[epoch:actual" not in actual:
        print("completion hook did not post an actual comment", file=sys.stderr)
        return 1
    if elapsed >= LIMIT_SECONDS:
        print(f"demo exceeded {LIMIT_SECONDS:.0f}s", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
