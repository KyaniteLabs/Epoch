"""Epoch Estimator — native Hermes plugin.

kanban_task_claimed   -> estimate the task (explicit three-point hint, else reference class),
                         post P50/P90 as a Kanban comment that carries a machine-readable
                         ``[epoch:estimate run=<run_id> ref=<feedbackRef>]`` marker.
kanban_task_completed -> find the estimate marker for the *same run* on the board and record
                         that run's wall-clock hours to Epoch with
                         ``calibration_provenance: auto_wallclock`` (so Epoch's sanity gates apply).
/epoch <cli args>     -> run an Epoch CLI subcommand (e.g. /epoch pert-estimate ...); serve,
                         self-improve and telemetry/data mutations are refused, ledger writes
                         are refused on gateway platforms unless opted in.
epoch_estimate tool   -> agent-callable Monte Carlo estimate.
epoch_show tool       -> ask the enabled Desktop page to show a chart and optional card.

Design notes (see README "How it works"):

* Run bindings, not comments. ``kanban_task_claimed`` fires in the dispatcher's profile and
  ``kanban_task_completed`` in the assignee's profile; ``ctx.state`` is profile-scoped, so the
  authoritative estimate ↔ run association lives in a shared bindings file under
  ``epoch_data_dir`` (same directory Epoch's ledger uses). Kanban comments still carry
  ``[epoch:estimate …]`` / ``[epoch:actual …]`` markers for humans, but they are display/audit
  only — forged or quoted markers never redirect or suppress recording. Comment delivery is
  tracked separately from estimate/actual ledger state so a transient board failure retries the
  missing comment without re-recording. Delivery itself is claimed under the same bindings flock
  (pid/tid + expiry) so concurrent success/duplicate recorders and concurrent claimed_job racers
  cannot double-post; a BoardError releases the claim for retry, and a contested live claim
  raises so the outbox keeps the job pending. Either side can reconcile, in
  either event order, and Epoch's ledger rejects duplicate actuals.
* The Epoch child gets a scrubbed environment (allow-listed PATH/HOME/locale/Node/npm/proxy
  vars only), ``EPOCH_DATA_DIR`` pinned to the ledger dir and ``EPOCH_TELEMETRY=0``. The ledger
  defaults to ``<HERMES_HOME root>/plugin-data/epoch`` so every profile shares it.
* Board access goes through the public ``ctx.dispatch_tool`` surface (``kanban_show`` /
  ``kanban_comment``); Desktop updates use the optional public plugin event bridge.
* Background work runs on a thread started under ``contextvars.copy_context()`` so the event's
  profile (HERMES_HOME override, settings, plugin state) follows the job. Settings are also
  snapshotted in the hook's own context.
* Lifecycle: every job is written to a profile-scoped outbox before it starts and removed when it
  reaches a terminal state. Outbox read-modify-write holds a cross-process lock on the plugin
  state file (same lockfile convention as Hermes PluginState) so concurrent processes cannot
  lose an enqueue or double-claim a lease. At interpreter exit the plugin waits (bounded by
  ``shutdown_wait_seconds``) for in-flight jobs; anything still unfinished (or killed by
  ``os._exit``) is replayed the next time the plugin loads in that profile.

Every path is best-effort and never raises into Hermes.
"""

from __future__ import annotations

import atexit
import contextvars
import json
import logging
import math
import os
import random
import re
import shlex
import subprocess
import threading
import time
import tempfile
from contextlib import contextmanager, suppress
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

PANE_VIEWS = ("bars", "cdf", "dots")
_ITEM_ID_RE = re.compile(r"[A-Za-z0-9_.:-]{1,80}")
PANE_SETUP = ("Check that Epoch is on in Desktop Capabilities -> Plugins; enabling the pane is "
              "the one step a person does, then the agent can open it with epoch_show.")


def _valid_view(payload: Any) -> bool:
    return (isinstance(payload, dict) and set(payload) <= {"view", "item_id"}
            and isinstance(payload.get("view"), str) and payload["view"] in PANE_VIEWS
            and ("item_id" not in payload or (isinstance(payload["item_id"], str)
                 and _ITEM_ID_RE.fullmatch(payload["item_id"]) is not None)))


def _broadcast_pane_event(event: str, payload: Dict[str, Any]) -> bool:
    """Only invalidation or bounded view state may cross the local Desktop bridge."""
    if not ((event == "data.updated" and isinstance(payload, dict) and not payload)
            or (event == "view.set" and _valid_view(payload))):
        return False
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
    except ImportError:
        return False
    try:
        broadcast_plugin_event("epoch", event, payload)
        return True  # Sent, not proof of a listening Desktop client.
    except (Exception, SystemExit):
        # A bridge importing an unavailable gateway runtime must not end the tool process.
        logger.debug("epoch: Desktop event was not delivered", exc_info=True)
        return False


DEFAULTS: Dict[str, Any] = {
    "epoch_command": "npx -y @kyanitelabs/epoch@0.8.0",
    "epoch_data_dir": "",
    "comment_on_claim": True,
    "record_actuals": True,
    "iterations": 5000,
    "timeout_seconds": 60,
    "shutdown_wait_seconds": 20,
    "allow_write_slash_on_gateway": False,
}

# Hours bounds for a three-point estimate (explicit or hint). 2000h ≈ one person-year.
MAX_ESTIMATE_HOURS = 2000.0
WORKDAY_HOURS = 8.0
OUTBOX_KEY = "outbox"
OUTBOX_MAX_ATTEMPTS = 5
# Unfinished jobs are retried at load and, at most this often, when a run completes.
OUTBOX_REPLAY_INTERVAL_SECONDS = 600
OUTBOX_MAX_AGE_SECONDS = 7 * 24 * 3600
# Missed-completion reconcile: at most this many unrecorded bindings are checked per pass, and a
# pass runs at most once per interval (at load, then on claims and dispatcher ticks).
RECONCILE_PER_PASS = 25
RECONCILE_INTERVAL_SECONDS = 600
AUTO_WALLCLOCK = "auto_wallclock"
BINDINGS_FILE = "hermes-run-bindings.json"

_NUM = r"[-+]?(?:\d+(?:\.\d+)?|\.\d+)"
# Units a hint may carry: hours (default), minutes, workdays, workweeks.
_UNIT = r"(h|hrs?|hours?|m|mins?|minutes?|d|days?|w|wks?|weeks?)"
# Capture the number triple before validating its first following word. Unsupported units must
# not fall through the optional-unit parser and become hours.
_HINT_TRIPLE_RE = re.compile(
    rf"^(?:{_NUM}\s*[/,]\s*{_NUM}\s*[/,]\s*{_NUM}|"
    r"\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_HINT_QUALIFIERS = frozenset({
    "roughly", "rough", "approx", "approximately", "maybe", "about", "around", "ish",
})
# Strict form: "epoch: 2/4/10", "estimate: 2-4-10 h", "epoch: 1,2,3 days".
_HINT_STRICT_RE = re.compile(
    rf"^({_NUM})\s*[/,]\s*({_NUM})\s*[/,]\s*({_NUM})\s*{_UNIT}?\s*(?:$|[\s.,;!?)]|\])",
    re.IGNORECASE,
)
_HINT_DASH_RE = re.compile(  # dash separators only for unsigned numbers ("2-4-10h")
    r"^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*" + _UNIT + r"?\s*(?:$|[\s.,;!?)]|\])",
    re.IGNORECASE,
)
# Anything that *looks* like a hint attempt: "epoch:" / "estimate:" followed by a number-ish token.
_HINT_ATTEMPT_RE = re.compile(r"\b(?:epoch|estimate)\s*:\s*([-+.]?\d[^\n]*)", re.IGNORECASE)
_MARKER_RE = re.compile(r"\[epoch:(estimate|actual)((?:\s+[a-z_]+=[^\s\]]+)*)\s*\]")

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
_inflight: Dict[str, threading.Thread] = {}
_inflight_lock = threading.Lock()
_outbox_lock = threading.Lock()
_atexit_registered = False


class EstimateInputError(ValueError):
    """A three-point estimate (explicit or textual) failed validation."""


class BoardError(RuntimeError):
    """A kanban tool call through ``ctx.dispatch_tool`` returned an error."""


# --------------------------------------------------------------------------- settings


def _cfg(key: str, settings: Optional[Dict[str, Any]] = None) -> Any:
    if settings is not None and key in settings:
        return settings[key]
    try:
        val = _ctx.get_config(key, None) if _ctx is not None else None
    except Exception:
        val = None
    return DEFAULTS[key] if val is None else val


def snapshot_settings() -> Dict[str, Any]:
    """Resolve every setting in the *current* context (the hook's profile)."""
    return {k: _cfg(k) for k in DEFAULTS}


# --------------------------------------------------------------------------- Epoch CLI

