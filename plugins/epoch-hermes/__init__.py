"""Epoch Estimator — native Hermes plugin.

kanban_task_claimed   -> estimate the task (three-point hint in body, else reference class)
                         and post P50/P80/P95 as a Kanban comment.
kanban_task_completed -> record actual wall-clock hours against the stored feedbackRef.
/epoch <cli args>     -> run any Epoch CLI subcommand (e.g. /epoch pert-estimate ...).
epoch_estimate tool   -> agent-callable Monte Carlo estimate.

Hooks fire in the dispatcher/worker after the DB commit; all Epoch work runs on a
daemon thread so a slow `npx` never delays worker spawn. Every path is best-effort
and never raises into Hermes.
"""

from __future__ import annotations

import json
import logging
import re
import shlex
import subprocess
import threading
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULTS = {
    "epoch_command": "npx -y @kyanitelabs/epoch@0.6.0",
    "comment_on_claim": True,
    "record_actuals": True,
    "iterations": 5000,
    "timeout_seconds": 60,
}

# "epoch: 2/4/10" or "estimate: 2-4-10 h" (optimistic/most-likely/pessimistic, hours)
_HINT_RE = re.compile(
    r"(?:epoch|estimate)\s*:\s*([\d.]+)\s*[/\-,]\s*([\d.]+)\s*[/\-,]\s*([\d.]+)\s*(h|hours?|d|days?)?",
    re.IGNORECASE,
)
_TYPE_WORDS = {
    "bugfix": ("bug", "fix", "regression", "crash"),
    "refactor": ("refactor", "cleanup", "rename"),
    "migration": ("migrate", "migration", "upgrade"),
    "infrastructure": ("deploy", "ci", "infra", "docker", "gateway"),
    "documentation": ("doc", "readme", "docs"),
    "testing": ("test", "qa", "coverage"),
    "design": ("design", "icon", "ui", "mock"),
}

_ctx = None


def _cfg(key: str) -> Any:
    try:
        val = _ctx.get_config(key, None) if _ctx is not None else None
    except Exception:
        val = None
    return DEFAULTS[key] if val is None else val


