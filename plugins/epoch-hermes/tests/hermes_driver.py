"""Subprocess driver for test_hermes_e2e.py — one real Hermes process per invocation.

Usage: python hermes_driver.py <action> [args...]; HERMES_HOME / HERMES_KANBAN_HOME select the
profile and the shared board. Loads plugins through Hermes' real discovery, so the epoch plugin's
hooks fire from Hermes' own kanban_db transitions.
"""
import json
import os
import sys

sys.path.insert(0, os.environ["HERMES_AGENT_SRC"])
import logging  # noqa: E402

logging.disable(logging.WARNING)


def plugins():
    from hermes_cli import plugins as p
    p.discover_plugins()
    m = p.get_plugin_manager()
    loaded = m._plugins.get("epoch")
    assert loaded is not None and loaded.enabled and not loaded.error, loaded
    return p


def main():
    action, args = sys.argv[1], sys.argv[2:]
    from hermes_cli import kanban_db as kb
    from hermes_cli import kanban_db_connect as kbc
    if action == "create":
        kbc.init_db()
        with kbc.connect_closing() as conn:
            t = kb.create_task(conn, title=args[0], body=args[1], assignee="coder")
        print(json.dumps({"task_id": t if isinstance(t, str) else t.id}))
        return
    if action == "claim":
        plugins()
        with kbc.connect_closing() as conn:
            task = kb.claim_task(conn, args[0])
            print(json.dumps({"run_id": task.current_run_id}), flush=True)
        if "--hard-exit" in args:
            os._exit(0)  # like hermes' one-shot path: no atexit, no thread joins
        return
    if action == "complete":
        plugins()
        with kbc.connect_closing() as conn:
            ok = kb.complete_task(conn, args[0], summary="done", expected_run_id=int(args[1]))
        print(json.dumps({"ok": bool(ok)}), flush=True)
        if "--hard-exit" in args:
            os._exit(0)
        return
    if action == "load":  # a later process in this profile: plugin load replays its outbox
        plugins()
        return
    if action == "complete-no-plugin":
        with kbc.connect_closing() as conn:
            ok = kb.complete_task(conn, args[0], summary="done", expected_run_id=int(args[1]))
        print(json.dumps({"ok": bool(ok)}), flush=True)
        return
    if action == "watch-tick":
        plugins()
        from hermes_cli import plugins as p
        from hermes_cli import kanban_db_dispatch as dispatch
        epoch = p.get_plugin_manager()._plugins["epoch"].module
        epoch.RECONCILE_INTERVAL_SECONDS = 0
        for thread in list(__import__("threading").enumerate()):
            if thread.name == "epoch-reconcile":
                thread.join(timeout=15)
        ready = args[0] + ".ready"
        open(ready, "w").close()
        deadline = __import__("time").time() + 30
        while not os.path.exists(args[0]) and __import__("time").time() < deadline:
            __import__("time").sleep(0.02)
        if not os.path.exists(args[0]):
            raise TimeoutError("test tick signal not received")
        with kbc.connect_closing() as conn:
            dispatch.dispatch_once(conn, dry_run=True)
        for thread in list(__import__("threading").enumerate()):
            if thread.name == "epoch-reconcile":
                thread.join(timeout=15)
        epoch.wait_for_inflight(15)
        # A file, not stdout: Hermes may hold sys.stdout redirected after a dispatch tick.
        with open(args[0] + ".done", "w") as handle:
            json.dump({"recorded": True}, handle)
        return
    if action == "show":
        with kbc.connect_closing() as conn:
            print(json.dumps({
                "comments": [{"author": c.author, "body": c.body} for c in kb.list_comments(conn, args[0])],
                "runs": [{"id": r.id, "outcome": r.outcome, "started_at": r.started_at, "ended_at": r.ended_at}
                         for r in kb.list_runs(conn, args[0])]}))
        return
    if action == "backdate":  # test-only: pretend run args[0] started args[1] seconds earlier
        with kbc.connect_closing() as conn:
            conn.execute("UPDATE task_runs SET started_at = started_at - ? WHERE id = ?",
                         (int(args[1]), int(args[0])))
            conn.commit()
        return
    raise SystemExit(f"unknown action {action}")


main()