# Only what ``npx``/Node need to resolve, download (proxy/cache) and run Epoch. The parent
# environment (API keys, tokens, Hermes secrets) is never handed to the child.
_ENV_ALLOW = (
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA",
    "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
    "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NVM_DIR", "NVM_BIN", "VOLTA_HOME", "FNM_DIR",
    "npm_config_cache", "NPM_CONFIG_CACHE", "npm_config_registry", "NPM_CONFIG_REGISTRY",
    "npm_config_prefix", "NPM_CONFIG_PREFIX", "npm_config_userconfig", "NPM_CONFIG_USERCONFIG",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
)


def _scrubbed_env(settings: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Minimal env for the Epoch child — never the full ``os.environ``.

    Pins ``EPOCH_DATA_DIR`` to the resolved ledger dir and forces Epoch telemetry off for every
    plugin-driven run (``EPOCH_TELEMETRY=0`` overrides any ``epoch telemetry enable``).
    """
    env = {k: os.environ[k] for k in _ENV_ALLOW if os.environ.get(k)}
    data_dir = _epoch_data_dir(settings)
    data_dir.mkdir(parents=True, exist_ok=True)
    env["EPOCH_DATA_DIR"] = str(data_dir)
    env["EPOCH_TELEMETRY"] = "0"
    env["NO_COLOR"] = "1"
    env["NO_UPDATE_NOTIFIER"] = "1"
    env["npm_config_update_notifier"] = "false"
    env["npm_config_fund"] = "false"
    return env



def _error_text(res: Dict[str, Any]) -> str:
    err = res.get("error")
    if isinstance(err, dict):
        text = str(err.get("message") or err)
    else:
        text = str(err) if err is not None else "unknown error"
    return _redact_home(text)


def run_epoch(args: List[str], settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Run the Epoch CLI and return its parsed ``{ok, data|error}`` envelope.

    Never raises: timeouts, missing binaries, non-zero exits and unparseable output all come back
    as ``{"ok": False, "error": "..."}``.
    """
    try:
        cmd = shlex.split(str(_cfg("epoch_command", settings))) + [str(a) for a in args]
    except ValueError as exc:
        return {"ok": False, "error": f"invalid epoch_command: {exc}"}
    try:
        env = _scrubbed_env(settings)
    except OSError as exc:
        return {"ok": False, "error": f"epoch data dir unavailable: {exc}"}
    try:
        timeout = float(_cfg("timeout_seconds", settings))
    except (TypeError, ValueError):
        timeout = float(DEFAULTS["timeout_seconds"])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except (FileNotFoundError, PermissionError) as exc:
        return {"ok": False, "error": f"epoch not runnable: {exc}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"epoch timed out after {timeout:g}s"}
    except OSError as exc:
        return {"ok": False, "error": f"epoch failed to start: {exc}"}
    out = (proc.stdout or "").strip()
    start = out.find("{")
    parsed: Any = None
    if start >= 0:
        try:
            parsed = json.loads(out[start:])
        except json.JSONDecodeError:
            parsed = None
    tail = _redact_home((proc.stderr or "").strip()[-500:] or out[-500:])
    if isinstance(parsed, dict) and "ok" in parsed:
        # A non-zero exit is a failure even when stdout carries an ``ok: true`` envelope; keep
        # the structured payload for diagnosis but never report the call as successful.
        if proc.returncode != 0 and parsed.get("ok"):
            failed = dict(parsed)
            failed["ok"] = False
            failed["error"] = f"epoch exited {proc.returncode} despite an ok envelope: {tail}"
            return failed
        return parsed
    if proc.returncode != 0:
        return {"ok": False, "error": f"epoch exited {proc.returncode}: {tail}"}
    return {"ok": False, "error": f"epoch returned no JSON envelope: {tail}"}


# --------------------------------------------------------------------------- estimates


def validate_triple(o: Any, m: Any, p: Any, *, source: str = "estimate") -> Tuple[float, float, float]:
    """Return a validated (optimistic, most_likely, pessimistic) triple in hours."""
    vals = []
    for name, v in (("optimistic", o), ("most_likely", m), ("pessimistic", p)):
        if isinstance(v, bool):
            raise EstimateInputError(f"{source}: {name} must be a number, got {v!r}")
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise EstimateInputError(f"{source}: {name} must be a number, got {v!r}") from None
        if not math.isfinite(f):
            raise EstimateInputError(f"{source}: {name} must be finite, got {v!r}")
        if f <= 0:
            raise EstimateInputError(f"{source}: {name} must be > 0 hours, got {f:g}")
        if f > MAX_ESTIMATE_HOURS:
            raise EstimateInputError(f"{source}: {name} {f:g}h exceeds the {MAX_ESTIMATE_HOURS:g}h bound")
        vals.append(f)
    if not (vals[0] <= vals[1] <= vals[2]):
        raise EstimateInputError(
            f"{source}: need optimistic <= most_likely <= pessimistic, got "
            f"{vals[0]:g}/{vals[1]:g}/{vals[2]:g}")
    return vals[0], vals[1], vals[2]


def parse_hint(text: str) -> Optional[Dict[str, float]]:
    """Parse the first ``epoch:``/``estimate:`` hint in *text* (hours).

    Returns ``None`` when there is no hint attempt; raises :class:`EstimateInputError` when there is
    one but it is malformed or out of bounds (callers surface that visibly).
    """
    m = _HINT_ATTEMPT_RE.search(text or "")
    if not m:
        return None
    raw = m.group(1).strip()
    numbers = _HINT_TRIPLE_RE.match(raw)
    if numbers:
        rest = raw[numbers.end():]
        unit = re.match(r"\s*([^\W\d_][\w-]*)", rest)
        explicit = (unit is not None and unit.group(1) != "M"
                    and re.fullmatch(_UNIT, unit.group(1), re.IGNORECASE) is not None)
        if not explicit:
            # Allow-list: a unitless triple may be followed only by qualifiers and punctuation, so
            # "2/4/10, sprints" or "2/4/10 (months)" can never be read as hours.
            for word in re.findall(r"[^\W\d_][\w'-]*", rest):
                if word.lower() not in _HINT_QUALIFIERS:
                    raise EstimateInputError(
                        f"hint {m.group(0).strip()[:60]!r} uses unit {word!r}; use h, min, d or w "
                        "(e.g. 'epoch: 2/4/10h')")
    sm = _HINT_STRICT_RE.match(raw) or _HINT_DASH_RE.match(raw)
    if not sm:
        raise EstimateInputError(f"malformed hint {m.group(0).strip()[:60]!r} (expected e.g. 'epoch: 2/4/10h')")
    unit = (sm.group(4) or "h").lower()
    scale = {"m": 1 / 60, "d": WORKDAY_HOURS, "w": 5 * WORKDAY_HOURS}.get(unit[0], 1.0)
    try:
        o, ml, p = (float(x) * scale for x in sm.groups()[:3])
    except ValueError:
        raise EstimateInputError(f"malformed hint {m.group(0).strip()[:60]!r}") from None
    o, ml, p = validate_triple(o, ml, p, source=f"hint {m.group(0).strip()[:60]!r}")
    return {"optimistic": o, "most_likely": ml, "pessimistic": p}


def find_hint(title: str, body: str) -> Tuple[Optional[Dict[str, float]], Optional[str]]:
    """(hint, problem). Title is checked first, then body; the first hint attempt wins."""
    for text in (title or "", body or ""):
        try:
            hint = parse_hint(text)
        except EstimateInputError as exc:
            return None, str(exc)
        if hint is not None:
            return hint, None
    return None, None


def guess_type(text: str) -> str:
    low = (text or "").lower()
    for ttype, words in _TYPE_WORDS.items():
        if any(re.search(rf"\b{w}\b", low) for w in words):
            return ttype
    return "feature"


def _fmt_estimate_hours(hours: float) -> str:
    """``1.5h`` from one hour up; whole minutes below it, so a 10-minute task never reads 0.0h."""
    if hours < 1:
        return f"{max(1, round(hours * 60))}m"
    return f"{hours:.1f}h"


def _monte_carlo(title: str, triple: Dict[str, float], source: str,
                 settings: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    # Epoch monte_carlo_schedule works in days (8h workday); the triple is in hours.
    task = {"name": (title or "task")[:80], **{k: round(v / WORKDAY_HOURS, 6) for k, v in triple.items()}}
    iterations = int(_cfg("iterations", settings))
    res = run_epoch(["monte-carlo-schedule", "--tasks", json.dumps([task]),
                     "--iterations", str(iterations)], settings)
    if not res.get("ok") or not isinstance(res.get("data"), dict):
        return {"summary": f"⏱ Epoch estimate failed: {_error_text(res)}", "raw": res, "method": None}
    d = res["data"]

    def h(k: str) -> str:
        try:
            return _fmt_estimate_hours(float(d[k]) * WORKDAY_HOURS)
        except (KeyError, TypeError, ValueError):
            return "n/a"

    p90 = h("p90") if d.get("p90") is not None else "n/a (Epoch < 0.7)"
    summary = (f"⏱ Epoch estimate — P50 {h('p50')} · P90 {p90} "
               f"(P80 {h('p80')} · P95 {h('p95')}; Monte Carlo, {iterations} runs, from {source} "
               f"{triple['optimistic']:g}/{triple['most_likely']:g}/{triple['pessimistic']:g}h)")
    return {"summary": summary, "feedbackRef": d.get("feedbackRef"), "method": "monte_carlo",
            "triple": triple, "raw": d}


def estimate(title: str, body: str = "", *, explicit: Optional[Dict[str, Any]] = None,
             settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return ``{'summary', 'feedbackRef', 'method', ...}`` for a task.

    Precedence: a validated *explicit* triple (structured values, never re-parsed from text) >
    the first hint in title, then body > reference-class forecast. A malformed hint does not
    silently vanish: the fallback summary names the problem (``hint_error``).
    """
    if explicit is not None:
        o, m, p = validate_triple(explicit.get("optimistic"), explicit.get("most_likely"),
                                  explicit.get("pessimistic"), source="explicit estimate")
        return _monte_carlo(title, {"optimistic": o, "most_likely": m, "pessimistic": p},
                            "explicit", settings)
    hint, problem = find_hint(title, body)
    if hint:
        return _monte_carlo(title, hint, "hint", settings)
    ttype = guess_type(f"{title} {body}")
    res = run_epoch(["reference-class-estimate", "--task-type", ttype, "--complexity", "3"], settings)
    note = f" Ignored {problem}." if problem else ""
    if not res.get("ok") or not isinstance(res.get("data"), dict):
        return {"summary": f"⏱ Epoch estimate failed: {_error_text(res)}.{note}", "raw": res,
                "method": None, "hint_error": problem}
    d = res["data"]
    summary = (f"⏱ Epoch estimate — ~{d.get('correctedEstimate')}h ({ttype}, reference class; "
               f"confidence {d.get('confidence')}).{note} Add `epoch: o/m/p` hours to the task body "
               f"for a P50/P90 range.")
    return {"summary": summary, "feedbackRef": d.get("feedbackRef"), "method": "reference_class",
            "raw": d, "hint_error": problem}


# --------------------------------------------------------------------------- board (public tools)


def _load_tool_json(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise BoardError(f"unparseable tool result: {str(raw)[:200]}") from None
    if not isinstance(data, dict):
        raise BoardError(f"unexpected tool result: {str(raw)[:200]}")
    return data


def _kanban(tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Call a Hermes kanban tool through the public ``ctx.dispatch_tool`` surface."""
    if _ctx is None:
        raise BoardError("plugin not registered")
    data = _load_tool_json(_ctx.dispatch_tool(tool, args))
    if "error" in data and str(data["error"]).startswith("Unknown tool"):
        # One-shot CLI processes may not have discovered the built-in tools yet; the public
        # ``tools.registry.discover_builtin_tools`` registers them (kanban_* included).
        try:
            from tools.registry import discover_builtin_tools
            discover_builtin_tools()
        except Exception as exc:  # pragma: no cover - depends on host install
            raise BoardError(f"{tool} unavailable: {exc}") from None
        data = _load_tool_json(_ctx.dispatch_tool(tool, args))
    if "error" in data:
        raise BoardError(f"{tool}: {data['error']}")
    return data


def _board_args(task_id: str, board: Optional[str], **extra: Any) -> Dict[str, Any]:
    args: Dict[str, Any] = {"task_id": task_id, **extra}
    if board:
        args["board"] = board
    return args


def show_task(task_id: str, board: Optional[str]) -> Dict[str, Any]:
    return _kanban("kanban_show", _board_args(task_id, board))


def add_comment(task_id: str, board: Optional[str], body: str) -> None:
    _kanban("kanban_comment", _board_args(task_id, board, body=body))


def format_marker(kind: str, **fields: Any) -> str:
    parts = " ".join(f"{k}={str(v).replace(' ', '_').replace(']', '')}" for k, v in fields.items()
                     if v is not None)
    return f"[epoch:{kind} {parts}]"


def parse_markers(comments: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for c in comments or []:
        for m in _MARKER_RE.finditer(str((c or {}).get("body") or "")):
            fields = dict(kv.split("=", 1) for kv in m.group(2).split())
            fields["kind"] = m.group(1)
            out.append(fields)
    return out


def _run_for(shown: Dict[str, Any], run_id: Any) -> Optional[Dict[str, Any]]:
    for r in shown.get("runs") or []:
        if str(r.get("id")) == str(run_id):
            return r
    return None


def _run_completed(run: Optional[Dict[str, Any]]) -> bool:
    return bool(run and run.get("outcome") == "completed" and run.get("started_at") is not None
                and run.get("ended_at") is not None)


def _claim_is_live(shown: Dict[str, Any], run_id: Any) -> bool:
    """The claim for *run_id* still owns the task, or that run already completed."""
    task = shown.get("task") or {}
    if str(task.get("current_run_id")) == str(run_id):
        return True
    return _run_completed(_run_for(shown, run_id))



# --------------------------------------------------------------------------- shared bindings + locks


PLUGIN_NAME = "epoch"


def _hermes_root() -> Path:
    """Root Hermes home (``<root>`` even when a profile sets ``HERMES_HOME=<root>/profiles/<n>``).

    Root, not profile: the claim hook fires in the dispatcher's profile and the completion hook in
    the worker's, so the ledger + run bindings must be one directory both resolve.
    """
    try:
        from hermes_constants import get_default_hermes_root
        return Path(get_default_hermes_root())
    except Exception:
        raw = (os.environ.get("HERMES_HOME") or "").strip()
        if not raw:
            return Path.home() / ".hermes"
        home = Path(os.path.expanduser(raw))
        return home.parent.parent if home.parent.name == "profiles" else home


def _epoch_data_dir(settings: Optional[Dict[str, Any]] = None) -> Path:
    """Ledger + bindings dir: ``epoch_data_dir`` > ``EPOCH_DATA_DIR`` > ``<HERMES_HOME>/plugin-data/epoch``."""
    configured = str(_cfg("epoch_data_dir", settings) or "").strip()
    if configured:
        return Path(os.path.expanduser(configured))
    env_dir = (os.environ.get("EPOCH_DATA_DIR") or "").strip()
    if env_dir:
        return Path(os.path.expanduser(env_dir))
    return _hermes_root() / "plugin-data" / PLUGIN_NAME


def _binding_key(task_id: str, board: Optional[str], run_id: Any) -> str:
    return f"{board or '-'}:{task_id}:{run_id}"


@contextmanager
def _file_lock(path: Path):
    """Exclusive cross-process lock via a sibling ``.<name>.lock`` (Hermes PluginState convention)."""
    lock_path = path.with_name(f".{path.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as handle:
        if os.name == "nt":  # pragma: no cover - Windows
            import msvcrt
            if handle.seek(0, os.SEEK_END) == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _read_json_file(path: Path) -> Dict[str, Any]:
    """Load a JSON object. Only a missing file means empty.

    Matches Hermes PluginState fail-closed semantics: utf-8-sig (BOM-safe), reject malformed or
    non-object roots, and never coerce read/parse errors into ``{}`` (callers must not overwrite
    a corrupt store with a fresh empty one).
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"Cannot parse epoch state {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"Cannot parse epoch state {path}: root must be an object")
    return data


def _write_json_file(path: Path, data: Dict[str, Any]) -> None:
    """Atomically write *data* with mode 0600 (private temps; umask must not widen access)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.stem}_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            if hasattr(os, "fchmod"):
                os.fchmod(handle.fileno(), 0o600)
            handle.write(json.dumps(data, ensure_ascii=False, indent=2))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
        with suppress(OSError):
            os.chmod(path, 0o600)
    except BaseException:
        with suppress(OSError):
            os.unlink(tmp_name)
        raise


def _bindings_update(settings: Optional[Dict[str, Any]], fn: Callable[[Dict[str, Any]], None]) -> None:
    path = _epoch_data_dir(settings) / BINDINGS_FILE
    with _file_lock(path):
        data = _read_json_file(path)
        fn(data)
        _prune_finished_bindings(data)
        _write_json_file(path, data)


# Bindings with nothing left to do are dropped this long after they were created, so the file
# does not grow by one entry per run forever.
BINDING_RETENTION_SECONDS = 30 * 24 * 3600


def _binding_finished(binding: Dict[str, Any]) -> bool:
    """The ledger side is settled and no audit comment is still waiting to be posted."""
    settled = ledger_outcome(binding) is not None or bool(binding.get("run_ended"))
    return settled and all(
        delivery_state(binding, kind) in (Delivery.NONE, Delivery.DELIVERED) for kind in CommentKind)


def _prune_finished_bindings(data: Dict[str, Any], now: Optional[float] = None) -> None:
    now = time.time() if now is None else now
    for key, binding in list(data.items()):
        if not isinstance(binding, dict):
            continue
        created = binding.get("created_at")
        if not isinstance(created, (int, float)):
            # Written before bindings were timestamped: start its clock now.
            data[key] = dict(binding, created_at=now)
            continue
        if now - created > BINDING_RETENTION_SECONDS and _binding_finished(binding):
            del data[key]


def _binding_get(settings: Optional[Dict[str, Any]], task_id: str, board: Optional[str],
                 run_id: Any) -> Optional[Dict[str, Any]]:
    path = _epoch_data_dir(settings) / BINDINGS_FILE
    with _file_lock(path):
        raw = _read_json_file(path).get(_binding_key(task_id, board, run_id))
    return dict(raw) if isinstance(raw, dict) else None


# --------------------------------------------------------------------------- run-binding state
#
# One run binding (``hermes-run-bindings.json`` → ``"<board>:<task>:<run>"``) carries two
# independent state machines, plus a ``created_at`` timestamp used only to prune finished
# bindings. These names are the only place the stages are spelled out, and every write goes
# through one transition below.
#
# 1. Ledger outcome (keys ``recorded`` + ``status``):
#
#        UNRECORDED ──record(recorded)──▶ RECORDED
#            │ ├──────record(duplicate)─▶ DUPLICATE      (terminal; a *different* terminal
#            │ └──────record(rejected)──▶ REJECTED        outcome is refused, the same one is
#                                                         idempotent; keep_existing defers to
#                                                         whatever the first recorder stored)
#
# 2. Comment delivery, once per kind ∈ {estimate, actual}
#    (keys ``<kind>_comment_body`` / ``<kind>_delivery_in_flight`` / ``<kind>_commented``):
#
#        NONE ──set body──▶ PENDING ──claim──▶ IN_FLIGHT ──complete──▶ DELIVERED (terminal)
#                             ▲                   │
#                             └──release/expiry───┘
#
#    NONE (no body yet) and DELIVERED both read as "terminal" to a deliverer: nothing to post.


class LedgerOutcome(str, Enum):
    """Terminal Epoch-ledger outcome of a run's wall-clock actual (persisted as ``status``)."""

    RECORDED = "recorded"
    DUPLICATE = "duplicate"
    REJECTED = "rejected"


class CommentKind(str, Enum):
    ESTIMATE = "estimate"
    ACTUAL = "actual"


class Delivery(str, Enum):
    """Derived audit-comment delivery stage for one :class:`CommentKind` (never persisted)."""

    NONE = "none"
    PENDING = "pending"
    IN_FLIGHT = "in_flight"
    DELIVERED = "delivered"


class IllegalBindingTransition(RuntimeError):
    """A write that would move a run binding along an edge the diagram above does not have."""


def _kind(kind: Any) -> CommentKind:
    try:
        return CommentKind(kind)
    except ValueError:
        raise IllegalBindingTransition(f"unknown comment kind {kind!r}") from None


def _body_key(kind: CommentKind) -> str:
    return f"{kind.value}_comment_body"


def _claim_key(kind: CommentKind) -> str:
    return f"{kind.value}_delivery_in_flight"


def _commented_key(kind: CommentKind) -> str:
    return f"{kind.value}_commented"


def ledger_outcome(binding: Optional[Dict[str, Any]]) -> Optional[LedgerOutcome]:
    """``None`` while UNRECORDED. Tolerant of legacy rows: ``recorded`` without a (known)
    ``status`` reads as RECORDED, since ``recorded`` has always been the authority."""
    if not binding or not binding.get("recorded"):
        return None
    try:
        return LedgerOutcome(binding.get("status"))
    except ValueError:
        return LedgerOutcome.RECORDED


def delivery_state(binding: Optional[Dict[str, Any]], kind: Any) -> Delivery:
    k = _kind(kind)
    if not binding:
        return Delivery.NONE
    if binding.get(_commented_key(k)):
        return Delivery.DELIVERED
    if not binding.get(_body_key(k)):
        return Delivery.NONE
    claim = binding.get(_claim_key(k))
    if claim and not _delivery_claim_expired(claim):
        return Delivery.IN_FLIGHT
    return Delivery.PENDING


def _binding_put_ref(settings: Optional[Dict[str, Any]], task_id: str, board: Optional[str],
                     run_id: Any, ref: str, *,
                     estimate_comment_body: Optional[str] = None) -> None:
    """Persist the estimate↔run binding. Comment delivery is tracked separately."""
    key = _binding_key(task_id, board, run_id)

    def mutate(data: Dict[str, Any]) -> None:
        cur = data.get(key) if isinstance(data.get(key), dict) else {}
        if cur.get("ref"):
            # First writer wins on ref; still attach a pending comment body if a crash left none
            # (estimate delivery NONE → PENDING).
            if estimate_comment_body and not cur.get("estimate_comment_body"):
                cur = dict(cur)
                cur["estimate_comment_body"] = estimate_comment_body
                if "estimate_commented" not in cur:
                    cur["estimate_commented"] = False
                data[key] = cur
            return
        data[key] = {
            "ref": ref,
            "recorded": False,
            "estimate_commented": False,
            "actual_commented": False,
            "estimate_comment_body": estimate_comment_body,
            "created_at": time.time(),
        }

    _bindings_update(settings, mutate)

    _broadcast_pane_event("data.updated", {})


def _transition_mark_commented(cur: Dict[str, Any], kind: CommentKind) -> Dict[str, Any]:
    """PENDING | IN_FLIGHT → DELIVERED (DELIVERED → DELIVERED is a no-op). NONE is refused:
    there is no body, so nothing can have been posted."""
    if delivery_state(cur, kind) is Delivery.NONE:
        raise IllegalBindingTransition(f"{kind.value} comment marked delivered with no body")
    cur = dict(cur)
    cur[_commented_key(kind)] = True
    cur.pop(_claim_key(kind), None)
    return cur


def _binding_mark_commented(settings: Optional[Dict[str, Any]], task_id: str,
                            board: Optional[str], run_id: Any, kind: Any) -> None:
    k = _kind(kind)
    key = _binding_key(task_id, board, run_id)

    def mutate(data: Dict[str, Any]) -> None:
        cur = data.get(key) if isinstance(data.get(key), dict) else None
        if not cur:
            return
        data[key] = _transition_mark_commented(cur, k)

    _bindings_update(settings, mutate)


def _binding_mark_estimate_commented(settings: Optional[Dict[str, Any]], task_id: str,
                                     board: Optional[str], run_id: Any) -> None:
    _binding_mark_commented(settings, task_id, board, run_id, CommentKind.ESTIMATE)


def _binding_mark_actual_commented(settings: Optional[Dict[str, Any]], task_id: str,
                                   board: Optional[str], run_id: Any) -> None:
    _binding_mark_commented(settings, task_id, board, run_id, CommentKind.ACTUAL)


def _transition_record(cur: Dict[str, Any], outcome: LedgerOutcome,
                       actual_comment_body: Optional[str], keep_existing: bool) -> Dict[str, Any]:
    """UNRECORDED → outcome. Already terminal: ``keep_existing`` keeps the stored outcome/body
    (the duplicate path defers to whoever appended); otherwise only the same outcome is
    accepted (idempotent re-mark) and a different one is refused."""
    prior = ledger_outcome(cur)
    # DUPLICATE → RECORDED is the one upgrade allowed. Two recorders race: the loser can see
    # Epoch's ``duplicate`` rejection and mark the binding before the winner, whose append is
    # what actually landed, gets to mark it. The winner's outcome is the truth, so it replaces
    # the loser's status and pending notice.
    upgrade = prior is LedgerOutcome.DUPLICATE and outcome is LedgerOutcome.RECORDED
    if prior is not None and not keep_existing and prior is not outcome and not upgrade:
        raise IllegalBindingTransition(
            f"ledger outcome already {prior.value}; refusing to overwrite with {outcome.value}")
    cur = dict(cur)
    cur["recorded"] = True
    if not (keep_existing and prior is not None and cur.get("status")):
        cur["status"] = outcome.value
    if actual_comment_body is not None and not (keep_existing and cur.get("actual_comment_body")):
        cur["actual_comment_body"] = actual_comment_body
    cur.setdefault("actual_commented", False)
    return cur


def _binding_mark_recorded(settings: Optional[Dict[str, Any]], task_id: str, board: Optional[str],
                           run_id: Any, *, status: Any,
                           actual_comment_body: Optional[str] = None,
                           keep_existing: bool = False) -> None:
    """Mark the Epoch ledger outcome. Does not imply the audit comment was delivered.

    With ``keep_existing`` (duplicate path) a status/body already stored by the recorder that
    actually appended to the ledger wins; only a missing body is filled in.
    """
    try:
        outcome = LedgerOutcome(status)
    except ValueError:
        raise IllegalBindingTransition(f"unknown ledger outcome {status!r}") from None
    key = _binding_key(task_id, board, run_id)

    def mutate(data: Dict[str, Any]) -> None:
        cur = data.get(key) if isinstance(data.get(key), dict) else None
        if not cur:
            return
        data[key] = _transition_record(cur, outcome, actual_comment_body, keep_existing)

    _bindings_update(settings, mutate)

    _broadcast_pane_event("data.updated", {})


def _delivery_claim_expired(claim: Any) -> bool:
    if not isinstance(claim, dict):
        return True
    try:
        until = float(claim.get("until") or 0)
    except (TypeError, ValueError):
        return True
    if until <= time.time():
        return True
    # Dead owner → reclaimable even if until is still in the future.
    return not _pid_alive(claim.get("pid"))


# Delivery-claim outcomes. Contested must not be treated as terminal success by callers.
_DELIVERY_CLAIMED = "claimed"
_DELIVERY_TERMINAL = "terminal"
_DELIVERY_CONTESTED = "contested"


def _claim_comment_delivery(settings: Optional[Dict[str, Any]], task_id: str,
                            board: Optional[str], run_id: Any, *, kind: Any
                            ) -> Tuple[Optional[str], str]:
    """Atomically claim the right to post the pending *kind* comment under the bindings flock.

    PENDING → IN_FLIGHT (or a re-claim of our own IN_FLIGHT). Returns ``(body, "claimed")`` on
    success, ``(None, "terminal")`` when NONE/DELIVERED, or ``(None, "contested")`` when another
    live claim still holds the slot. Callers must not treat contested as success — raise (or
    otherwise leave the outbox job pending) so a peer can retry after the lease expires or is
    released. A BoardError after claiming must call :func:`_release_comment_delivery`.
    """
    k = _kind(kind)
    key = _binding_key(task_id, board, run_id)
    result: Dict[str, Any] = {"body": None, "status": _DELIVERY_TERMINAL}
    now = time.time()
    claim = {
        "pid": os.getpid(),
        "tid": threading.get_ident(),
        "until": now + max(30.0, _lease_seconds(settings)),
    }

    def mutate(data: Dict[str, Any]) -> None:
        cur = data.get(key) if isinstance(data.get(key), dict) else None
        state = delivery_state(cur, k)
        if state in (Delivery.NONE, Delivery.DELIVERED):
            result["status"] = _DELIVERY_TERMINAL
            return
        if state is Delivery.IN_FLIGHT:
            existing = cur.get(_claim_key(k))
            same = (isinstance(existing, dict)
                    and existing.get("pid") == claim["pid"]
                    and existing.get("tid") == claim["tid"])
            if not same:
                result["status"] = _DELIVERY_CONTESTED
                return
        cur = dict(cur)
        cur[_claim_key(k)] = claim
        data[key] = cur
        result["body"] = str(cur.get(_body_key(k)))
        result["status"] = _DELIVERY_CLAIMED

    _bindings_update(settings, mutate)
    return result["body"], result["status"]


def _release_comment_delivery(settings: Optional[Dict[str, Any]], task_id: str,
                              board: Optional[str], run_id: Any, *, kind: Any) -> None:
    """IN_FLIGHT → PENDING: drop our (or an expired) claim (BoardError / crash-recovery path)."""
    k = _kind(kind)
    key = _binding_key(task_id, board, run_id)
    me = (os.getpid(), threading.get_ident())

    def mutate(data: Dict[str, Any]) -> None:
        cur = data.get(key) if isinstance(data.get(key), dict) else None
        if not cur:
            return
        existing = cur.get(_claim_key(k))
        if not isinstance(existing, dict):
            return
        if (existing.get("pid"), existing.get("tid")) != me and not _delivery_claim_expired(existing):
            return
        cur = dict(cur)
        cur.pop(_claim_key(k), None)
        data[key] = cur

    _bindings_update(settings, mutate)


def _complete_comment_delivery(settings: Optional[Dict[str, Any]], task_id: str,
                               board: Optional[str], run_id: Any, *, kind: Any) -> None:
    """Mark *kind* comment delivered and clear any in-flight claim.

    Dispatches through the per-kind module names so tests (and crash simulations) can patch them.
    """
    if _kind(kind) is CommentKind.ESTIMATE:
        _binding_mark_estimate_commented(settings, task_id, board, run_id)
    else:
        _binding_mark_actual_commented(settings, task_id, board, run_id)


def _deliver_comment(task_id: str, board: Optional[str], run_id: Any,
                     binding: Dict[str, Any], settings: Optional[Dict[str, Any]],
                     kind: CommentKind) -> Tuple[bool, Dict[str, Any]]:
    """Drive *kind* delivery to a terminal stage. Returns ``(posted_now, last_seen_binding)``.

    Delivery is claimed under the bindings flock so concurrent racers cannot double-post. A
    BoardError releases the claim for retry. Contested (another live claim) raises after a brief
    spin so the outbox leaves the job pending — never treat a held lease as terminal success.
    """
    if binding.get(_commented_key(kind)):
        return False, binding
    deadline = time.time() + 2.0
    while True:
        fresh = _binding_get(settings, task_id, board, run_id) or binding
        if delivery_state(fresh, kind) in (Delivery.NONE, Delivery.DELIVERED):
            return False, fresh
        body, status = _claim_comment_delivery(settings, task_id, board, run_id, kind=kind)
        if status == _DELIVERY_CLAIMED and body is not None:
            try:
                add_comment(task_id, board, body)
            except Exception:
                _release_comment_delivery(settings, task_id, board, run_id, kind=kind)
                raise
            _complete_comment_delivery(settings, task_id, board, run_id, kind=kind)
            return True, fresh
        if status == _DELIVERY_TERMINAL:
            return False, fresh
        if time.time() >= deadline:
            # Still contested after wait — leave non-terminal so the outbox retries.
            raise RuntimeError(f"{kind.value} comment delivery contested")
        time.sleep(0.02)


def _deliver_estimate_comment(task_id: str, board: Optional[str], run_id: Any,
                              binding: Dict[str, Any],
                              settings: Optional[Dict[str, Any]]) -> None:
    """Post a pending estimate/audit comment without re-running Epoch."""
    _deliver_comment(task_id, board, run_id, binding, settings, CommentKind.ESTIMATE)


def _deliver_actual_comment(task_id: str, board: Optional[str], run_id: Any,
                            binding: Dict[str, Any],
                            settings: Optional[Dict[str, Any]]) -> str:
    """Post a pending actual/rejection comment without re-recording. Returns status string.

    Once delivery has finished (or there is nothing to post), further calls return
    ``already_recorded`` so the outbox treats the job as terminal; a post made by this call
    returns the binding's ledger outcome.
    """
    posted, fresh = _deliver_comment(task_id, board, run_id, binding, settings, CommentKind.ACTUAL)
    if not posted:
        return "already_recorded"
    return (ledger_outcome(fresh) or LedgerOutcome.RECORDED).value


# --------------------------------------------------------------------------- jobs


def _fmt_hours(hours: float) -> str:
    return f"{hours:.2f}h" if hours >= 0.1 else f"{hours * 60:.1f}min"


def record_actual_for_run(task_id: str, board: Optional[str], run_id: Any,
                          shown: Dict[str, Any], settings: Optional[Dict[str, Any]]) -> str:
    """Record the wall-clock of *run_id* against its own estimate. Returns a status string.

    Idempotent via the shared bindings store (not Kanban markers). Epoch's ledger also rejects a
    second actual for the same feedbackRef (``duplicate``), so two processes racing here record
    exactly once. Comments are display/audit only — delivery state is tracked separately from the
    ledger ``recorded`` flag so a transient BoardError after persist still retries the comment
    without re-recording.
    """
    run = _run_for(shown, run_id)
    if not _run_completed(run):
        return "run_not_completed"
    binding = _binding_get(settings, task_id, board, run_id)
    if not binding or not binding.get("ref"):
        return "no_estimate"
    if binding.get("recorded"):
        return _deliver_actual_comment(task_id, board, run_id, binding, settings)
    ref = str(binding["ref"])
    hours = (int(run["ended_at"]) - int(run["started_at"])) / 3600.0
    entry = {"estimate_id": ref, "actual_hours": round(hours, 4),
             "notes": f"hermes kanban {task_id} run {run_id} (wall-clock)",
             "calibration_provenance": AUTO_WALLCLOCK}
    res = run_epoch(["batch-record-actuals", "--entries", json.dumps([entry])], settings)
    data = res.get("data") if isinstance(res.get("data"), dict) else {}
    if res.get("ok") and int(data.get("succeeded") or 0) >= 1:
        body = (f"⏱ Epoch recorded actual {_fmt_hours(hours)} (wall-clock, auto_wallclock, run {run_id}). "
                + format_marker("actual", run=run_id, ref=ref, hours=f"{hours:.4f}"))
        _binding_mark_recorded(settings, task_id, board, run_id, status="recorded",
                               actual_comment_body=body)
        fresh = _binding_get(settings, task_id, board, run_id) or {}
        _deliver_actual_comment(task_id, board, run_id, fresh, settings)
        return "recorded"
    err = _error_text(res) if not res.get("ok") else "; ".join(map(str, data.get("errors") or []))
    if "reason: duplicate" in err:
        # The ledger already holds this run's actual, but that says nothing about whether the
        # audit comment was delivered: a concurrent recorder may have stored its body and then hit
        # a BoardError, or this process may have crashed after the CLI append and before the
        # binding commit. Keep any pending body (else store a truthful already-recorded notice)
        # and mark delivery complete only after a successful post.
        notice = (f"⏱ Epoch already has an actual recorded for run {run_id} (wall-clock "
                  f"{_fmt_hours(hours)} observed; ledger rejected a duplicate). "
                  + format_marker("actual", run=run_id, ref=ref, status="duplicate"))
        _binding_mark_recorded(settings, task_id, board, run_id, status="duplicate",
                               actual_comment_body=notice, keep_existing=True)
        fresh = _binding_get(settings, task_id, board, run_id) or {}
        _deliver_actual_comment(task_id, board, run_id, fresh, settings)
        return "duplicate"
    if "auto_wallclock_out_of_bounds" in err or "below_threshold" in err:
        body = (f"⏱ Epoch did not record wall-clock {_fmt_hours(hours)} for run {run_id}: it fails Epoch's "
                f"auto_wallclock sanity gate (0.05–12h and <10× the estimate). Record a verified "
                f"actual with `/epoch record-actual --estimate-id {ref} --actual-hours <h>`. "
                + format_marker("actual", run=run_id, ref=ref, status="rejected"))
        _binding_mark_recorded(settings, task_id, board, run_id, status="rejected",
                               actual_comment_body=body)
        fresh = _binding_get(settings, task_id, board, run_id) or {}
        _deliver_actual_comment(task_id, board, run_id, fresh, settings)
        return "rejected"
    raise RuntimeError(f"record failed: {err}")  # transient -> outbox retry


def claimed_job(task_id: str, board: Optional[str], run_id: Any,
                settings: Optional[Dict[str, Any]] = None, *, attempt: int = 0) -> str:
    shown = show_task(task_id, board)
    if run_id is not None and not _claim_is_live(shown, run_id):
        return "stale"
    want_comment = bool(_cfg("comment_on_claim", settings))
    want_actuals = bool(_cfg("record_actuals", settings))
    if not (want_comment or want_actuals):
        return "disabled"
    binding = _binding_get(settings, task_id, board, run_id) if run_id is not None else None
    if not (binding and binding.get("ref")):
        task = shown.get("task") or {}
        result = estimate(task.get("title") or "", task.get("body") or "", settings=settings)
        if result.get("method") is None:
            # Epoch failed (e.g. slow first-run npx timed out). Say so once, visibly, then leave
            # the job in the outbox so a later load retries it.
            if attempt == 0 and want_comment:
                add_comment(task_id, board, f"{result['summary']} (will retry)")
            raise RuntimeError(result["summary"])
        # The estimate may have taken a while (first-run npx): re-check that this claim still owns
        # the task before publishing, so a late result from a reclaimed run never lands.
        shown = show_task(task_id, board)
        if run_id is not None and not _claim_is_live(shown, run_id):
            return "stale"
        ref = result.get("feedbackRef")
        marker = format_marker("estimate", run=run_id, ref=ref) if (ref and run_id is not None) else ""
        if want_comment:
            comment_body = f"{result['summary']} {marker}".strip()
        elif marker and want_actuals:
            comment_body = f"⏱ Epoch tracking this run. {marker}"
        else:
            comment_body = None
        # Persist binding (+ pending comment body) BEFORE posting so a crash/BoardError between
        # persist and comment still retries delivery without re-estimating. First writer wins the
        # ref; a concurrent racer that finished estimating late re-reads and delivers the winner's
        # pending body (never double-posts, never redirects the run to an orphaned feedbackRef).
        if ref and run_id is not None:
            _binding_put_ref(settings, task_id, board, run_id, str(ref),
                             estimate_comment_body=comment_body)
            binding = _binding_get(settings, task_id, board, run_id) or {}
            _deliver_estimate_comment(task_id, board, run_id, binding, settings)
        elif comment_body:
            # No run_id (cannot bind) — best-effort single post, no durable delivery flag.
            add_comment(task_id, board, comment_body)
        shown = show_task(task_id, board)
    else:
        # Binding already exists (prior attempt persisted ref). Retry any missing audit comment
        # without calling Epoch again.
        _deliver_estimate_comment(task_id, board, run_id, binding, settings)
        shown = show_task(task_id, board)
    # Completion may have fired before the estimate existed: reconcile here (idempotent).
    if want_actuals and run_id is not None and _run_completed(_run_for(shown, run_id)):
        return "estimated+" + record_actual_for_run(task_id, board, run_id, shown, settings)
    return "estimated"


def completed_job(task_id: str, board: Optional[str], run_id: Any,
                  settings: Optional[Dict[str, Any]] = None, *, attempt: int = 0) -> str:
    if run_id is None or not _cfg("record_actuals", settings):
        return "skipped"
    shown = show_task(task_id, board)
    # No estimate marker yet means the claim side has not published; it reconciles after posting.
    return record_actual_for_run(task_id, board, run_id, shown, settings)


_JOBS = {"claimed": claimed_job, "completed": completed_job}


# --------------------------------------------------------------------------- outbox + lifecycle


def _job_id(kind: str, task_id: str, board: Optional[str], run_id: Any) -> str:
    return f"{kind}:{board or '-'}:{task_id}:{run_id}"


def _outbox_update(fn) -> None:
    """Apply *fn* to the outbox dict under a cross-process transaction when possible.

    Hermes ``PluginState.get``/``set`` each lock individually; a get→mutate→set RMW across
    processes can lose an enqueue or double-claim a lease. When ``ctx.state.path`` is set we hold
    the same sibling lockfile Hermes uses and rewrite ``outbox`` in one critical section without
    calling get/set (which would drop the lock between ops).
    """
    if _ctx is None:
        return
    try:
        state = _ctx.state
        update = getattr(state, "update", None)
        if callable(update):
            def mutator(current):
                box = current if isinstance(current, dict) else {}
                fn(box)
                return box
            update(OUTBOX_KEY, mutator, default={})
            return
        path = getattr(state, "path", None)
        if path is not None:
            path = Path(path)
            with _outbox_lock:
                with _file_lock(path):
                    data = _read_json_file(path)
                    box = data.get(OUTBOX_KEY) if isinstance(data.get(OUTBOX_KEY), dict) else {}
                    fn(box)
                    data[OUTBOX_KEY] = box
                    _write_json_file(path, data)
            return
        with _outbox_lock:
            box = state.get(OUTBOX_KEY, None) or {}
            if not isinstance(box, dict):
                box = {}
            fn(box)
            state.set(OUTBOX_KEY, box)
    except Exception:
        logger.debug("epoch: outbox update failed", exc_info=True)


def _outbox_put(job: Dict[str, Any]) -> None:
    _outbox_update(lambda box: box.__setitem__(job["id"], job))


def _outbox_done(job_id: str) -> None:
    _outbox_update(lambda box: box.pop(job_id, None))


DEAD_LETTER_FILE = "dead-letter.jsonl"


def _dead_letter_path(settings: Optional[Dict[str, Any]] = None) -> Path:
    return _epoch_data_dir(settings) / DEAD_LETTER_FILE


def _dead_letter(job: Dict[str, Any], reason: str) -> None:
    """Record a job the outbox will never retry, so abandoning it is never silent."""
    record = {
        "id": job.get("id"), "task_id": job.get("task_id"), "board": job.get("board"),
        "kind": job.get("kind"), "run_id": job.get("run_id"),
        "attempts": int(job.get("attempts") or 0), "created_at": job.get("created_at"),
        "last_error": job.get("last_error"), "reason": reason, "abandoned_at": time.time(),
    }
    try:
        path = _dead_letter_path(job.get("settings"))
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True, default=str) + "\n")
    except OSError as exc:
        logger.warning("epoch: could not write dead-letter for job %s: %s", job.get("id"), exc)
    logger.warning("epoch: abandoned %s job %s for task %s (%s, attempts=%s)",
                   job.get("kind"), job.get("id"), job.get("task_id"), reason, record["attempts"])


def dead_letter_count(settings: Optional[Dict[str, Any]] = None) -> int:
    try:
        with _dead_letter_path(settings).open(encoding="utf-8") as handle:
            return sum(1 for line in handle if line.strip())
    except OSError:
        return 0


def _run_job(job: Dict[str, Any]) -> None:
    fn = _JOBS.get(job.get("kind"))
    try:
        if fn is None:
            _outbox_done(job["id"])
            return
        status = fn(job["task_id"], job.get("board"), job.get("run_id"), job.get("settings"),
                    attempt=int(job.get("attempts") or 0))
        logger.debug("epoch: %s -> %s", job["id"], status)
        _outbox_done(job["id"])
    except Exception as exc:
        logger.debug("epoch: job %s failed; left in outbox for retry", job.get("id"), exc_info=True)
        def bump(box):
            if job["id"] in box:
                box[job["id"]]["attempts"] = int(box[job["id"]].get("attempts", 0)) + 1
                box[job["id"]]["lease_until"] = 0
                box[job["id"]]["last_error"] = f"{type(exc).__name__}: {exc}"[:300]
        _outbox_update(bump)
    finally:
        with _inflight_lock:
            _inflight.pop(job["id"], None)


def _start(job: Dict[str, Any]) -> threading.Thread:
    """Run *job* on a background thread that inherits the caller's ContextVars (profile)."""
    run_ctx = contextvars.copy_context()
    t = threading.Thread(target=run_ctx.run, args=(_run_job, job), daemon=True,
                         name=f"epoch-{job['kind']}")
    with _inflight_lock:
        _inflight[job["id"]] = t
    t.start()
    return t


def _redact_home(text: str) -> str:
    """Errors are posted as Kanban comments; never leak the home directory path into them."""
    home = os.path.expanduser("~")
    if home and home not in ("/", "~"):
        text = text.replace(home.rstrip("/"), "~")
    return text


def _enqueue(kind: str, task_id: str, board: Optional[str], run_id: Any) -> Optional[threading.Thread]:
    settings = snapshot_settings()  # resolved in the hook's own profile context
    job = {"id": _job_id(kind, task_id, board, run_id), "kind": kind, "task_id": task_id,
           "board": board, "run_id": run_id, "settings": settings, "created_at": time.time(),
           "attempts": 0, "lease_until": time.time() + _lease_seconds(settings),
           "owner_pid": os.getpid()}
    with _inflight_lock:
        if job["id"] in _inflight:
            return None
    _outbox_put(job)
    return _start(job)


def _lease_seconds(settings: Optional[Dict[str, Any]]) -> float:
    try:
        return 3 * float(_cfg("timeout_seconds", settings)) + 30
    except (TypeError, ValueError):
        return 210.0


def _pid_alive(pid: Any) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def replay_outbox() -> List[threading.Thread]:
    """Restart unfinished jobs from this profile's outbox.

    A job is taken over when its lease expired or the process that owned it is gone (e.g. a
    one-shot CLI that hard-exited mid-estimate). Jobs owned by a live process are left alone.
    """
    started: List[threading.Thread] = []
    if _ctx is None:
        return started
    now = time.time()
    picked: List[Dict[str, Any]] = []
    abandoned: List[Tuple[Dict[str, Any], str]] = []

    def pick(box):
        for jid, job in list(box.items()):
            if not isinstance(job, dict):
                box.pop(jid, None)
                continue
            too_old = now - float(job.get("created_at") or 0) > OUTBOX_MAX_AGE_SECONDS
            if too_old or int(job.get("attempts") or 0) >= OUTBOX_MAX_ATTEMPTS:
                # Terminal by policy: record the loss before dropping the job.
                abandoned.append((dict(job, id=job.get("id") or jid),
                                  "too_old" if too_old else "attempts_exhausted"))
                box.pop(jid, None)
                continue
            with _inflight_lock:
                busy = jid in _inflight
            leased = float(job.get("lease_until") or 0) > now and _pid_alive(job.get("owner_pid"))
            if busy or leased:
                continue
            job["lease_until"] = now + _lease_seconds(job.get("settings"))
            job["owner_pid"] = os.getpid()
            picked.append(dict(job))

    _outbox_update(pick)
    for job, reason in abandoned:
        _dead_letter(job, reason)
    for job in picked:
        started.append(_start(job))
    return started


_replay_lock = threading.Lock()
_replay_last = 0.0


def _maybe_replay() -> None:
    """Retry stuck outbox jobs from a long-lived process, not only at the next plugin load."""
    global _replay_last
    with _replay_lock:
        now = time.time()
        if now - _replay_last < OUTBOX_REPLAY_INTERVAL_SECONDS:
            return
        _replay_last = now
    replay_outbox()


def wait_for_inflight(timeout: Optional[float] = None) -> bool:
    """Join in-flight jobs up to *timeout* seconds total. True when none remain."""
    if timeout is None:
        try:
            timeout = float(_cfg("shutdown_wait_seconds"))
        except (TypeError, ValueError):
            timeout = float(DEFAULTS["shutdown_wait_seconds"])
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        with _inflight_lock:
            threads = list(_inflight.values())
        if not threads:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        threads[0].join(remaining)


def _atexit_wait() -> None:
    try:
        if not wait_for_inflight():
            logger.info("epoch: unfinished jobs left in outbox; they resume on next load")
    except Exception:
        pass


# --------------------------------------------------------------------------- hooks / surfaces


_reconcile_lock = threading.Lock()
_reconcile_last = 0.0


def _split_binding_key(key: str) -> Optional[Tuple[Optional[str], str, str]]:
    parts = key.rsplit(":", 2)
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return None
    board, task_id, run_id = parts
    return (None if board == "-" else board), task_id, run_id


def _dead_letter_ids(settings: Optional[Dict[str, Any]]) -> set[str]:
    ids: set[str] = set()
    try:
        with _dead_letter_path(settings).open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict) and row.get("id"):
                    ids.add(str(row["id"]))
    except OSError:
        return set()
    return ids


def reconcile_missed_actuals(settings: Optional[Dict[str, Any]] = None,
                             limit: int = RECONCILE_PER_PASS) -> int:
    """Record actuals whose completion hook never fired in this profile.

    ``kanban_task_completed`` fires in the process that finished the run. When that profile does
    not enable this plugin, the run's binding stays unrecorded forever. This pass checks up to
    *limit* unrecorded bindings (picked at random) against the board, warns once per run that completed without a
    recorded actual, and queues the normal completion job for it. Runs that ended any other way
    are marked so later passes skip them. Returns the number of jobs queued.
    """
    if not _cfg("record_actuals", settings):
        return 0
    path = _epoch_data_dir(settings) / BINDINGS_FILE
    with _file_lock(path):
        data = _read_json_file(path)
    dead_ids = _dead_letter_ids(settings)
    outbox_ids: set[str] = set()
    _outbox_update(lambda box: outbox_ids.update(box))
    open_keys = []
    for key, value in data.items():
        if not (isinstance(value, dict) and value.get("ref") and ledger_outcome(value) is None
                and not value.get("run_ended")):
            continue
        parsed = _split_binding_key(key)
        if parsed is None:
            continue
        board, task_id, run_id = parsed
        job_id = _job_id("completed", task_id, board, run_id)
        if job_id not in dead_ids and job_id not in outbox_ids:
            open_keys.append(key)
    queued = 0
    # A random sample, so bindings that keep failing (a deleted task, an unreachable board) can't
    # starve the rest of a large backlog.
    for key in random.sample(open_keys, min(max(0, limit), len(open_keys))):
        parsed = _split_binding_key(key)
        if parsed is None:
            continue
        board, task_id, run_id = parsed
        try:
            run = _run_for(show_task(task_id, board), run_id)
        except Exception:
            continue  # board unreachable or task gone: try again next pass
        if _run_completed(run):
            logger.warning(
                "epoch: run %s of task %s completed but its actual was never recorded; recording it "
                "now. Enable the epoch plugin in the profile that runs this board's workers so "
                "completions record directly.", run_id, task_id)
            thread = _enqueue("completed", task_id, board, run_id)
            if thread is not None:
                queued += 1
                thread.join()
        elif run and run.get("ended_at") is not None:
            outcome = str(run.get("outcome") or "ended")

            def mark(d: Dict[str, Any], key: str = key, outcome: str = outcome) -> None:
                cur = d.get(key)
                if isinstance(cur, dict) and ledger_outcome(cur) is None:
                    d[key] = dict(cur, run_ended=outcome)

            _bindings_update(settings, mark)
    return queued


def _maybe_reconcile(force: bool = False) -> Optional[threading.Thread]:
    """Run one reconcile pass in the background, at most once per interval."""
    global _reconcile_last
    now = time.time()
    with _reconcile_lock:
        if not force and now - _reconcile_last < RECONCILE_INTERVAL_SECONDS:
            return None
        _reconcile_last = now
    settings = snapshot_settings()
    run_context = contextvars.copy_context()

    def run() -> None:
        try:
            reconcile_missed_actuals(settings)
        except Exception:
            logger.debug("epoch: reconcile pass failed", exc_info=True)

    thread = threading.Thread(target=run_context.run, args=(run,),
                              name="epoch-reconcile", daemon=True)
    thread.start()
    return thread


def _on_claimed(task_id: str = "", board: Optional[str] = None, run_id: Any = None, **_: Any) -> None:
    try:
        if task_id:
            _enqueue("claimed", task_id, board, run_id)
            _maybe_reconcile()
    except Exception:
        logger.debug("epoch: claimed hook failed for %s", task_id, exc_info=True)


def _on_completed(task_id: str = "", board: Optional[str] = None, run_id: Any = None, **_: Any) -> None:
    try:
        if task_id and _cfg("record_actuals"):
            _enqueue("completed", task_id, board, run_id)
        _maybe_replay()
    except Exception:
        logger.debug("epoch: completed hook failed for %s", task_id, exc_info=True)


def _on_dispatch_tick(**_: Any) -> None:
    """Use Hermes' idle dispatcher ticks to revisit completions missed by another profile."""
    try:
        _maybe_reconcile()
    except Exception:
        logger.debug("epoch: dispatch-tick reconcile failed", exc_info=True)


# /epoch policy. Never via slash: long-running server, self-modification, telemetry/data
# mutations (only their read-only ``status`` / ``where`` views). On gateway platforms (Telegram,
# Discord, …) commands that write the ledger or read the local repo are refused unless
# ``allow_write_slash_on_gateway: true``.
# share-data writes a file at a caller-chosen --output path: terminal only, never via slash.
_SLASH_BLOCKED = frozenset({"serve", "self-improve", "share-data"})
_SLASH_PATH_FLAGS = ("--output", "-o")
_SLASH_READONLY_SUBS = {"telemetry": frozenset({"status"}), "data": frozenset({"where", "status"})}
_SLASH_WRITE = frozenset({"record-actual", "batch-record-actuals", "auto-actuals", "mine-git",
                          "calibrate-estimates"})
_LOCAL_PLATFORMS = frozenset({"", "cli", "local", "tui", "desktop", "acp"})
_GLOBAL_VALUE_FLAGS = frozenset({"--format"})


def _session_platform() -> str:
    try:
        from gateway.session_context import get_session_env
        plat = get_session_env("HERMES_SESSION_PLATFORM", "") or ""
    except Exception:
        plat = os.environ.get("HERMES_SESSION_PLATFORM") or ""
    return str(os.environ.get("HERMES_PLATFORM") or plat or "").strip().lower()


def _on_gateway() -> bool:
    return _session_platform() not in _LOCAL_PLATFORMS


def _subcommand(args: List[str]) -> Tuple[Optional[str], Optional[str]]:
    """(command, its first positional) skipping Epoch's global flags."""
    words: List[str] = []
    skip = False
    for a in args:
        if skip:
            skip = False
            continue
        if a.startswith("-"):
            skip = a in _GLOBAL_VALUE_FLAGS and not words
            continue
        words.append(a)
        if len(words) == 2:
            break
    return (words[0] if words else None), (words[1] if len(words) > 1 else None)


def _slash_refusal(args: List[str]) -> Optional[str]:
    cmd, sub = _subcommand(args)
    if cmd is None:
        return None
    if cmd in _SLASH_BLOCKED:
        return f"/epoch {cmd} is not available from Hermes; run `epoch {cmd}` in a terminal."
    if any(a in _SLASH_PATH_FLAGS or a.startswith("--output=") for a in args):
        return "/epoch cannot write files at a chosen path; run that command in a terminal."
    if cmd in _SLASH_READONLY_SUBS and sub not in _SLASH_READONLY_SUBS[cmd]:
        allowed = ", ".join(sorted(_SLASH_READONLY_SUBS[cmd]))
        return (f"/epoch {cmd} {sub or ''}".rstrip() + f" is not available from Hermes (only {cmd} "
                f"{allowed}); run `epoch {cmd} …` in a terminal. Plugin runs force telemetry off.")
    if cmd in _SLASH_WRITE and _on_gateway() and not _cfg("allow_write_slash_on_gateway"):
        return (f"/epoch {cmd} writes the local Epoch ledger and is disabled on gateway platforms. "
                "Run it from the Hermes CLI, or set allow_write_slash_on_gateway: true.")
    return None


def _slash(raw_args: str) -> str:
    try:
        args = shlex.split(raw_args or "")
    except ValueError as exc:
        return f"Could not parse arguments: {exc}"
    if not args:
        return ("Usage: /epoch <epoch-cli-subcommand> [flags]  e.g. /epoch pert-estimate "
                "--optimistic 2 --most-likely 4 --pessimistic 10\n" + PANE_SETUP)
    if args == ["status"]:
        return PANE_SETUP
    refusal = _slash_refusal(args)
    if refusal:
        return refusal
    res = run_epoch(args)
    if res.get("ok") and _subcommand(args)[0] not in _SLASH_READONLY_SUBS:
        _broadcast_pane_event("data.updated", {})
    data = res.get("data") if isinstance(res.get("data"), dict) else None
    if res.get("ok") and data and data.get("humanReadable"):
        out = data["humanReadable"]
    else:
        out = _redact_home(json.dumps(res, indent=2))[:3500]
    if _subcommand(args) == ("data", "status"):
        out += "\n" + PANE_SETUP
        lost = dead_letter_count()
        out += (f"\nPlugin jobs abandoned after retries: {lost} (see {DEAD_LETTER_FILE} in the "
                "Epoch data folder)." if lost else "\nPlugin jobs abandoned after retries: 0.")
    return out


ESTIMATE_SCHEMA = {
    "name": "epoch_estimate",
    "description": "Calibrated time estimate for a task via Epoch. Give all three of optimistic/most_likely/pessimistic hours (0 < o <= m <= p) for a P50/P90 Monte Carlo range; they override any 'epoch:' hint in title/body. Otherwise Epoch uses a hint from the title/body, then reference-class forecasting.",
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "body": {"type": "string"},
            "optimistic": {"type": "number", "description": "hours", "exclusiveMinimum": 0},
            "most_likely": {"type": "number", "description": "hours", "exclusiveMinimum": 0},
            "pessimistic": {"type": "number", "description": "hours", "exclusiveMinimum": 0},
        },
        "required": ["title"],
    },
}