def run_epoch(args: list[str]) -> Dict[str, Any]:
    """Run the Epoch CLI and return its parsed {ok, data} envelope (or an error dict)."""
    cmd = shlex.split(str(_cfg("epoch_command"))) + args
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=int(_cfg("timeout_seconds")))
    except FileNotFoundError as exc:
        return {"ok": False, "error": f"epoch not runnable: {exc}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "epoch timed out"}
    out = proc.stdout.strip()
    start = out.find("{")
    try:
        return json.loads(out[start:]) if start >= 0 else {"ok": False, "error": proc.stderr.strip()[-500:]}
    except json.JSONDecodeError:
        return {"ok": False, "error": out[-500:] or proc.stderr.strip()[-500:]}


def parse_hint(text: str) -> Optional[Dict[str, float]]:
    m = _HINT_RE.search(text or "")
    if not m:
        return None
    o, ml, p = (float(x) for x in m.groups()[:3])
    unit = (m.group(4) or "h").lower()
    scale = 8.0 if unit.startswith("d") else 1.0  # Epoch MC takes days; normalise below
    return {"optimistic": o * scale, "most_likely": ml * scale, "pessimistic": p * scale}


def guess_type(text: str) -> str:
    low = (text or "").lower()
    for ttype, words in _TYPE_WORDS.items():
        if any(re.search(rf"\b{w}\b", low) for w in words):
            return ttype
    return "feature"


def estimate(title: str, body: str = "") -> Dict[str, Any]:
    """Return {'summary', 'feedbackRef', 'method', 'raw'} for a task."""
    hint = parse_hint(f"{title}\n{body}")
    if hint:
        # Epoch monte_carlo_schedule works in days (8h workday); hint is in hours.
        task = {"name": title[:80] or "task", **{k: round(v / 8.0, 4) for k, v in hint.items()}}
        res = run_epoch(["monte-carlo-schedule", "--tasks", json.dumps([task]),
                         "--iterations", str(int(_cfg("iterations")))])
        if not res.get("ok"):
            return {"summary": f"Epoch estimate failed: {res.get('error')}", "raw": res}
        d = res["data"]
        h = lambda k: f"{float(d[k]) * 8:.1f}h"  # noqa: E731
        summary = (f"⏱ Epoch estimate — P50 {h('p50')} · P80 {h('p80')} · P95 {h('p95')} "
                   f"(Monte Carlo, {_cfg('iterations')} runs, from hint "
                   f"{hint['optimistic']:g}/{hint['most_likely']:g}/{hint['pessimistic']:g}h)")
        return {"summary": summary, "feedbackRef": d.get("feedbackRef"), "method": "monte_carlo", "raw": d}
    ttype = guess_type(f"{title} {body}")
    res = run_epoch(["reference-class-estimate", "--task-type", ttype, "--complexity", "3"])
    if not res.get("ok"):
        return {"summary": f"Epoch estimate failed: {res.get('error')}", "raw": res}
    d = res["data"]
    summary = (f"⏱ Epoch estimate — ~{d.get('correctedEstimate')}h ({ttype}, reference class; "
               f"confidence {d.get('confidence')}). Add `epoch: o/m/p` hours to the task body "
               f"for a P50/P80/P95 range.")
    return {"summary": summary, "feedbackRef": d.get("feedbackRef"), "method": "reference_class", "raw": d}


def _with_task(task_id: str, board: Optional[str], fn) -> None:
    from hermes_cli import kanban_db
    try:
        from hermes_cli.kanban_db_connect import connect_closing
    except ImportError:  # older Hermes
        connect_closing = kanban_db.connect_closing
    with connect_closing(board=board) as conn:
        task = kanban_db.get_task(conn, task_id)
        if task is not None:
            fn(conn, task)


def _claimed_worker(task_id: str, board: Optional[str]) -> None:
    try:
        from hermes_cli import kanban_db

        def go(conn, task):
            result = estimate(task.title or "", task.body or "")
            if result.get("feedbackRef") and _ctx is not None:
                _ctx.state.set(f"ref:{task_id}", result["feedbackRef"])
            if _cfg("comment_on_claim"):
                kanban_db.add_comment(conn, task_id, "epoch", result["summary"])
        _with_task(task_id, board, go)
    except Exception:
        logger.debug("epoch: claimed hook failed for %s", task_id, exc_info=True)


def _completed_worker(task_id: str, board: Optional[str]) -> None:
    try:
        ref = _ctx.state.get(f"ref:{task_id}") if _ctx is not None else None
        if not ref:
            return
        from hermes_cli import kanban_db

        def go(conn, task):
            if not (task.started_at and task.completed_at):
                return
            hours = max(0.01, (task.completed_at - task.started_at) / 3600.0)
            res = run_epoch(["record-actual", "--estimate-id", str(ref), "--actual-hours", f"{hours:.2f}",
                             "--notes", f"hermes kanban {task_id} (wall-clock)"])
            if res.get("ok"):
                kanban_db.add_comment(conn, task_id, "epoch", f"⏱ Epoch recorded actual {hours:.2f}h.")
                _ctx.state.set(f"ref:{task_id}", None)
        _with_task(task_id, board, go)
    except Exception:
        logger.debug("epoch: completed hook failed for %s", task_id, exc_info=True)


def _spawn(fn, *args) -> None:
    threading.Thread(target=fn, args=args, daemon=True, name="epoch-hook").start()


def _on_claimed(task_id: str = "", board: Optional[str] = None, **_: Any) -> None:
    if task_id:
        _spawn(_claimed_worker, task_id, board)


def _on_completed(task_id: str = "", board: Optional[str] = None, **_: Any) -> None:
    if task_id and _cfg("record_actuals"):
        _spawn(_completed_worker, task_id, board)


def _slash(raw_args: str) -> str:
    args = shlex.split(raw_args or "")
    if not args:
        return "Usage: /epoch <epoch-cli-subcommand> [flags]  e.g. /epoch pert-estimate --optimistic 2 --most-likely 4 --pessimistic 10"
    res = run_epoch(args)
    data = res.get("data") if isinstance(res.get("data"), dict) else None
    if res.get("ok") and data and data.get("humanReadable"):
        return data["humanReadable"]
    return json.dumps(res, indent=2)[:3500]


ESTIMATE_SCHEMA = {
    "name": "epoch_estimate",
    "description": "Calibrated time estimate for a task via Epoch. Give optimistic/most_likely/pessimistic hours for a P50/P80/P95 Monte Carlo range; otherwise Epoch uses reference-class forecasting from the title.",
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "body": {"type": "string"},
            "optimistic": {"type": "number", "description": "hours"},
            "most_likely": {"type": "number", "description": "hours"},
            "pessimistic": {"type": "number", "description": "hours"},
        },
        "required": ["title"],
    },
}


def _tool(args: Dict[str, Any], **_: Any) -> str:
    body = args.get("body") or ""
    if all(args.get(k) is not None for k in ("optimistic", "most_likely", "pessimistic")):
        body += f"\nepoch: {args['optimistic']}/{args['most_likely']}/{args['pessimistic']}h"
    r = estimate(args.get("title", ""), body)
    return json.dumps({"summary": r["summary"], "feedbackRef": r.get("feedbackRef"), "method": r.get("method")})


def register(ctx) -> None:
    global _ctx
    _ctx = ctx
    ctx.register_hook("kanban_task_claimed", _on_claimed)
    ctx.register_hook("kanban_task_completed", _on_completed)
    ctx.register_command("epoch", handler=_slash, description="Run Epoch time-estimation CLI.",
                         args_hint="<subcommand> [flags]")
    ctx.register_tool(name="epoch_estimate", toolset="epoch", schema=ESTIMATE_SCHEMA, handler=_tool,
                      description=ESTIMATE_SCHEMA["description"], emoji="⏱")
