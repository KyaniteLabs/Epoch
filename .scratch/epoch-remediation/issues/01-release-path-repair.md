# 01 — Release-path repair: mirror reconciliation + real CI gating

**What to build:** Releases publish through the GitHub mirror whose source-of-truth Forgejo CI cannot fail. Reconcile the mirror with canonical main (land the missing dependency-bump commit), make the Forgejo workflow actually gate (frozen-lockfile install, typecheck, lint, test — no `|| true`), add a pre-publish divergence check inside the release job (before the publish step, since the workflow triggers after the tag exists), and correct SECURITY.md's scanner/trigger claims to match reality.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `upstream-github/main` no longer diverged from canonical main; missing dependency bump landed
- [ ] Forgejo workflow runs install(frozen lockfile)+typecheck+lint+test with no `|| true` guard, verified by a mechanical gate asserting the workflow file contains no failure-masking guard
- [ ] Release job runs a pre-publish mirror-divergence check that blocks publishing from a diverged tree
- [ ] SECURITY.md names the actual scanner and trigger scope; support table is self-consistent
