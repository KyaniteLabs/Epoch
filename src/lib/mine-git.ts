// ---------------------------------------------------------------------------
// Epoch mine-git — close the feedback loop from local git history (S1.1)
// ---------------------------------------------------------------------------
//
// `epoch mine-git --repo <path> --since <date>` walks a LOCAL git repository
// (offline by construction — the git runner below hard-rejects every network
// verb) and joins pending ledger estimates to closed work units:
//
//   * merge-commit PRs — "Merge pull request 'title' (#N) from branch" (Forgejo)
//     and "Merge pull request #N from owner/branch" (GitHub)
//   * squash-merged PRs — subjects ending "(#N)" (dev window only derivable
//     when a refs/pull/N/head-class ref carrying the branch commits exists)
//   * plain merges into the default branch (no PR number; branch resolved
//     from the second parent's sha against local refs)
//
// Two cycle-time windows are computed per unit and reported SEPARATELY,
// never blended:
//
//   dev window           first-commit→merge (author date of the earliest
//                         branch-only commit → merge committer date)
//   review-inclusive     open→merge (branch reflog creation timestamp →
//                         merge committer date; only when the reflog anchor
//                         exists locally — never fabricated)
//
// The window selected for recording (`--window dev` by default,
// `--window review-inclusive` to flip) becomes the estimate's actual, stamped
// calibrationProvenance "git_derived" / "git_derived_review_inclusive". The
// other window rides along in the actual's notes — surfaced, not averaged.
//
// Safety model reuses the auto-actuals (auto_wallclock) pattern end to end:
//   * never-overwrite-real-actual is STRUCTURAL — candidates come from
//     getPendingEstimates() (estimates with no actual yet) and
//     recordActualDetailed()'s duplicate guard rejects anything already
//     actualed, so a human/agent-verified actual can never be clobbered;
//   * every candidate passes isGitDerivedSane() (src/lib/exclusion.ts) —
//     bounds [0.05h, 720h] (calendar windows legitimately span nights and
//     weekends, unlike auto_wallclock's 12h session cap; 30 days separates
//     task cycles from abandoned branches) plus the same 10x two-sided
//     ratio limit — as a pre-filter here, a write-time guard in
//     feedback.ts, and a calibration-math gate in isExcluded();
//   * derived actuals are segmented in feedback_health.byProvenance
//     (gitDerived bucket), never silently blended with verified actuals.
//
// Why the matcher works where the auto-actuals session_id join starves (the
// roadmap's "zero candidates" finding): estimates are joined on the identity
// keys planning flows already stamp — inputs.branch (exact/tail match),
// inputs.issue_ref (PR number), inputs.task_label (token overlap against the
// unit's title and branch) — in that precedence order, deterministically
// tie-broken by newest merge.
//
// ---------------------------------------------------------------------------
// Bootstrap mode (S1.2): no-ledger repos enter calibration as reference-class
// baseline records instead of starving the self-improvement loop.
//
// When the estimates ledger is EMPTY (fresh install / first run against a
// repo), join mode has nothing to join — and the cold-start corpus stays
// empty forever because calibration needs matched pairs. Bootstrap mode
// mints them from the same mined units: for each unit with a derivable
// selected window that passes isGitDerivedSane(), it records a
// reference_class_estimate row whose recorded estimate is the tool's own
// medium-scope baseline for the unit's inferred task type (NO correction
// applied — there is no data to correct with yet; that is the point), then
// records the mined cycle-time actual against it with the same
// git_derived / git_derived_review_inclusive provenance stamp join mode
// uses — the same provenance bucket, so feedback_health.byProvenance
// segments bootstrap pairs with all other git-derived pairs.
//
// What the resulting ratios mean, honestly: "what the shipped baseline
// would have said for a typical task of this class" vs "how long the work
// actually took in this repo" — exactly the reference-class correction
// reference_class_estimate learns (median actual/baseline). The estimate
// side is tool-minted, never presented as a human/agent estimate: every
// row carries source "mine-git-bootstrap", an inputs.mine_git_bootstrap_unit
// audit key, and the actual's note says both sides' derivation.
//
// Idempotence is structural: bootstrap only engages while the ledger is
// empty, and the first successful run makes it non-empty. A crashed
// partial run therefore never double-mints on re-run.
//
// CLI entry point: `epoch mine-git --repo <path> --since <date>`
// (src/entries/cli.ts). Not an MCP tool — deliberate, same posture as
// auto-actuals: --repo names a local filesystem path supplied by the calling
// agent/hook, not a value an LLM should self-report over MCP.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { getPendingEstimates, recordActualDetailed, recordEstimate, extractEstimatedHours } from "./feedback.js";
import { isGitDerivedSane, GIT_DERIVED_MIN_HOURS, GIT_DERIVED_MAX_HOURS, GIT_DERIVED_RATIO_LIMIT } from "./exclusion.js";
import { readLines, ESTIMATES_FILE } from "./ledger.js";
import { getScopeBaseline } from "./supplementary-data.js";
import type { EstimateRecord } from "./ledger.js";
import type { TaskType } from "../types/index.js";

/** Unit separator for git --format strings — survives arbitrary subjects. */
const SEP = "\u001f";

/** Practically-unbounded pending-estimate fetch (mirrors auto-actuals). */
const PENDING_FETCH_LIMIT = 1_000_000;

