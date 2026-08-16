# 03 — Authoritative tool surface in lib (kill all hand-copies)

**What to build:** Make the canonical tool-name set authoritative in lib (schema-level, no registry/handler coupling, preserving lib's MCP-independence). The registry derives its tool names, estimation/non-estimation partition, count strings, and the feedback-health tool list from it — eliminating all three hand-copies (alias set, feedback-health denominator list, registry header comment). A sync suite asserts derivation, not parallel truth. This ticket lands **in the same PR as 04**; the known 24-vs-25 gap is asserted as a literal expectation that flips green with the fix — never `xfail`.

**Blocked by:** None — can start immediately (pair with 04).

**Status:** ready-for-agent

- [ ] Lib module exports the authoritative name set + partition; registry, feedback-health tool list, and count strings derive from it (no duplicated literals remain)
- [ ] Sync suite asserts derived equality across registry, aliases, feedback-health list, llms.txt tool list, and count strings
- [ ] No `xfail`/inverted-pass markers anywhere in the sync suite