_TRIPLE = ("optimistic", "most_likely", "pessimistic")

SHOW_SCHEMA = {
    "name": "epoch_show",
    "description": "Ask the enabled Epoch Desktop page to open a chart view and optionally focus a Kanban card; the page must be open and enabled.",
    "parameters": {
        "type": "object",
        "properties": {
            "view": {"type": "string", "enum": list(PANE_VIEWS),
                     "description": "bars: Distribution; cdf: Chance done by; dots: 50 dots."},
            "item_id": {"type": "string", "minLength": 1, "maxLength": 80,
                        "pattern": "^[A-Za-z0-9_.:-]+$", "description": "Optional Kanban card id."},
        },
        "required": ["view"],
        "additionalProperties": False,
    },
}


def _show(args: Dict[str, Any], **_: Any) -> str:
    if not _valid_view(args):
        return ("Error: view must be bars, cdf or dots; optional item_id must contain 1–80 "
                "letters, digits, underscores, dots, colons or hyphens; no extra arguments.")
    sent = _broadcast_pane_event("view.set", dict(args))
    item = f" for card {args['item_id']}" if "item_id" in args else ""
    return (f"Asked Desktop to show {args['view']}{item}; the Epoch page must be open and enabled."
            + ("" if sent else " Desktop event bridge unavailable; request was not delivered."))


