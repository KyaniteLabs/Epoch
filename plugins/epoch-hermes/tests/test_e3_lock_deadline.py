"""E3: the POSIX state lock gives up at a deadline."""
from __future__ import annotations

import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parent.parent
def test_file_lock_gives_up_at_its_deadline(plugin, tmp_path):
    if plugin.os.name == "nt":
        pytest.skip("POSIX lock")
    target = tmp_path / "ledger.json"
    lock_path = tmp_path / ".ledger.json.lock"
    child = subprocess.Popen(
        [sys.executable, "-c", textwrap.dedent(f"""
            import fcntl, sys, time
            h = open({str(lock_path)!r}, "a+b")
            fcntl.flock(h.fileno(), fcntl.LOCK_EX)
            print("held", flush=True)
            time.sleep(6)
        """)],
        stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == "held"
        plugin.LOCK_TIMEOUT_SECONDS = 0.5
        started = time.monotonic()
        with pytest.raises(plugin.LockTimeout, match="another Epoch process"):
            with plugin._file_lock(target):
                pass
        assert time.monotonic() - started < 3
    finally:
        child.kill()
        child.wait()


def test_file_lock_still_works_uncontended(plugin, tmp_path):
    with plugin._file_lock(tmp_path / "x.json"):
        pass