/** Note prefix persisted on every actual this module records. */
export const MINE_GIT_NOTE_PREFIX = "mine-git: cycle-time actual derived from local git history";

/** Note prefix persisted on every bootstrap-minted actual (S1.2). */
export const MINE_GIT_BOOTSTRAP_NOTE_PREFIX = "mine-git bootstrap: reference-class baseline pair minted from local git history";

/** Inputs key marking a bootstrap-minted estimate row (audit trail + future dedupe). */
export const MINE_GIT_BOOTSTRAP_UNIT_KEY = "mine_git_bootstrap_unit";

/**
 * Git verbs that touch the network or mutate the repository. The runner
 * rejects them structurally so "offline, read-only mining" is enforced by
 * code, not convention — `epoch mine-git` can never fetch, clone, push, or
 * move a ref even if a future edit gets the command list wrong.
 */
const FORBIDDEN_GIT_VERBS = new Set([
  "fetch",
  "clone",
  "push",
  "pull",
  "remote",
  "ls-remote",
  "submodule",
  "fetch-pack",
  "upload-pack",
  "receive-pack",
  "merge",
  "rebase",
  "reset",
  "checkout",
  "clean",
  "commit",
  "amend",
  "tag",
  "branch",
  "revert",
  "cherry-pick",
  "stash",
  "worktree",
]);

/** The read-only git verbs the mining path is allowed to use. */
const ALLOWED_GIT_VERBS = new Set(["log", "rev-list", "rev-parse", "for-each-ref", "reflog", "show", "config", "describe"]);

/** Injectable git runner: (repoPath, args) → stdout. Tests substitute fakes; production shells out. */
export type GitRunner = (repoPath: string, args: string[]) => string;

/** Error thrown for actionable mining failures (bad repo, bad --since, git failure). */
export class MineGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MineGitError";
  }
}

/** Production git runner: local, read-only, offline-enforced. */
export function defaultGitRunner(repoPath: string, args: string[]): string {
  const verb = args.find((a) => !a.startsWith("-"));
  if (verb !== undefined && FORBIDDEN_GIT_VERBS.has(verb)) {
    throw new MineGitError(`mine-git refuses to run git "${verb}" — mining is offline and read-only by construction.`);
  }
  if (verb !== undefined && !ALLOWED_GIT_VERBS.has(verb)) {
    throw new MineGitError(`mine-git does not use git "${verb}" — if you are extending the miner, allowlist the verb deliberately.`);
  }
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ---- Work units ------------------------------------------------------------

export type GitWorkUnitKind = "merge_commit_pr" | "squash_pr" | "merged_branch";

/** One closed piece of work mined from local git history. */
export interface GitWorkUnit {
  readonly kind: GitWorkUnitKind;
  /** PR number when the unit carries one (merge-commit and squash PRs). */
  readonly prNumber?: number;
  /** Branch name (shortest local/remote ref name; "unknown" for unresolvable plain merges). */
  readonly branch: string;
  /** Merge/commit title (subject line). */
  readonly title: string;
  /** Merge timestamp (merge-commit committer date, ISO). */
  readonly mergeAt: string;
  /** Earliest author date among the branch-only commits — dev-window start; undefined when not derivable. */
  readonly firstCommitAt?: string;
  /** Latest author date among the branch-only commits. */
  readonly lastCommitAt?: string;
  /** Branch-creation timestamp from the branch reflog — review-inclusive open anchor; undefined when no reflog exists. */
  readonly openAt?: string;
  /** Commits introduced by the unit (rev-list range size). */
  readonly commitCount: number;
}

/** Forgejo merge-commit subject: Merge pull request 'title' (#N) from branch into base */
const FORGEJO_MERGE_RE = /^Merge pull request '(.*)' \(#(\d+)\) from (\S+) into (\S+)$/;
/** GitHub merge-commit subject: Merge pull request #N from owner/branch */
const GITHUB_MERGE_RE = /^Merge pull request #(\d+) from (\S+)$/;
/** Squash-merge subject suffix: ... (#N) */
const SQUASH_PR_RE = /\(#(\d+)\)\s*$/;

interface RawCommitRow {
  sha: string;
  parentShas: string[];
  committerIso: string;
  authorIso: string;
  subject: string;
}

function parseLogRows(raw: string): RawCommitRow[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, parents, committerIso, authorIso, ...subjectParts] = line.split(SEP);
      if (sha === undefined || parents === undefined || committerIso === undefined || authorIso === undefined) {
        return undefined;
      }
      return {
        sha,
        parentShas: parents.split(" ").filter((p) => p.length > 0),
        committerIso,
        authorIso,
        subject: subjectParts.join(SEP),
      };
    })
    .filter((row): row is RawCommitRow => row !== undefined);
}

/** Author-date list for a commit range, oldest-first (min at index 0). */
function authorDatesInRange(runGit: GitRunner, repoPath: string, range: string): string[] {
  let raw: string;
  try {
    raw = runGit(repoPath, ["log", "--format=%aI", range]);
  } catch {
    return [];
  }
  const dates = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  dates.sort();
  return dates;
}

