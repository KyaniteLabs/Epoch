# 05 — Working-tree repair: agent-law marker + stray backups

**What to build:** The uncommitted doc rewrites (AGENTS.md, CLAUDE.md, .cursorrules, .windsurfrules, copilot-instructions) drop the EMPOWER_ORCHESTRATOR marker that agent-law CI requires — committing them as-is fails every PR. Restore the marker block into the rewritten docs (do not revert the rewrites). Verify the two `.bak-glm53-20260814` files are fully redundant with their current counterparts before deleting, and add a `*.bak*` ignore pattern.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] All five working-tree docs contain the required marker block; the local agent-law check passes
- [ ] `.bak-*` files deleted only after a documented diff check showing content is subsumed by current counterparts
- [ ] `.gitignore` covers `*.bak*`
