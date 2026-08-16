# 09 — Public-face truth (license, versions, skill examples, docs regen)

**What to build:** The public surfaces stop contradicting the package: license references corrected to Apache-2.0; release-time version derivation built ONCE here (server.json, llms.txt, site stamp from package.json — later hygiene only extends coverage); stale site/llms-full.txt regenerated (25 tools, current version); SKILL.md's broken compare-models example and `--format` placement fixed against the real commander grammar; 0.4.1 changelog notes the accepted ledger-caching deferral and the Node-floor raise.

**Blocked by:** 02 (node-floor changelog), 03 (count derivation).

**Status:** ready-for-agent

- [ ] No MIT references; badge and license section say Apache-2.0
- [ ] server.json, llms.txt, and site version strings all derive from package.json (no hand-edited versions)
- [ ] Site/llms-full.txt regenerated: 25 tools, current version, estimate_from_context present
- [ ] Every SKILL.md example command executes verbatim (CLI test), including `--format` before subcommands or per-subcommand
- [ ] Changelog documents both the caching deferral and engines >=22
