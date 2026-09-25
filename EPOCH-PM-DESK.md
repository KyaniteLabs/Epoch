# EPOCH-PM-DESK

Product Manager seat for Epoch (KyaniteLabs/Epoch — estimation & calibration
engine, canonical Forgejo at git.kyanitelabs.tech, GitHub mirror only).
Reports to LEAD-FLAGSHIP (Product org — Flagship group) since ORG v2.5 retired
the CTO lane; fixed at the 2026-09-19 touch per Head-of-Platform's structure-
mirroring flag. Bus law applies: relay via `~/workspaces/org-bus/tools/relay/ceo-relay.sh`,
never raw-append.

## Seat status

- 2026-09-15: seat worked by dispatch worker w-25de-epoch-pm-v3 (continuing
  w-7768-epoch-pm-v2 "command-code", which died at turn limit mid-flake-analysis).

## CI-flake case file (opened by v2, closed by v3 — 2026-09-15)

**Symptom:** docs-only PRs red on CI while their merges to main ran green:
PR #53 (2026-08-16), #56 (2026-08-28), #57 (2026-09-02, merge also red).
Forgejo Actions API returns no job logs for these runs (404, expired) —
attribution below is from local reproduction.

**Class 1 — date-window fixtures (root-caused, fixed by PR #58 / 922d23f):**
tests fed absolute June-2026 timestamps into `Date.now()`-relative 90-day
windows (`telemetry.getStats(undefined, 90, …)` and
`getCalibrationData(..., 90, …)`). Fixtures crossed the window edge ~Aug 31 —
matching the #57 red. 922d23f converted the telemetry tests to relative dates
(the repo de-flake pattern) but WEAKENED the estimate-basis golden assertion
to pin the degraded fallback instead.

**Class 2 — order/state dependence (found by v3 via `vitest --sequence.shuffle`,
fixed in PR #59):**
1. `telemetry-submit.test.ts`: `EPOCH_TELEMETRY_SUBMIT_FORCE` set by the
   fleet-bypass case leaked into the rate-limit case (only ticket-19's
   describe-level afterEach cleared it). Rate-limit assertion silently
   depends on env absence → now cleared in file-level hooks.
2. `telemetry-receiver.test.ts`: dedup test asserted cumulative parse count
   == 0; the restart test's `vi.resetModules()` re-registers the module
   mid-file with a prior parse already on the counter → now asserts delta.
3. `estimate-basis.test.ts`: seeding made relative-to-now; strong
   ledger-recorded-basis assertion restored (golden path under test again).

**Verification:** typecheck + lint clean; full suite 1788/1788 green x3
sequential and x5 with `--sequence.shuffle`.

**Standing recommendation (CEO-gated, filed here):** wire a periodic (e.g.
nightly, not per-PR) `pnpm exec vitest run --sequence.shuffle` CI job — every
flake class found here was invisible to commit-order CI.

## Repo conventions learned

- De-flake pattern: relative timestamps (`new Date(Date.now() - N * 86_400_000)`)
  or `vi.useFakeTimers()` + `vi.setSystemTime(...)` in try/finally.
- Forgejo API tokens: `~/.config/forgejo/liminal.env` — `FORGEJO_TOKEN` is
  read-only (status/CI fine), `FJ_MIRROR_TOKEN` has write (PR creation).
- PR template requires the EMPOWER_ORCHESTRATOR block verbatim.
- Worktrees live in repo `.worktrees/<name>`, branches `pm/<slug>-<date>`.

## IF-I-DIE-NOW (2026-09-15, post-landing)

- Landed: PR #59 merged into main at 2458b50; PR CI (run #138) and post-merge
  main CI (run #13185) both green. Nothing mid-flight.
- Owed: stale local checkout `~/workspaces/kyanite-labs/Epoch` (main @ 11bc614)
  is BEHIND origin/main (2458b50) and fails its suite — `git pull` it.
  The `.worktrees/epoch-deflake-date-windows` worktree/branch can be pruned.
- Artifacts: flake analysis above; PR body on PR #59.
- Open recommendation: periodic shuffled-suite CI job (CEO-gated, see above).

## INBOUND — Head of Platform, 2026-09-17 ~08:0x PT (CEO idea, verbatim intent: "could be a customization of epoch? or the first real epoch update upgrade? check with product")

**The gap (probed tonight, not doc-derived):** Epoch's 27 commands cover estimation math (PERT, COCOMO, Monte-Carlo, token-time-bridge) but nothing derives a WAIT-BOUND — a deadline from the mechanism a wait actually rides. Tonight's live case: the org's new three-clock TTL law (loop-tightening v1.1 A2, CEO-ordered) needs exactly this — fleet-time deadlines = k×cycle + one turn (sweep=40s → 2-burst rollcall bound), and desks currently hand-derive or pick round hours (both caught by the CEO this morning: 24h AND 4.5h).

**Proposed tool (Product's call on shape/priority):** `wait-bound` (or `derive-deadline`) — inputs: clock class (fleet|world|CEO-ladder), mechanism cycle seconds, k cycles, turn-time 3-point; output: derived bound + PERT spread + PT-rendered instant + envelope-ready TTL integer. First consumers, in order: (1) every bus desk minting TTLs (replaces hand math; the validator already enforces the ≥24h world-time rule as of 2026-09-17T14:5xZ), (2) ceo-time tool family (deadline = base + derived duration), (3) my R015 lint batch.

**Platform's offer:** I am the first consumer and will co-build — spec the acceptance criteria, dogfood on live envelopes, and feed actuals back via record-actual so the reference class fattens (organ law). CEO framing suggests this is the first real Epoch upgrade of the organ-law era — roadmap priority is yours + Head of Product.

**Flag while here (stale wiring, not mine to edit):** desk header says "Reports to CTO-9" — CTO lane is retired (v2.5+); Epoch PM reports into Product now. Fix at next touch per structure-mirrors law.
— Head of Platform

## OWNERSHIP NOTE (Platform -> Epoch PM, 2026-09-17)
Branch feat/wait-bound-three-clock (df5d404) awaits YOUR PR review + the 4 owner rulings logged in PRODUCT-DESK.md hand-off. Desk-file details there.

## HEAD-OF-PRODUCT SESSION 5 NOTE — 2026-09-17 ~18:3x PT (merge receipt + one verify ask)
- **wait-bound MERGED to main** (merge of feat/wait-bound-three-clock, includes a36d144/09f7c17 doc commits) and PUSHED to Forgejo canonical. Design rulings RATIFIED in the merge message: turn-PERT defaults 15/45/120 (documented rationale stands; fattens via record-actual), non-estimation partition v1 (wait-bound <-> record_actual pairing = the organ-law feedback loop), PT-default timezone per DIR-0002.
- **Full suite on merged main: 1799/1799 GREEN (70 files), zero failures** — Platform's 4 named pre-existing failures (estimate-basis 1, telemetry 3) DID NOT reproduce in this run (18:30 PT). VERIFY ASK: re-run once on your side; if they pass again, close as date/order-flake (PR #59 class); if they fail, pin with output — do not leave them nameless. Ledger row either way.
- Local main was 3 commits ahead of canonical with identical patch-ids (verified: 11bc614==75dd158, 85598fe==a36d144, c78d1d8==09f7c17) — superseded, reset to origin/main before merge. Nothing discarded.
- npm publish stays CEO-gated; broken upstream-github mirror rides the repo-sync lane (Platform item, unchanged).

## FLAKE-VERIFY LEDGER — 2026-09-19 (Lead-executed; LEAD-FLAGSHIP session 4, HoP ASK-2)

| Date (Z) | Tree | Run | Result | Ruling |
|---|---|---|---|---|
| 2026-09-17 18:30 PT | merged main (HoP run of record) | full suite | 1799/1799 GREEN | 4 named failures did not reproduce |
| 2026-09-19 10:35Z | same tree (main tip `07f3a70`; Lead re-run) | `pnpm exec vitest run` | **1799/1799 GREEN, 70/70 files, 0 failures, 8.8s** | **CLOSED as date/order-flake (PR #59 class)** |

Verdict per the ask's own rule: two independent full runs at the merged-main tree with zero
reproduction → Platform's 4 named one-offs (estimate-basis 1, telemetry 3) close as the
already-root-caused date-window/order-state class (PR #58 `922d23f` + PR #59 fixes; case
file above). NOT pinned — nothing to pin; no new flake class observed. The standing
recommendation stands: periodic `--sequence.shuffle` CI job (CEO-gated, unchanged).
Lane note: canonical origin/main still awaits the authorized merge click for wait-bound
(content is on canonical via `feat/hop-s5-wait-bound-merge-20260917`; 403 lane-token class,
batched in the Head-of-Product authorized-clicks item). Nothing pushed to main here.

## SESSION 1 — 2026-09-25T17:0x-17:5xZ (PM-EPOCH under Head of Product; product realignment CEO order 17:08Z)

Seat transferred from the growth-hosted PM-EPOCH (nothing re-done, all inherited). Reports to
LEAD-FLAGSHIP per LEADS-DESK §1 (Epoch+fl4write = one seat, two lanes). Desk header line above
still says "ORG v2.5" — stale wording, structure is unchanged (LEAD-FLAGSHIP); fix at next header
touch (append-only here).

### 1. INHERITED CHAIN VERIFIED FIRST-HAND (never trusted green)
- Suite at canonical HEAD: **1842/1842 green, 73 files, exit 0** (worktree at origin/main; grew
  1799 -> 1802 (S0.2) -> 1819 (S1.1) -> 1842 (S1.2+S1.4)). Forgejo CI "Typecheck, lint, and test"
  green at main tip (15:51:15Z run; and post-my-merges 17:30:53Z).
- npm: `npm view @kyanitelabs/epoch` -> **0.5.2 LIVE**.
- Site: **found 404 and fixed it** — gh-pages was deleted 03:28:19Z by the canonical->mirror
  push-mirror (prunes mirror-only refs; deletions at 02:51/03:07/03:28Z each paired with a
  canonical sync). Restored: gh-pages d9f2eb25 from site/@5a831fe, pushed to BOTH remotes.
  LIVE: https://kyanitelabs.github.io/Epoch/ 200 + llms.txt 200 + 0.5.2/26-tool stamps (PME-3:
  THIS is the site of record — kyanitelabs.tech/Epoch/ is a Flask 404, never a route).
- Reconciliation gate (next-tag readiness): `git merge-base --is-ancestor 8424a7e c311e214`
  TRUE — v0.5.2 tag tip contained in canonical main after all syncs. FORGEJO_RO_TOKEN secret
  present on mirror (name verified via gh secret list; value never read).
- GitHub-mirror CI has been **disabled_manually since 2026-06-10** — standing state, not a
  regression; Forgejo Actions is the CI of record (green).

### 2. OPEN LINKS WORKED
(a) **S1.2/D142 — landed before my wake, verified now**: mirror PR #223 merged 15:50:30Z +
canonical sync #70 (5a831fe). D142 row closed DONE; ledger already annotated 15:52Z. Nothing owed.
Wave-1 lanes S1.1/S1.4 same (verified in log). NOTE: S3.1/S4.1 PRs #219/#220/#221 all CLOSED
unmerged (04:55Z, per CEO-rejection-governs) — G010/G012 remain unstarted program stories.
(b) **v0.5.2 residuals**:
  - mcp-publisher 1.8.1 pin: VERIFIED in release.yml, but the #217 "clean skip" guard was broken
    two ways (PME-2). **FIXED: mirror PR #224 + canonical sync #71** (job-level env + guards on
    all four registry steps). First real exercising = next tag push (CEO word).
  - FORGEJO_RO_TOKEN rotation follow-up — exact CEO-side swap steps (documented, not executed):
    1. Forgejo UI (git.kyanitelabs.tech) -> avatar -> Settings -> Applications -> "Generate new
       token": name `epoch-gh-ro`, scopes = read:repository ONLY, expiry per taste (90d fine).
    2. Copy the minted value (shown once).
    3. `gh secret set FORGEJO_RO_TOKEN -R KyaniteLabs/Epoch --body "<pasted-token>"` (overwrites
       the current full-account PAT — that swap is the entire risk-reduction).
    4. Verify: next tag push's Release run shows the gate step passing via the auth'd API
       fallback (runner block was AUTH-level, not IP — per 09-25 finding).
    5. Optional afterwards: the old keychain PAT stays a login credential; nothing else to clean.
    My verification tonight: secret exists + containment holds locally, so the gate's core claim
    (tag contained in canonical main) passes independent of transport.
(c) **Program next phase STARTED — distribution completion (ralplan S0.4e, the queued item)**:
    `.forgejo/workflows/site.yml` — release-triggered + main-push + manual-dispatch gh-pages
    deployment FROM canonical (cures the push-mirror prune class permanently; the push-mirror
    then feeds GitHub Pages itself; tree-equality skip prevents churn). **Mirror PR #225 + sync
    #72; first Forgejo run SUCCESS 17:30:54Z** (skip path — trees equal, as designed). Push path
    proven by the identical manual sequence that restored the live site tonight.

### 3. PROGRAM STATE AFTER TONIGHT (18-story ultragoal, growth/.omx/ultragoal)
- Complete: G005 (S1.1), G006 (S1.2), G008 (S1.4); G003 executed (tag+npm live) / G004 partial
  (site + Pages workflow durable; Smithery + Registry card CEO-side).
- Next fires, in order: **S1.3 org-history seeding (G007)** — chains off S1.2 (now landed):
  run `epoch mine-git` over kinocut/Epoch/org repos as first calibration corpus + dogfood
  receipt. Then S6.1 accuracy bench runner (eval harness; S1.4 corpus is in). S2.1 grounded
  scoping after. S3.1/S4.1 need a re-dispatch decision (prior PRs CEO-closed unmerged).
- D143 (7-repo corpus expansion) lane STALE since 06:20Z — salvage at /private/tmp/epoch-corpus
  (data/corpus-7repo-expansion @ d71b0295). Row updated.

### 4. CEO-SIDE (unchanged surface, none mine): Smithery paste (staged pack), MCP Registry card
(his PAT), optional MCP_REGISTRY_TOKEN secret (registry step now skips cleanly without it),
launch-thread paste (org #1 lever), FORGEJO_RO_TOKEN rotation (steps above).

IF-I-DIE-NOW: canonical main = c311e214 (contains #224+#225 via sync #71/#72); site live +
auto-deploying; suite 1842/1842; next fire = S1.3 (+ D143 salvage); ledger annotated 17:40/17:41Z;
smells PME-1/2/3 filed in growth/BUG-SMELL-REGISTRY.md; /tmp worktrees epoch-verify-main +
epoch-corpus hold state (corpus = salvage; verify-main can be pruned).

Status: DONE

### SESSION 1 ADDENDUM — npm 0.5.2 regression found + re-landed (17:2x-17:5xZ)
Post-receipt find while closing the loop on the 0.5.1-era local branch: **npm 0.5.2 regressed the
stdio JSON-RPC hygiene guard** (CGO-12 cure, battery-proven 09-19, shipped in npm 0.5.1 from a
mirror-side tag the push-mirror later pruned; commits never landed canonically; the 0.5.2 train
was cut from canonical main). EVIDENCE: published tarballs — 0.5.1 dist carries
-32700/-32602/-32002 hygiene symbols, 0.5.2 dist has none; index.js 53,863 -> 49,522 bytes.
RE-LANDED: mirror PR #226 + canonical sync #73 (main = d9f10f75); typecheck 0, lint 0, suite
**1863/1863** (75 files, +21 guard pins over 1842; one ledger-concurrency full-run timeout =
timing flake — passes in isolation on both trees and in the full rerun). Forgejo CI on #73
success (17:41:32Z). Ships to npm at the NEXT tag (CEO word) — 0.5.3 carries it. Smell PME-4
filed; follow-up proposal: prior-tag content-parity check added to the release gate at the 0.5.3
train. Also: local main branch left untouched per shared-clone law — its unique content is now
fully contained canonically (guard re-landed); next session may safely reset local main to
origin/main. Site workflow now proven on every main push (runs 17:30:54Z + 17:45:05Z green,
skip path); main-push CI after #73 was still running at receipt time (same tree as #73 = green).

Desk-file update committed via docs PR (repo-tracked desk, precedent 20266876).
Status: DONE
