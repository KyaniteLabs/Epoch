# Foundation evidence and remaining gates

Baseline: GitHub main de62331; isolated clone/worktree, Node 22.23.4, pnpm 10.34.5. No production state or forge settings changed.

## Repaired here

Baseline `pnpm test`: 1946 passed / 9 failed, all failures in dispatcher happy-path persistence. That suite lacked an isolated EPOCH_DATA_DIR and attempted operator-default storage. Added suite-scoped temporary directory and restoration/cleanup; unchanged numerical expectations. Re-run passed. Added ownership-policy validation and rejection tests in `src/contract/architecture-paths.test.ts`, automatically collected by existing CI. Literal inventory identity is github.com/KyaniteLabs/Epoch; patterns must match tracked/candidate source, no empty inventory.

Executed: frozen pnpm install using workspace-local store (default store was read-only); full `pnpm exec vitest run --coverage` PASS including existing thresholds; typecheck, ESLint, build, ops shell syntax, llms-full contract, community validation (12 records), reference-database consistency validation and git diff whitespace checks PASS. Database sample-count consistency is not independent accuracy validation.

## Open gaps / accountable route

- Engineering: real Hermes multiprocess E2E requires HERMES_AGENT_SRC; not exercised here. Existing Python plugin tests and Worker deployment/D1 integration are separate from root Vitest; no live agent/Cloudflare write performed. Run these in their authorized environments before claiming integration/deployment acceptance.
- Engineering/Product: static-site browser E2E and all-client MCP compatibility are not proved by server unit/process tests. Existing transport integration tests do not prove deployed network exposure or every host.
- Security: exact-head hosted CI, dependency audit policy (critical-only threshold), secret scanning, exposure/secrets/blast-radius/rollback review remain mandatory. Local success is not hosted CI success. No release, registry publication or deployment is requested.
- Platform: authorized Forgejo mirror mapping/visibility/default SHA/head parity and mirror CI receipts remain UNKNOWN. Requested on t_0a3d68a5; root t_2210091a must reconcile. A GitHub PR is not mirror adoption; do not copy private source across visibility boundaries.
- Engineering/root: remaining work stays explicitly unadopted until whole-estate foundations and mirrors reconcile. No partial rollout or exclusion is approved.

## Review and rollback

Product reviews PRODUCT.md and user-facing architecture, then routes to Security for exact-head CI/security review and merge. Builder must not merge. Runtime code is unchanged; only dispatcher test isolation, inventory validation and documentation change. No new listening surface, secrets, credentials or persistence format. Blast radius: contributor guidance and test execution. Rollback is a normal revert of this PR; no data migration/release rollback needed. Existing publishing/branding/learning PRs remain separate; this PR does not certify them.
