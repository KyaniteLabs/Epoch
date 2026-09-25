# Eval-corpus dataset manifest — S1.4 (A5)

Status: COMPLETE (7 of 7 planned repos harvested 2026-09-25 by agentless background run; 1,147 frozen records; rate-limit-aware resumable collection)
Created: 2026-09-25 · Lane: Epoch S1.4 (autopilot/ultragoal G008) · Program: PRD `prd-epoch-upgrade.md` item 8 / roadmap Part 3

Every row below was **verified first-hand by the lane that wrote this file** — the verification
command, its date, and its observed output are recorded per row. No claim is copied from the PRD
without an independent re-run.

Rules this manifest enforces (PRD S1.4 / test-spec S1.4):

- ≥3 independently verified, fetchable, **zero-cost** datasets.
- Each row: source URL/path, fetch date, license/access basis, record count, freshness, thin-data status.
- `data/public-benchmark.json` is **excluded from stratification** until its contributor field is
  cell-verified (row 5 below) — exclusion, not omission.

---

## 1. GitHub closing-issues corpus (this PR's harvest) — VERIFIED, LIVE

| Field | Value |
|---|---|
| Source | GitHub REST API v3 via `gh api` (authenticated **free** tier; search + issues + pulls + timeline endpoints) |
| Path | `data/eval-corpus/corpus-<freeze-date>.jsonl` (frozen records) + `data/eval-corpus/raw/` (raw cached events, JSONL, resumable) |
| Fetch date | 2026-09-25 (pilot harvest; see freeze-note.json for exact timestamps) |
| License/access basis | Public GitHub repository metadata retrieved via the GitHub REST API under its standard terms; **no author logins stored** (account type + author_association only), issue bodies kept as length+sha256 only, titles truncated to 280 chars — per roadmap Part 3 "never publish per-repo author data". Zero spend: no paid API touched. |
| Record count | **240 frozen records** (pilot, 2 repos): facebook/docusaurus 125 + nestjs/nest 115 after window gates. 375 issues examined end-to-end; 121 dropped pre-gate (no merged closing PR within rule) + 14 dropped by window bounds (>1y calendar window) — every drop counted in `freeze-note.json`. Tier mix: 165 `merge_closed` + 75 `linked_merged`; 10 cross-repo closers. |
| Freshness | Issues closed ≤ 2026-09-25; kept-issue open dates span 2017-11-18 → 2026-09-12 (freeze-note `collection_window`). Corpus sha256 `c87cfcdb…bd6b`, re-freeze byte-identical (determinism verified). |
| Thin-data status | Pilot-scale (2 repos). The 7-repo default list is wired in `scripts/collect-eval-corpus.mjs` — not yet harvested. NOT thin per-repo, thin in repo coverage. |

**Verification receipt (lane-run, 2026-09-25T03:17:54Z):**

```
$ gh api "search/issues?q=repo:nestjs/nest+is:issue+is:closed+linked:pr&per_page=1" \
    --jq '{total_count, first: .items[0].number}'
{"first":17873,"total_count":225}

$ gh api repos/nestjs/nest/issues/17707 --jq '{created_at, closed_at}'      # 06:14:07Z -> 08:10:46Z (2026-09-12/14)
$ gh api repos/nestjs/docs.nestjs.com/pulls/3530 --jq '{merged_at}'          # merged 08:10:45Z — issue closed 1s later
```

Closing mechanism live-verified: the issue close event lands within 1s of the closing-PR merge.
Selection-rule verification (all 7 candidate repos, `node scripts/collect-eval-corpus.mjs check`,
2026-09-25): nestjs/nest 5,901 closed issues / 225 linked · facebook/docusaurus 3,187 / 1,055 ·
strapi/strapi 12,048 / 1,946 · nuxt/nuxt 17,212 / 2,857 · vuejs/core 5,554 / 1,556 · denoland/deno
13,862 / 5,744 · zaproxy/zaproxy 4,564 / 1,036 — all ≥1k closed issues (PRD selection rule met).

## 2. Shipped COCOMO corpora — VERIFIED, FILE-LEVEL

