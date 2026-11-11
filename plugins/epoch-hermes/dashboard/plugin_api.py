"""Epoch Desktop backend, mounted at /api/plugins/epoch/.

GET /tasks                      open Kanban cards on every board, and the `epoch: o/m/p` hint each carries
GET /forecast?board=&task_id=   Monte Carlo for one card's hint, with the histogram when Epoch is >= 0.8
GET /history                    estimate vs actual for runs this plugin recorded in its ledger
GET /badges                     P50/P90 per task id, read from the estimates this plugin posted

Read-only. A forecast runs against a throwaway EPOCH_DATA_DIR, so looking at a chart never
adds a row to the ledger; /history and /badges only read the ledger and the run bindings.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

PLUGIN_DIR = Path(__file__).resolve().parent.parent
PLUGIN_ID = "epoch"
SEED = 42
OPEN_STATUSES_LAST = ("done", "archived", "cancelled", "canceled")
MAX_TASKS = 300
HISTORY_KEEP = 12
_TASK_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_BOARD_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
# Hours ("4.0h"), or whole minutes below an hour ("25m").
_BODY_PCT_RE = re.compile(r"P50 ([\d.]+)([hm])\s*·\s*P90 ([\d.]+)([hm])")
_PRIVATE = "_epoch_hermes_desktop_backend"
_cache: "OrderedDict[tuple, Dict[str, Any]]" = OrderedDict()
_cache_lock = threading.Lock()

router = APIRouter()


def _plugin():
    """The loaded Epoch plugin module (its registered ``_ctx`` resolves settings), else a private copy."""
    target = (PLUGIN_DIR / "__init__.py").resolve()
    fallback = None
    for module in list(sys.modules.values()):
        filename = getattr(module, "__file__", None)
        if not filename:
            continue
        try:
            if Path(filename).resolve() != target:
                continue
        except OSError:
            continue
        if getattr(module, "_ctx", None) is not None:
            return module
        fallback = fallback or module
    if fallback is not None:
        return fallback
    spec = importlib.util.spec_from_file_location(_PRIVATE, target)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[_PRIVATE] = mod
    try:
        spec.loader.exec_module(mod)
    except BaseException:
        sys.modules.pop(_PRIVATE, None)
        raise
    return mod


def _settings(mod) -> Dict[str, Any]:
    if getattr(mod, "_ctx", None) is not None:
        return mod.snapshot_settings()
    out = dict(mod.DEFAULTS)
    try:
        from hermes_cli.config import load_config_readonly  # type: ignore

        entry = ((load_config_readonly() or {}).get("plugins") or {}).get("entries", {}).get(PLUGIN_ID) or {}
        for key, val in (entry.get("settings") or {}).items():
            if key in out and val is not None:
                out[key] = val
    except Exception:  # noqa: BLE001 - outside Hermes the defaults stand
        pass
    return out


def _boards() -> List[str]:
    try:
        from hermes_cli import kanban_db_boards as kb  # type: ignore

        slugs = [b.get("slug") or b.get("name") for b in kb.list_boards(include_archived=False)
                 if not b.get("archived")]
        return [s for s in slugs if s] or ["default"]
    except Exception:  # noqa: BLE001
        return ["default"]


def _hint_fields(mod, title: str, body: str) -> Dict[str, Any]:
    hint, problem = mod.find_hint(title or "", body or "")
    return {"hint": hint, "hint_error": problem}


def list_open_tasks(mod, boards: Optional[List[str]] = None) -> Dict[str, Any]:
    from hermes_cli import kanban_db  # type: ignore
    from hermes_cli import kanban_db_connect as kbc  # type: ignore
    from contextlib import closing

    tasks: List[Dict[str, Any]] = []
    errors: List[str] = []
    for board in boards or _boards():
        try:
            conn = kbc.connect(board=board)
        except Exception as exc:  # noqa: BLE001 - one board must not hide the others
            errors.append(f"{board}: {type(exc).__name__}")
            continue
        with closing(conn):
            try:
                # Ask per open status: one LIMIT over the whole board returns its oldest rows,
                # done cards included, and a busy board's newer open cards fall off the end.
                open_statuses = [s for s in sorted(getattr(kanban_db, "VALID_STATUSES", ()) or ())
                                 if s not in OPEN_STATUSES_LAST]
                rows = ([t for s in open_statuses for t in kanban_db.list_tasks(conn, status=s, limit=MAX_TASKS)]
                        if open_statuses else kanban_db.list_tasks(conn))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{board}: {type(exc).__name__}")
                continue
            for t in rows:
                if (t.status or "") in OPEN_STATUSES_LAST:
                    continue
                tasks.append({"board": board, "id": t.id, "title": t.title or t.id, "status": t.status,
                              "priority": t.priority or 0, **_hint_fields(mod, t.title, t.body)})
    tasks.sort(key=lambda t: (t["hint"] is None, -int(t["priority"] or 0), t["title"].lower()))
    return {"tasks": tasks[:MAX_TASKS], "errors": errors}


def _get_task(board: str, task_id: str):
    from hermes_cli import kanban_db  # type: ignore
    from hermes_cli import kanban_db_connect as kbc  # type: ignore
    from contextlib import closing

    with closing(kbc.connect(board=board)) as conn:
        return kanban_db.get_task(conn, task_id)


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _valid_distribution(d: Any) -> Optional[Dict[str, Any]]:
    """The 0.8 histogram, or None when it is missing or malformed (never trust its shape)."""
    if not isinstance(d, dict):
        return None
    edges = [_num(x) for x in d.get("edges") or []]
    counts = d.get("counts") or []
    if len(edges) < 2 or len(counts) != len(edges) - 1 or None in edges:
        return None
    if any(b < a for a, b in zip(edges, edges[1:])):
        return None
    if not all(isinstance(c, int) and not isinstance(c, bool) and c >= 0 for c in counts):
        return None
    return {"edges": edges, "counts": counts}


def run_forecast(mod, settings: Dict[str, Any], title: str, triple: Dict[str, float]) -> Dict[str, Any]:
    """One Monte Carlo run for a triple (hours), in a throwaway data dir. Cached per triple."""
    iterations = int(settings.get("iterations") or mod.DEFAULTS["iterations"])
    key = (triple["optimistic"], triple["most_likely"], triple["pessimistic"], iterations,
           str(settings.get("epoch_command")))
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    task = {"name": (title or "task")[:80],
            **{k: round(v / mod.WORKDAY_HOURS, 6) for k, v in triple.items()}}
    base = ["monte-carlo-schedule", "--tasks", json.dumps([task]), "--iterations", str(iterations)]
    with tempfile.TemporaryDirectory(prefix="epoch-desktop-") as scratch:
        run_settings = {**settings, "epoch_data_dir": scratch}
        res = mod.run_epoch(base + ["--seed", str(SEED), "--distribution"], run_settings)
        old_cli = False
        if not res.get("ok") and re.search(r"unknown option|distribution|seed", mod._error_text(res), re.I):
            old_cli = True
            res = mod.run_epoch(base, run_settings)
    if not res.get("ok") or not isinstance(res.get("data"), dict):
        return {"ok": False, "error": mod._error_text(res)[:300]}
    d = res["data"]
    pct = {k: _num(d.get(k)) for k in ("p10", "p50", "p80", "p90", "p95")}
    dist = _valid_distribution(d.get("distribution"))
    risks = []
    for r in d.get("riskEvents") or []:
        if isinstance(r, dict) and isinstance(r.get("description"), str):
            risks.append({"description": r["description"][:200], "probability": _num(r.get("probability")),
                          "impact_days": _num(r.get("impactDays", r.get("impact")))})
    out = {"ok": True, "iterations": iterations, "seed": SEED if not old_cli else None,
           "percentiles_days": pct, "distribution": dist, "risks": risks[:6],
           "needs_epoch_0_8": dist is None}
    with _cache_lock:
        _cache[key] = out
        while len(_cache) > 64:
            _cache.popitem(last=False)
    return out


def _jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
    except OSError:
        pass
    return rows


def read_history(data_dir: Path, keep: int = HISTORY_KEEP) -> List[Dict[str, Any]]:
    """Monte Carlo estimates that have a recorded actual, newest first (days)."""
    actuals: Dict[str, Dict[str, Any]] = {}
    for row in _jsonl(data_dir / "feedback.jsonl"):
        ref, hours = row.get("estimateId"), _num(row.get("actualHours"))
        if isinstance(ref, str) and hours is not None and hours > 0:
            actuals[ref] = {"hours": hours, "at": str(row.get("reportedAt") or "")}
    out = []
    for row in _jsonl(data_dir / "estimates.jsonl"):
        ref = row.get("id")
        if row.get("tool") != "monte_carlo_schedule" or ref not in actuals:
            continue
        o = row.get("outputs") or {}
        p50, p90 = _num(o.get("p50")), _num(o.get("p90"))
        if p50 is None:
            continue
        tasks = (row.get("inputs") or {}).get("tasks")
        name = "Estimate"
        if isinstance(tasks, str):
            try:
                tasks = json.loads(tasks)
            except ValueError:
                tasks = None
        if isinstance(tasks, list) and tasks:
            first = tasks[0] if isinstance(tasks[0], dict) else {}
            name = str(first.get("name") or "Estimate")[:80]
            if len(tasks) > 1:
                name += f" +{len(tasks) - 1}"
        a = actuals[ref]
        out.append({"name": name, "p50_days": p50, "p90_days": p90,
                    "actual_days": round(a["hours"] / 8.0, 4), "reported_at": a["at"]})
    out.sort(key=lambda r: r["reported_at"], reverse=True)
    return out[:keep]


def read_badges(bindings_path: Path) -> Dict[str, Dict[str, Any]]:
    """task id -> P50/P90 hours from the newest run's posted estimate.

    Desktop's card decorator only sees the card id, never its board. A task id bound on two
    boards is therefore ambiguous and gets no badge, rather than showing another board's
    estimate on the wrong card."""
    try:
        data = json.loads(bindings_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    best: Dict[str, tuple] = {}
    boards: Dict[str, set] = {}
    if not isinstance(data, dict):
        return {}
    for key, val in data.items():
        if not isinstance(val, dict) or key.count(":") < 2:
            continue
        board, rest = key.split(":", 1)
        task_id, run = rest.rsplit(":", 1)
        m = _BODY_PCT_RE.search(str(val.get("estimate_comment_body") or ""))
        if not m:
            continue
        boards.setdefault(task_id, set()).add(board)
        try:
            run_n = int(run)
        except ValueError:
            run_n = -1
        if task_id not in best or run_n > best[task_id][0]:
            best[task_id] = (run_n, {"board": board, "p50_hours": _to_hours(m.group(1), m.group(2)),
                                     "p90_hours": _to_hours(m.group(3), m.group(4))})
    return {k: v[1] for k, v in best.items() if len(boards.get(k, ())) == 1}


def _to_hours(value: str, unit: str) -> float:
    return float(value) / 60 if unit == "m" else float(value)


def _check_ref(board: str, task_id: str) -> None:
    if not _BOARD_RE.match(board or "") or not _TASK_ID_RE.match(task_id or ""):
        raise HTTPException(status_code=400, detail="bad board or task id")


@router.get("/tasks")
def tasks():
    mod = _plugin()
    try:
        return list_open_tasks(mod)
    except ImportError:
        raise HTTPException(status_code=503, detail="Kanban is not available in this Hermes")


@router.get("/forecast")
def forecast(board: str = "default", task_id: str = ""):
    _check_ref(board, task_id)
    mod = _plugin()
    try:
        task = _get_task(board, task_id)
    except ImportError:
        raise HTTPException(status_code=503, detail="Kanban is not available in this Hermes")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"board {board}: {type(exc).__name__}")
    if task is None:
        raise HTTPException(status_code=404, detail="no such card")
    head = {"board": board, "task_id": task.id, "title": task.title or task.id, "status": task.status}
    fields = _hint_fields(mod, task.title, task.body)
    if not fields["hint"]:
        return {**head, **fields, "ok": False,
                "error": "This card has no three-point hint. Add `epoch: 2/4/10h` to its title or body."}
    return {**head, **fields, **run_forecast(mod, _settings(mod), task.title, fields["hint"])}


@router.get("/history")
def history():
    mod = _plugin()
    return {"items": read_history(mod._epoch_data_dir(_settings(mod)))}


@router.get("/badges")
def badges():
    mod = _plugin()
    return {"tasks": read_badges(mod._epoch_data_dir(_settings(mod)) / mod.BINDINGS_FILE)}
