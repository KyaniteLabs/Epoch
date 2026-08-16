# 02 — Node floor decision + CI matrix + dist-safe version resolver

**What to build:** Raise engines to `>=22` (Node 20 is EOL since April 2026 and never tested), align CI to a 22+24 matrix (24 = publish runtime), replace the `import.meta.dirname` package-version resolution with a URL-based resolver that works from both src and dist layouts, and extend vitest coverage thresholds to the dispatcher and entry-point directories so the program's primary seams sit behind a gate.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] engines field reads `>=22`; CI matrix builds/tests on 22 and 24
- [ ] Version resolver returns the real package version from both src (tsx) and dist layouts (fixture test); no code path can report `0.0.0` or `unknown` on a supported Node
- [ ] vitest coverage thresholds include `src/dispatcher/` and `src/entries/`; suite meets them