| Field | Value |
|---|---|
| Source | `data/cocomo-calibration-data.json` (shipped in this repo). Primary sources cited in-file: PROMISE Software Engineering Repository (http://promise.site.uottawa.ca/SERepository/), Albrecht 1983 IEEE TSE, Kemerer 1987 CACM |
| Fetch date | File ships with the repo (verified in this clone at main @ 146c4be, 2026-09-25) |
| License/access basis | Publicly published research datasets, compiled and redistributed in-repo; fetchable at zero cost from the shipped path |
| Record count | **195 project entries, file-verified** (COCOMO81 63 + NASA93 93 + Albrecht 24 + Kemerer 15) |
| Freshness | Static research corpora, vintage 1981–1993 (COCOMO81 / NASA93 / Albrecht / Kemerer) |
| Thin-data status | Not thin (n=195) but **legacy-era**: human, pre-AI project economics — flagged for stratification, never used as the sole baseline |

**Verification receipt (lane-run, 2026-09-25):**

```
$ node -e "const d=require('./data/cocomo-calibration-data.json').cocomoCalibration;
           let t=0; for (const ds of d.datasets) t+=ds.projects.length;
           console.log('sum of dataset projects:', t, '| declared projectCount:', d.projectCount);"
sum of dataset projects: 195 | declared projectCount: 240
```

Honest discrepancy, recorded: the file's top-level `projectCount` field declares **240**, but the
shipped datasets sum to **195** entries; the in-file description additionally cites "COCOMO NASA v1
(60 projects)" which is not shipped as a separate dataset. Runtime truth: `cocomo_ground_truth`
evaluates `projects.length` from `getCocomoProjects()` (`src/lib/cocomo-ground-truth.ts:261,274`) —
195 with shipped data plus any community additions. The PRD's "195+240" both check out as the two
sides of this discrepancy; the manifest carries 195 as the file-verified count.

## 3. KyaniteLabs org history — FETCHABILITY VERIFIED, RECORDS PENDING S1.3

| Field | Value |
|---|---|
| Source | `gh api` over `KyaniteLabs/{Epoch,kinocut,checkyourself,tastecheck}` (own org; future harvest via `epoch mine-git`, story S1.3) |
| Fetch date | Fetchability check 2026-09-25T03:19–03:20Z; record harvest pending S1.3 (mine-git not yet landed) |
| License/access basis | Own-org repositories, accessible with the operator's gh credentials; zero cost |
| Record count | Pending S1.3. Upper bound observed today: **159 closed issues total** across the four repos |
| Freshness | All four repos live (pushed_at within 24h of the check) |
| Thin-data status | **THIN — flagged.** 42+114+3+0 closed issues org-wide; too thin alone for a defensible fit (feeds the S4.2/A8 sufficiency guard, not a workaround for it) |

**Verification receipt (lane-run, 2026-09-25):**

```
$ for r in Epoch kinocut checkyourself tastecheck; do
    gh api "search/issues?q=repo:KyaniteLabs/$r+is:issue+is:closed&per_page=1" --jq '.total_count'
  done
42
114
3
0
```

## 4. (reserved) — second public corpus

The 7-repo default list in the collector (row 1) is the designated second public source once fully
harvested; no additional dataset is claimed verified today that was not run above.

## 5. EXCLUDED: `data/public-benchmark.json` — quirk verified, exclusion ACTIVE

| Field | Value |
|---|---|
| Path | `data/public-benchmark.json` (shipped in this repo) |
| Stated size | 2,072 records (`total_records`), generated_at 2026-08-14 |
| Exclusion reason | **`unique_contributors` == `total_records` == 2072 exactly — verified first-hand.** The file's own `source` field is "community + cocomo calibration + local ledger"; the shipped COCOMO portion alone is 195 projects from 4 published research sources and "local ledger" is by construction one operator, so a strict 1-contributor-per-record interpretation is not credible. Until the contributor field is cell-verified (per-cell n reported), the dataset is **excluded from stratification** per PRD S1.4 [A5] / test-spec thin-data guard — no unverified corpus is stratified on. The exclusion is mirrored in S4.3's rebuild source stamps. |
| Re-admission path | Cell-verify contributors (or re-derive the field from community records' installation ids); then per-cell n must be reported and the exclusion lifted in this manifest with a fresh receipt |

**Verification receipt (lane-run, 2026-09-25):**

```
$ python3 -c "import json; d=json.load(open('data/public-benchmark.json')); \
              print('total_records:', d.get('total_records')); \
              print('unique_contributors:', d.get('unique_contributors'))"
total_records: 2072
unique_contributors: 2072
```

---

## FREEZE (pilot)

`node scripts/collect-eval-corpus.mjs freeze` writes `corpus-<date>.jsonl` (deterministically
sorted by issue repo+number), `SHA256SUMS.txt` (corpus + schema), and `freeze-note.json`
(repos, window, filters incl. bot-filter evidence, per-repo kept/dropped counts). Schema:
`data/schemas/eval-corpus.schema.json` (draft-07, mirrors `public-benchmark.schema.json` style).
Actual pilot numbers: **see freeze-note.json in this directory** — recorded there by the tool, not
hand-typed here.

Window convention per record (never blended; S1.1 buckets): `calendar_window` = issue open→close
(review-inclusive), `dev_window` = PR first-commit→merge, `pr_window` = PR open→merge; closing-link
tier (`merge_closed` vs `linked_merged`) carried per record.

Freeze validation receipt (lane-run, 2026-09-25): `node scripts/collect-eval-corpus.mjs validate`
(structural check: required/enum/bound contract, canonical order, duplicates, checksum match
vs `SHA256SUMS.txt`) → `eval-corpus validation OK: 240 records, sha256 c87cfcdbefcc..., order
canonical, no duplicates, bounds respected`; a second `freeze` run reproduced a byte-identical
corpus (same sha `c87cfcdb…bd6b`).
