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
