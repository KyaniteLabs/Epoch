"""A settings read that raises falls back to the default and says so once, not silently."""
from __future__ import annotations

import logging


def test_failing_config_read_warns_once_and_uses_the_default(plugin, caplog):
    class BrokenCtx:
        def get_config(self, key, default=None):
            raise RuntimeError("config store unreadable")

    plugin._ctx = BrokenCtx()
    with caplog.at_level(logging.WARNING, logger=plugin.logger.name):
        first = plugin._cfg("iterations")
        second = plugin._cfg("iterations")
        plugin._cfg("timeout_seconds")
    assert first == second == plugin.DEFAULTS["iterations"]
    warnings = [r for r in caplog.records if "config" in r.getMessage() and r.levelno == logging.WARNING]
    assert len(warnings) == 1