/** Branch-creation timestamp from the branch reflog ("branch: Created from ..."), else undefined. */
function reflogCreationIso(runGit: GitRunner, repoPath: string, branch: string): string | undefined {
  if (branch === "unknown") return undefined;
  let raw: string;
  try {
    // With --date=iso-strict, %gd renders as "branch@{<iso-timestamp>}".
    raw = runGit(repoPath, ["reflog", "show", "--date=iso-strict", `--format=%gd${SEP}%gs`, branch]);
  } catch {
    return undefined; // no reflog for this ref (fresh clone / remote-tracking ref)
  }
  for (const line of raw.split("\n")) {
    if (!line.includes(SEP)) continue;
    const [selector, subject] = line.split(SEP);
    if (selector === undefined || subject === undefined) continue;
    if (!subject.includes("branch: Created")) continue;
    const open = selector.indexOf("{");
    const close = selector.lastIndexOf("}");
    if (open < 0 || close <= open) continue;
    const iso = selector.slice(open + 1, close);
    if (Number.isFinite(Date.parse(iso))) return iso;
  }
  return undefined;
}

/** Shortest ref names pointing at each sha (deterministic: lexicographically smallest wins). */
function refTips(runGit: GitRunner, repoPath: string): Map<string, string> {
  let raw: string;
  try {
    raw = runGit(repoPath, ["for-each-ref", `--format=%(refname:short)${SEP}%(objectname)`, "refs/heads", "refs/remotes"]);
  } catch {
    return new Map();
  }
  const tips = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line.includes(SEP)) continue;
    const [name, sha] = line.split(SEP);
    if (!name || !sha) continue;
    const existing = tips.get(sha);
    if (existing === undefined || name < existing) tips.set(sha, name);
  }
  return tips;
}