def _tool(args: Dict[str, Any], **_: Any) -> str:
    args = args or {}
    given = [k for k in _TRIPLE if args.get(k) is not None]
    try:
        if given and len(given) != 3:
            missing = [k for k in _TRIPLE if k not in given]
            raise EstimateInputError(f"explicit estimate needs all of optimistic/most_likely/pessimistic; missing {', '.join(missing)}")
        explicit = {k: args[k] for k in _TRIPLE} if given else None
        r = estimate(str(args.get("title") or ""), str(args.get("body") or ""), explicit=explicit)
    except EstimateInputError as exc:
        return json.dumps({"error": str(exc)})
    out = {"summary": r["summary"], "feedbackRef": r.get("feedbackRef"), "method": r.get("method")}
    if r.get("hint_error"):
        out["hint_error"] = r["hint_error"]
    if r.get("method"):
        _broadcast_pane_event("data.updated", {})
    return json.dumps(out)


def register(ctx) -> None:
    global _ctx, _atexit_registered
    _ctx = ctx
    ctx.register_hook("kanban_task_claimed", _on_claimed)
    ctx.register_hook("kanban_task_completed", _on_completed)
    ctx.register_hook("on_kanban_dispatch_tick", _on_dispatch_tick)
    ctx.register_command("epoch", handler=_slash, description="Run Epoch time-estimation CLI.",
                         args_hint="<subcommand> [flags]")
    ctx.register_tool(name="epoch_estimate", toolset="epoch", schema=ESTIMATE_SCHEMA, handler=_tool,
                      description=ESTIMATE_SCHEMA["description"], emoji="⏱")
    ctx.register_tool(name="epoch_show", toolset="epoch", schema=SHOW_SCHEMA, handler=_show,
                      description=SHOW_SCHEMA["description"], emoji="⏱")
    if not _atexit_registered:
        atexit.register(_atexit_wait)
        _atexit_registered = True
    try:
        replay_outbox()
    except Exception:
        logger.debug("epoch: outbox replay failed", exc_info=True)
    try:
        _maybe_reconcile(force=True)
    except Exception:
        logger.debug("epoch: reconcile start failed", exc_info=True)
