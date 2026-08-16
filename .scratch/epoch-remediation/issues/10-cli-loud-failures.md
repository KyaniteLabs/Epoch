# 10 — CLI loud failures (non-TTY, exit codes, serve command)

**What to build:** Automation never records silent success: non-interactive `telemetry enable` without `--yes` fails loudly with a non-zero exit instead of hanging on EOF'd stdin and exiting 0; `auto-actuals` routes through the standard CLI result contract (exit 2 on failure, format/quiet honored, no JSON+summary double-write to stdout); `serve` becomes a real documented command with validated `--port` handling and a `--host` flag.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `telemetry enable` with EOF'd stdin and no `--yes` exits non-zero with an actionable message
- [ ] `auto-actuals` honors `--format`/`--quiet`; non-zero exit when entries were skipped with write failures
- [ ] `epoch --help` lists `serve`; `--port abc` errors clearly; out-of-range port errors instead of crashing with an unhandled event
- [ ] stdout/stderr separation preserved (MCP stdio safety when run without args)