/** PR-head ref for a squash-merged PR number, when one exists locally (GitHub/Forgejo-style). */
function prHeadRef(runGit: GitRunner, repoPath: string, prNumber: number): string | undefined {
  for (const pattern of [`refs/pull/${prNumber}/head`, `refs/merge-requests/${prNumber}/head`]) {
    try {
      const out = runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${pattern}^{commit}`]);
      if (out.trim().length > 0) return pattern;
    } catch {
      // ref absent — try the next pattern
    }
  }
  return undefined;
}

// ---- Matching (join mode) --------------------------------------------------

/** Which identity key joined an estimate to a unit. */
export type MineGitMatchKey = "branch" | "issue_ref" | "task_label";

/** Identity keys read off an estimate's inputs, in precedence order. */
interface EstimateKeys {
  branch?: string;
  issueRef?: string;
  taskLabel?: string;
}

function estimateKeys(estimate: EstimateRecord): EstimateKeys {
  const inputs = estimate.inputs ?? {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
  return {
    branch: str(inputs["branch"]),
    issueRef: str(inputs["issue_ref"]),
    taskLabel: str(inputs["task_label"]),
  };
}

/** Shortest path segment of a branch name ("pm/deflake-x" → "deflake-x"; "deflake-x" → "deflake-x"). */
function branchTail(branch: string): string {
  const idx = branch.lastIndexOf("/");
  return idx >= 0 ? branch.slice(idx + 1) : branch;
}

/** Exact branch match: full name, tail segment, or boundary-aware suffix either direction. */
function branchMatches(inputBranch: string, unitBranch: string): boolean {
  if (inputBranch === unitBranch) return true;
  const tail = branchTail(unitBranch);
  if (inputBranch === tail) return true;
  if (unitBranch.endsWith(`/${inputBranch}`) || inputBranch.endsWith(`/${tail}`)) return true;
  return false;
}

/** Pull the trailing integer out of an issue/PR reference: "#63", "63", "refs #63", ".../pull/63". */
function refNumber(raw: string): number | undefined {
  const match = raw.match(/(\d+)\s*$/);
  return match ? Number(match[1]) : undefined;
}

/** Normalized significant tokens for task_label fuzzy matching. */
const MATCH_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "pull", "request", "merge", "this", "that",
  "fix", "feat", "chore", "docs", "test", "refactor", "task", "work", "branch", "pr",
]);

function significantTokens(raw: string): Set<string> {
  return new Set(
    raw
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !MATCH_STOPWORDS.has(t)),
  );
}

/**
 * task_label match: at least 2 shared significant tokens against the unit's
 * title+branch, or normalized containment. Deliberately conservative — a
 * false join poisons one calibration pair, a missed join only leaves an
 * estimate pending.
 */
function taskLabelMatches(taskLabel: string, unit: GitWorkUnit): boolean {
  const labelTokens = significantTokens(taskLabel);
  if (labelTokens.size === 0) return false;
  const unitTokens = significantTokens(`${unit.title} ${branchTail(unit.branch)}`);
  let shared = 0;
  for (const t of labelTokens) if (unitTokens.has(t)) shared++;
  if (shared >= 2) return true;
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const nLabel = normalize(taskLabel);
  const nUnit = normalize(`${unit.title}`);
  return nLabel.length >= 8 && (nUnit.includes(nLabel) || normalize(branchTail(unit.branch)).includes(nLabel));
}

interface UnitMatch {
  unit: GitWorkUnit;
  key: MineGitMatchKey;
}

/** Best unit for one estimate: highest-precedence key wins, then newest merge. */
function bestUnitForEstimate(keys: EstimateKeys, units: readonly GitWorkUnit[]): UnitMatch | undefined {
  let best: UnitMatch | undefined;
  for (const unit of units) {
    let key: MineGitMatchKey | undefined;
    if (keys.branch && branchMatches(keys.branch, unit.branch)) key = "branch";
    else if (keys.issueRef !== undefined && unit.prNumber !== undefined && refNumber(keys.issueRef) === unit.prNumber) key = "issue_ref";
    else if (keys.taskLabel && taskLabelMatches(keys.taskLabel, unit)) key = "task_label";
    if (key === undefined) continue;
    const candidate: UnitMatch = { unit, key };
    if (
      best === undefined ||
      keyPrecedence(key) > keyPrecedence(best.key) ||
      (keyPrecedence(key) === keyPrecedence(best.key) && candidate.unit.mergeAt > best.unit.mergeAt)
    ) {
      best = candidate;
    }
  }
  return best;
}

function keyPrecedence(key: MineGitMatchKey): number {
  switch (key) {
    case "branch":
      return 3;
    case "issue_ref":
      return 2;
    case "task_label":
      return 1;
  }
}

// ---- Window computation + report -------------------------------------------

export type MineGitWindow = "dev" | "review-inclusive";

export type MineGitSkipReason =
  | "no_dev_window"
  | "no_open_anchor"
  | "non_positive_window"
  | "git_derived_out_of_bounds"
  | "duplicate"
  | "write_failed";

export type MineGitUnmatchedReason = "no_units" | "no_match";

export interface MineGitSkipped {
  readonly estimateId: string;
  readonly reason: MineGitSkipReason;
  readonly hours?: number;
  readonly unitBranch?: string;
}

export interface MineGitUnmatched {
  readonly estimateId: string;
  readonly reason: MineGitUnmatchedReason;
  /** Identity keys present on the estimate (what the matcher had to work with). */
  readonly keysTried: { branch?: boolean; issue_ref?: boolean; task_label?: boolean };
}

export interface MineGitRecorded {
  readonly estimateId: string;
  readonly unitBranch: string;
  readonly prNumber?: number;
  readonly matchedBy: MineGitMatchKey;
  readonly hours: number;
  /** Provenance stamp persisted on the actual. */
  readonly provenance: "git_derived" | "git_derived_review_inclusive";
  /** The OTHER window's value (surfaced in the notes; never blended into the actual). */
  readonly otherWindowHours: number | null;
}

/** Cycle-time quantiles for ONE window — dev and review-inclusive are reported separately, never pooled. */
export interface CycleTimeSummary {
  readonly n: number;
  readonly p50: number | null;
  readonly p80: number | null;
  readonly p95: number | null;
}

export interface MineGitResult {
  readonly repo: string;
  readonly since: string;
  readonly window: MineGitWindow;
  readonly dryRun: boolean;
  readonly units: {
    readonly scanned: number;
    readonly byKind: Readonly<Record<GitWorkUnitKind, number>>;
    readonly withDevWindow: number;
    readonly withReviewInclusiveWindow: number;
  };
  readonly estimates: {
    readonly pending: number;
    readonly matched: number;
    readonly recorded: number;
    readonly skippedByReason: Readonly<Record<string, number>>;
    readonly unmatchedByReason: Readonly<Record<string, number>>;
  };
  /** Per-window cycle-time quantiles over ALL mined units (not just matched ones). Reported separately, never blended. */
  readonly cycleTimes: {
    readonly dev: CycleTimeSummary;
    readonly reviewInclusive: CycleTimeSummary;
  };
  /**
   * S1.2 bootstrap: engaged only when the estimates ledger was empty at run
   * start — the minted reference-class baseline pairs that give the
   * self-improvement loop a cold-start corpus instead of starving it.
   */
  readonly bootstrap: MineGitBootstrap;
  readonly recorded: readonly MineGitRecorded[];
  readonly skipped: readonly MineGitSkipped[];
  readonly unmatched: readonly MineGitUnmatched[];
  readonly summary: string;
}

function hoursBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return NaN;
  return (end - start) / 3_600_000;
}

/** A window only exists when it is finite and strictly positive — anything else (negative span, unparseable anchor) is "not derivable". */
function windowHours(startIso: string | undefined, endIso: string): number | undefined {
  if (startIso === undefined) return undefined;
  const hours = hoursBetween(startIso, endIso);
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

/** Nearest-rank quantile of a sorted ascending array (1-based rank). */
function quantile(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil(q * sortedAsc.length)));
  const value = sortedAsc[rank - 1];
  return value === undefined ? null : Math.round(value * 100) / 100;
}

function summarize(sortedAsc: readonly number[]): CycleTimeSummary {
  return {
    n: sortedAsc.length,
    p50: quantile(sortedAsc, 0.5),
    p80: quantile(sortedAsc, 0.8),
    p95: quantile(sortedAsc, 0.95),
  };
}

function provenanceForWindow(window: MineGitWindow): "git_derived" | "git_derived_review_inclusive" {
  return window === "dev" ? "git_derived" : "git_derived_review_inclusive";
}

// ---- Bootstrap mode (S1.2) ---------------------------------------------------

export type MineGitBootstrapSkipReason =
  | "no_dev_window"
  | "no_open_anchor"
  | "no_baseline"
  | "git_derived_out_of_bounds"
  | "mint_failed"
  | "write_failed";

/** One minted reference-class baseline pair (estimate row + git-derived actual). */
export interface MineGitBootstrapRecorded {
  readonly unitBranch: string;
  readonly prNumber?: number;
  readonly taskType: string;
  /** The recorded baseline estimate (medium scope, no correction applied — cold start). */
  readonly baselineHours: number;
  readonly hours: number;
  readonly provenance: "git_derived" | "git_derived_review_inclusive";
  /** The OTHER window's value (surfaced in the notes; never blended into the actual). */
  readonly otherWindowHours: number | null;
  /** Ledger id of the minted estimate row (absent in dry runs). */
  readonly estimateId?: string;
}

export interface MineGitBootstrap {
  /** True only when the estimates ledger was empty at run start (the no-ledger-history gate). */
  readonly engaged: boolean;
  readonly unitsConsidered: number;
  readonly recorded: number;
  readonly skippedByReason: Readonly<Record<string, number>>;
  readonly entries: readonly MineGitBootstrapRecorded[];
}

/**
 * Conventional-commit / branch-prefix task-type inference for bootstrap
 * baseline selection. Conservative by design: an unrecognized unit defaults
 * to "feature" (the reference-class fallback everywhere else), because a
 * misfiled unit shifts which baseline it is compared against.
 */
const CONVENTIONAL_TASK_TYPES: ReadonlyArray<readonly [RegExp, TaskType]> = [
  [/^(fix|bugfix|hotfix)\b/i, "bugfix"],
  [/^(feat|feature)\b/i, "feature"],
  [/^(docs?|documentation)\b/i, "documentation"],
  [/^refactor\b/i, "refactor"],
  [/^(tests?|spec)\b/i, "testing"],
  [/^(chore|build|ci|perf|deps|infra)\b/i, "infrastructure"],
  [/^(migration|migrate)\b/i, "migration"],
];

function bootstrapTaskTypeForUnit(unit: GitWorkUnit): TaskType {
  const candidates = [unit.title, unit.branch, branchTail(unit.branch)];
  for (const [pattern, taskType] of CONVENTIONAL_TASK_TYPES) {
    for (const candidate of candidates) {
      if (pattern.test(candidate.trim())) return taskType;
    }
  }
  return "feature";
}

/**
 * Bootstrap baseline: the reference-class MEDIUM-scope baseline for the task
 * type, i.e. what reference_class_estimate would raw-estimate for a typical
 * complexity-3 task of that class (COMPLEXITY_MULTIPLIER[3] = 1.0). No
 * correction factor is applied — the corpus being minted IS the data a
 * future correction factor would be learned from.
 */
function bootstrapBaselineHours(taskType: TaskType): number | null {
  const baselines = getScopeBaseline(taskType);
  return baselines ? baselines.medium : null;
}

/** Deterministic audit/dedupe key for one mined unit. */
function bootstrapUnitKey(unit: GitWorkUnit): string {
  return `${unit.kind}:${unit.prNumber !== undefined ? `pr-${unit.prNumber}` : unit.branch}@${unit.mergeAt}`;
}

function runBootstrapMode(units: readonly GitWorkUnit[], window: MineGitWindow, dryRun: boolean): MineGitBootstrap {
  // The no-ledger-history gate: any estimate row at all means the repo is no
  // longer cold and bootstrap must not mint rows next to real history.
  if (readLines<EstimateRecord>(ESTIMATES_FILE).length > 0) {
    return { engaged: false, unitsConsidered: 0, recorded: 0, skippedByReason: {}, entries: [] };
  }

  const entries: MineGitBootstrapRecorded[] = [];
  const skippedByReason: Record<string, number> = {};
  const skip = (reason: MineGitBootstrapSkipReason): void => {
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
  };

  for (const unit of units) {
    const devWindowHours = windowHours(unit.firstCommitAt, unit.mergeAt);
    const reviewWindowHours = windowHours(unit.openAt, unit.mergeAt);
    const selectedHours = window === "dev" ? devWindowHours : reviewWindowHours;
    const otherWindowHours = window === "dev" ? (reviewWindowHours ?? null) : (devWindowHours ?? null);

    if (selectedHours === undefined || !Number.isFinite(selectedHours)) {
      skip(window === "dev" ? "no_dev_window" : "no_open_anchor");
      continue;
    }

    const taskType = bootstrapTaskTypeForUnit(unit);
    const baselineHours = bootstrapBaselineHours(taskType);
    if (baselineHours === null || !(baselineHours > 0)) {
      skip("no_baseline");
      continue;
    }

    // Same sanity gate as join mode (bounds + two-sided 10x ratio against the
    // recorded estimate side) — the three-seam defense never widens for bootstrap.
    if (!isGitDerivedSane(selectedHours, baselineHours)) {
      skip("git_derived_out_of_bounds");
      continue;
    }

    if (dryRun) {
      entries.push({
        unitBranch: unit.branch,
        ...(unit.prNumber !== undefined && { prNumber: unit.prNumber }),
        taskType,
        baselineHours,
        hours: selectedHours,
        provenance: provenanceForWindow(window),
        otherWindowHours,
      });
      continue;
    }

    // Estimate side: the reference-class baseline the tool would have
    // recorded, stamped with task_type/scope and the audit key. The recorded
    // value is correctedEstimate (extractEstimatedHours's basis for this
    // tool) = the RAW baseline — future learned ratios therefore calibrate
    // exactly how this repo's cycle times deviate from the shipped baseline.
    const estimateId = recordEstimate(
      "reference_class_estimate",
      { task_type: taskType, complexity: 3, scope: "medium", [MINE_GIT_BOOTSTRAP_UNIT_KEY]: bootstrapUnitKey(unit) },
      { correctedEstimate: baselineHours, correctionFactor: 1.0, baselineSource: "bootstrap_scope_medium_real_tasks", sampleSize: 0 },
      "mine-git-bootstrap",
    );
    if (estimateId === null) {
      skip("mint_failed");
      continue;
    }

    const windowLabel =
      window === "dev"
        ? `dev window first-commit→merge ${round2(selectedHours)}h`
        : `review-inclusive window open→merge ${round2(selectedHours)}h`;
    const otherLabel = otherWindowHours !== null
      ? `; other window (${window === "dev" ? "open→merge" : "first-commit→merge"}) ${round2(otherWindowHours)}h reported separately, not blended`
      : "; other window not locally derivable";
    const note =
      `${MINE_GIT_BOOTSTRAP_NOTE_PREFIX} — ${unit.kind}${unit.prNumber !== undefined ? ` #${unit.prNumber}` : ""} branch ${unit.branch}: ` +
      `estimate side is the tool-minted reference-class medium-scope baseline for "${taskType}" (${round2(baselineHours)}h, supplementary scope table, no correction applied — cold start), ` +
      `not a human/agent estimate; actual side is ${windowLabel}${otherLabel}.`;

    const result = recordActualDetailed(estimateId, selectedHours, note, undefined, provenanceForWindow(window));
    if (result.ok) {
      entries.push({
        unitBranch: unit.branch,
        ...(unit.prNumber !== undefined && { prNumber: unit.prNumber }),
        taskType,
        baselineHours,
        hours: selectedHours,
        provenance: provenanceForWindow(window),
        otherWindowHours,
        estimateId,
      });
    } else if (result.reason === "git_derived_out_of_bounds") {
      skip("git_derived_out_of_bounds");
    } else {
      skip("write_failed");
    }
  }

  return {
    engaged: true,
    unitsConsidered: units.length,
    recorded: entries.length,
    skippedByReason,
    entries,
  };
}

export interface MineGitOptions {
  readonly repo: string;
  /** ISO date or YYYY-MM-DD — passed to git log --since (commit-date cutoff). */
  readonly since: string;
  readonly dryRun?: boolean;
  readonly window?: MineGitWindow;
  /** Injectable for tests; defaults to the offline-enforced shell runner. */
  readonly runGit?: GitRunner;
}

/**
 * Mine local git history and record git-derived actuals for matching pending
 * estimates. Throws MineGitError for caller-fixable setup problems (missing
 * repo, invalid --since); per-estimate failures are reported, never thrown.
 */
export function runMineGit(options: MineGitOptions): MineGitResult {
  const { repo, since } = options;
  const dryRun = options.dryRun ?? false;
  const window: MineGitWindow = options.window ?? "dev";
  const runGit = options.runGit ?? defaultGitRunner;

  if (!existsSync(repo)) {
    throw new MineGitError(`--repo path does not exist: ${repo}`);
  }
  if (Number.isNaN(Date.parse(since))) {
    throw new MineGitError(`--since must be a valid date (ISO or YYYY-MM-DD), got "${since}"`);
  }
  try {
    runGit(repo, ["rev-parse", "--git-dir"]);
  } catch {
    throw new MineGitError(`--repo is not a git repository (git rev-parse --git-dir failed): ${repo}`);
  }

  const units = mineWorkUnits(runGit, repo, since);

  // Cycle-time quantiles per window over all units — separate populations.
  const devHours = units
    .map((u) => windowHours(u.firstCommitAt, u.mergeAt))
    .filter((h): h is number => h !== undefined)
    .sort((a, b) => a - b);
  const reviewHours = units
    .map((u) => windowHours(u.openAt, u.mergeAt))
    .filter((h): h is number => h !== undefined)
    .sort((a, b) => a - b);

  const pending = getPendingEstimates(PENDING_FETCH_LIMIT);

  // Bootstrap (S1.2): on an empty ledger there is nothing to join, so mine
  // the cold-start corpus instead. Mutually exclusive with join mode by
  // construction — an empty ledger implies zero pending estimates.
  const bootstrap = runBootstrapMode(units, window, dryRun);

  const recorded: MineGitRecorded[] = [];
  const skipped: MineGitSkipped[] = [];
  const unmatched: MineGitUnmatched[] = [];

  for (const estimate of pending) {
    const keys = estimateKeys(estimate);
    const match = bestUnitForEstimate(keys, units);
    if (!match) {
      unmatched.push({
        estimateId: estimate.id,
        reason: units.length === 0 ? "no_units" : "no_match",
        keysTried: { branch: keys.branch !== undefined, issue_ref: keys.issueRef !== undefined, task_label: keys.taskLabel !== undefined },
      });
      continue;
    }

    const { unit } = match;
    const devWindowHours = windowHours(unit.firstCommitAt, unit.mergeAt);
    const reviewWindowHours = windowHours(unit.openAt, unit.mergeAt);

    const selectedHours = window === "dev" ? devWindowHours : reviewWindowHours;
    const otherWindowHours = window === "dev" ? (reviewWindowHours ?? null) : (devWindowHours ?? null);

    if (selectedHours === undefined || !Number.isFinite(selectedHours)) {
      skipped.push({
        estimateId: estimate.id,
        reason: window === "dev" ? "no_dev_window" : "no_open_anchor",
        unitBranch: unit.branch,
      });
      continue;
    }
    if (selectedHours <= 0) {
      skipped.push({ estimateId: estimate.id, reason: "non_positive_window", hours: selectedHours, unitBranch: unit.branch });
      continue;
    }

    const estimatedHours = extractEstimatedHours(estimate.outputs);
    if (!isGitDerivedSane(selectedHours, estimatedHours)) {
      skipped.push({ estimateId: estimate.id, reason: "git_derived_out_of_bounds", hours: selectedHours, unitBranch: unit.branch });
      continue;
    }

    if (dryRun) {
      recorded.push({
        estimateId: estimate.id,
        unitBranch: unit.branch,
        ...(unit.prNumber !== undefined && { prNumber: unit.prNumber }),
        matchedBy: match.key,
        hours: selectedHours,
        provenance: provenanceForWindow(window),
        otherWindowHours,
      });
      continue;
    }

    const windowLabel =
      window === "dev"
        ? `dev window first-commit→merge ${round2(selectedHours)}h`
        : `review-inclusive window open→merge ${round2(selectedHours)}h`;
    const otherLabel = otherWindowHours !== null
      ? `; other window (${window === "dev" ? "open→merge" : "first-commit→merge"}) ${round2(otherWindowHours)}h reported separately, not blended`
      : "; other window not locally derivable";
    const note =
      `${MINE_GIT_NOTE_PREFIX} — ${unit.kind}${unit.prNumber !== undefined ? ` #${unit.prNumber}` : ""} branch ${unit.branch}: ${windowLabel}${otherLabel}.`;

    const result = recordActualDetailed(estimate.id, selectedHours, note, undefined, provenanceForWindow(window));
    if (result.ok) {
      recorded.push({
        estimateId: estimate.id,
        unitBranch: unit.branch,
        ...(unit.prNumber !== undefined && { prNumber: unit.prNumber }),
        matchedBy: match.key,
        hours: selectedHours,
        provenance: provenanceForWindow(window),
        otherWindowHours,
      });
    } else if (result.reason === "duplicate") {
      // Structurally unreachable via getPendingEstimates (pending = no
      // actual), kept for the same race window auto-actuals documents: a
      // concurrent writer actualed the estimate between selection and write.
      skipped.push({ estimateId: estimate.id, reason: "duplicate", hours: selectedHours, unitBranch: unit.branch });
    } else if (result.reason === "git_derived_out_of_bounds") {
      skipped.push({ estimateId: estimate.id, reason: "git_derived_out_of_bounds", hours: selectedHours, unitBranch: unit.branch });
    } else {
      skipped.push({ estimateId: estimate.id, reason: "write_failed", hours: selectedHours, unitBranch: unit.branch });
    }
  }

  const byKind: Record<GitWorkUnitKind, number> = { merge_commit_pr: 0, squash_pr: 0, merged_branch: 0 };
  for (const u of units) byKind[u.kind] += 1;
  const skippedByReason: Record<string, number> = {};
  for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  const unmatchedByReason: Record<string, number> = {};
  for (const u of unmatched) unmatchedByReason[u.reason] = (unmatchedByReason[u.reason] ?? 0) + 1;

  const matched = recorded.length + skipped.length;
  const verb = dryRun ? "would record" : "recorded";
  const bootstrapSummary = bootstrap.engaged
    ? ` Bootstrap mode engaged (estimates ledger empty): ${bootstrap.recorded} reference-class baseline pair(s) ${verb} ` +
      `(estimate = reference_class_estimate medium-scope baseline for the inferred task type, no correction applied — cold start; ` +
      `actual = ${window}-window cycle time, provenance ${provenanceForWindow(window)}; ` +
      `git-derived and verified counts stay dual-labeled in estimate outputs, never blended).`
    : "";
  const summary =
    `mine-git: ${units.length} closed work unit(s) since ${since} ` +
    `(${byKind.merge_commit_pr} merge-commit PR, ${byKind.squash_pr} squash PR, ${byKind.merged_branch} plain merge; ` +
    `${devHours.length} with dev window, ${reviewHours.length} with review-inclusive window). ` +
    `${pending.length} pending estimate(s): ${recorded.length} ${verb} (${window} window, provenance ${provenanceForWindow(window)}), ` +
    `${skipped.length} skipped, ${unmatched.length} unmatched. ` +
    `Cycle-time quantiles reported per window, never blended — dev n=${devHours.length} p50=${summarize(devHours).p50 ?? "n/a"}h; ` +
    `review-inclusive n=${reviewHours.length} p50=${summarize(reviewHours).p50 ?? "n/a"}h. ` +
    `Sanity bounds [${GIT_DERIVED_MIN_HOURS}h, ${GIT_DERIVED_MAX_HOURS}h] with ${GIT_DERIVED_RATIO_LIMIT}x estimate-ratio limit.` +
    bootstrapSummary +
    (dryRun ? " Dry run — nothing written." : "");

  return {
    repo,
    since,
    window,
    dryRun,
    units: {
      scanned: units.length,
      byKind,
      withDevWindow: devHours.length,
      withReviewInclusiveWindow: reviewHours.length,
    },
    estimates: {
      pending: pending.length,
      matched,
      recorded: recorded.length,
      skippedByReason,
      unmatchedByReason,
    },
    cycleTimes: { dev: summarize(devHours), reviewInclusive: summarize(reviewHours) },
    bootstrap,
    recorded,
    skipped,
    unmatched,
    summary,
  };
}

function round2(h: number): number {
  return Math.round(h * 100) / 100;
}

// ---- Unit mining internals ---------------------------------------------------

/** Mine closed work units from local git history since a date (offline, read-only). */
export function mineWorkUnits(runGit: GitRunner, repoPath: string, since: string): GitWorkUnit[] {
  const logFormat = `--format=%H${SEP}%P${SEP}%cI${SEP}%aI${SEP}%s`;

  const mergeRaw = runGit(repoPath, ["log", "--merges", `--since=${since}`, logFormat]);
  const squashRaw = runGit(repoPath, ["log", "--no-merges", `--since=${since}`, logFormat]);

  const tips = refTips(runGit, repoPath);
  const units: GitWorkUnit[] = [];

  for (const row of parseLogRows(mergeRaw)) {
    if (row.parentShas.length < 2) continue; // root/regular commit misparsed as merge — skip
    const firstParent = row.parentShas[0];
    const secondParent = row.parentShas[1];
    if (firstParent === undefined || secondParent === undefined) continue;
    // Branch-only commits of the merge: reachable from the second parent,
    // not from the base the branch landed on.
    const range = `${firstParent}..${secondParent}`;

    const forgejo = FORGEJO_MERGE_RE.exec(row.subject);
    const github = GITHUB_MERGE_RE.exec(row.subject);
    if (forgejo && forgejo[1] !== undefined && forgejo[2] !== undefined && forgejo[3] !== undefined) {
      units.push(
        buildUnit(runGit, repoPath, {
          kind: "merge_commit_pr",
          prNumber: Number(forgejo[2]),
          branch: forgejo[3],
          title: forgejo[1],
          mergeAt: row.committerIso,
          range,
          branchTip: secondParent,
        }),
      );
    } else if (github && github[1] !== undefined && github[2] !== undefined) {
      const rawBranch = github[2];
      units.push(
        buildUnit(runGit, repoPath, {
          kind: "merge_commit_pr",
          prNumber: Number(github[1]),
          branch: rawBranch.includes("/") ? rawBranch.slice(rawBranch.indexOf("/") + 1) : rawBranch,
          title: row.subject,
          mergeAt: row.committerIso,
          range,
          branchTip: secondParent,
        }),
      );
    } else {
      units.push(
        buildUnit(runGit, repoPath, {
          kind: "merged_branch",
          branch: tips.get(secondParent) ?? "unknown",
          title: row.subject,
          mergeAt: row.committerIso,
          range,
          branchTip: secondParent,
        }),
      );
    }
  }

  for (const row of parseLogRows(squashRaw)) {
    const squash = SQUASH_PR_RE.exec(row.subject);
    if (!squash || squash[1] === undefined) continue;
    const prNumber = Number(squash[1]);
    units.push(
      buildUnit(runGit, repoPath, {
        kind: "squash_pr",
        prNumber,
        branch: tips.get(row.sha) ?? `pr-${prNumber}`,
        title: row.subject,
        mergeAt: row.committerIso,
        // Dev window only when the PR head ref survived locally: rev-list
        // squash^..refs/pull/N/head approximates the branch-only commits.
        range: prHeadRefRange(runGit, repoPath, prNumber, row.sha),
      }),
    );
  }

  // Deterministic order + dedupe: one unit per PR number (newest merge wins),
  // plain merges kept per second-parent sha.
  units.sort((a, b) => b.mergeAt.localeCompare(a.mergeAt));
  const seenPr = new Set<number>();
  const seenTip = new Set<string>();
  const deduped: GitWorkUnit[] = [];
  for (const u of units) {
    if (u.prNumber !== undefined) {
      if (seenPr.has(u.prNumber)) continue;
      seenPr.add(u.prNumber);
    } else {
      const tip = u.branch;
      if (tip !== "unknown") {
        if (seenTip.has(tip)) continue;
        seenTip.add(tip);
      }
    }
    deduped.push(u);
  }
  return deduped;
}

/** PR-head commit range for a squash-merged PR when a head ref survived locally, else undefined. */
function prHeadRefRange(runGit: GitRunner, repoPath: string, prNumber: number, squashSha: string): string | undefined {
  const headRef = prHeadRef(runGit, repoPath, prNumber);
  return headRef !== undefined ? `${squashSha}^..${headRef}` : undefined;
}

interface UnitSeed {
  readonly kind: GitWorkUnitKind;
  readonly prNumber?: number;
  readonly branch: string;
  readonly title: string;
  readonly mergeAt: string;
  /** Commit range listing the unit's branch-only commits (author dates). */
  readonly range?: string;
  /** Branch tip sha (second parent) — reserved for callers that need tip identity. */
  readonly branchTip?: string;
}

function buildUnit(runGit: GitRunner, repoPath: string, seed: UnitSeed): GitWorkUnit {
  const dates = seed.range ? authorDatesInRange(runGit, repoPath, seed.range) : [];
  const firstCommitAt = dates[0];
  const lastCommitAt = dates[dates.length - 1];
  const openAt = reflogCreationIso(runGit, repoPath, seed.branch);
  return {
    kind: seed.kind,
    ...(seed.prNumber !== undefined && { prNumber: seed.prNumber }),
    branch: seed.branch,
    title: seed.title,
    mergeAt: seed.mergeAt,
    ...(firstCommitAt !== undefined && { firstCommitAt }),
    ...(lastCommitAt !== undefined && { lastCommitAt }),
    ...(openAt !== undefined && { openAt }),
    commitCount: dates.length,
  };
}
