// ---------------------------------------------------------------------------
// S1.1 mine-git — unit coverage (fake git runner) + real-git e2e.
//
// Mirrors auto-actuals.test.ts's pattern: a real EPOCH_DATA_DIR (never the
// live ~/.epoch), direct JSONL fixture writes, and — beyond the auto-actuals
// suite — a real throwaway git repository so the mining path is exercised
// against actual git, not a mock of it.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(tmpdir(), `epoch-mine-git-${process.pid}`);
const GIT_REPO_DIR = join(TEST_DIR, "repo");

const SEP = "\u001f";

function estimatesPath(): string {
  return join(TEST_DIR, "estimates.jsonl");
}

function feedbackPath(): string {
  return join(TEST_DIR, "feedback.jsonl");
}

function writeEstimates(records: Array<Record<string, unknown>>): void {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(estimatesPath(), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function readActuals(): Array<Record<string, unknown>> {
  try {
    return readFileSync(feedbackPath(), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function actualFor(estimateId: string): Record<string, unknown> | undefined {
  return readActuals().find((a) => a["estimateId"] === estimateId);
}

// ---- Fake git runner ---------------------------------------------------------

interface FakeGitWorld {
  merges: string[];
  nonMerges: string[];
  refs: string; // for-each-ref output
  reflogs: Map<string, string>; // branch -> reflog output
  prHeadRefs: Set<string>; // refs/pull/N/head values that exist
}

function fakeGitRunner(world: FakeGitWorld) {
  return (repoPath: string, args: string[]): string => {
    expect(repoPath).toBe(GIT_REPO_DIR);
    const verb = args.find((a) => !a.startsWith("-"));
    if (verb === "rev-parse") {
      const refArg = args[args.length - 1];
      if (refArg !== undefined && refArg.includes("/pull/") && !world.prHeadRefs.has(refArg.replace(/\^\{commit\}$/, ""))) {
        throw new Error("unknown revision");
      }
      return ".git\n";
    }
    if (verb === "log") {
      const merges = args.includes("--merges");
      const raw = merges ? world.merges : world.nonMerges;
      // honor --since crudely: rows carry ISO dates; the fake world is small
      // enough that tests control dates directly. We still accept the flag.
      return raw.join("\n") + (raw.length > 0 ? "\n" : "");
    }
    if (verb === "for-each-ref") return world.refs;
    if (verb === "reflog") {
      for (const [branch, out] of world.reflogs) {
        if (args.includes(branch)) return out;
      }
      throw new Error("no reflog");
    }
    throw new Error(`fake git runner: unexpected verb ${String(verb)}`);
  };
}

/** Build one git log row in the miner's --format shape. */
function commitRow(opts: {
  sha: string;
  parents: string[];
  authorIso: string;
  committerIso?: string;
  subject: string;
}): string {
  return [opts.sha, opts.parents.join(" "), opts.committerIso ?? opts.authorIso, opts.authorIso, opts.subject].join(SEP);
}

/** Merge-commit row + the branch-commit rows its rev-list range returns. */
function forgejoMergeUnit(opts: {
  mergeSha: string;
  baseSha: string;
  tipSha: string;
  prNumber: number;
  branch: string;
  title: string;
  mergedAt: string;
  branchCommits: Array<{ sha: string; at: string }>;
}): { merges: string[]; rangeLog: Map<string, string[]> } {
  const mergeRow = commitRow({
    sha: opts.mergeSha,
    parents: [opts.baseSha, opts.tipSha],
    committerIso: opts.mergedAt,
    authorIso: opts.mergedAt,
    subject: `Merge pull request '${opts.title}' (#${opts.prNumber}) from ${opts.branch} into main`,
  });
  const rangeKey = `${opts.baseSha}..${opts.tipSha}`;
  const rangeLog = new Map<string, string[]>([
    [rangeKey, opts.branchCommits.map((c) => `${c.at}`)],
  ]);
  return { merges: [mergeRow], rangeLog };
}

/** A fake runner variant that also answers `log --format=%aI <range>` from a map. */
function rangeAwareRunner(world: FakeGitWorld, ranges: Map<string, string[]>) {
  const base = fakeGitRunner(world);
  return (repoPath: string, args: string[]): string => {
    const rangeArg = args.find((a) => a.includes(".."));
    if (rangeArg !== undefined && ranges.has(rangeArg)) {
      return (ranges.get(rangeArg) ?? []).join("\n") + "\n";
    }
    return base(repoPath, args);
  };
}

// ---- Real git fixture ---------------------------------------------------------

function git(cwd: string, cmd: string, dates?: { author?: string; committer?: string }): void {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env["GIT_AUTHOR_NAME"] = "Miner Test";
  env["GIT_AUTHOR_EMAIL"] = "miner@test.local";
  env["GIT_COMMITTER_NAME"] = "Miner Test";
  env["GIT_COMMITTER_EMAIL"] = "miner@test.local";
  if (dates?.author) env["GIT_AUTHOR_DATE"] = dates.author;
  if (dates?.committer) env["GIT_COMMITTER_DATE"] = dates.committer;
  execSync(`git ${cmd}`, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
}

function buildRealRepo(): void {
  rmSync(GIT_REPO_DIR, { recursive: true, force: true });
  mkdirSync(GIT_REPO_DIR, { recursive: true });
  git(GIT_REPO_DIR, "init -b main");
  git(GIT_REPO_DIR, 'commit --allow-empty -m "root"');

  // Merge-commit PR unit (#101): commits 11:00 and 12:00, merged 14:00.
  git(GIT_REPO_DIR, "checkout -b feat/mining-e2e");
  git(GIT_REPO_DIR, 'commit --allow-empty -m "e2e first"', { author: "2026-09-20T11:00:00+00:00", committer: "2026-09-20T11:00:00+00:00" });
  git(GIT_REPO_DIR, 'commit --allow-empty -m "e2e second"', { author: "2026-09-20T12:00:00+00:00", committer: "2026-09-20T12:00:00+00:00" });
  git(GIT_REPO_DIR, "checkout main");
  git(
    GIT_REPO_DIR,
    `merge --no-ff feat/mining-e2e -m "Merge pull request 'mining e2e' (#101) from feat/mining-e2e into main"`,
    { committer: "2026-09-20T14:00:00+00:00" },
  );

  // Squash-style PR commit (#102): no refs/pull/102/head locally -> no dev window.
  git(
    GIT_REPO_DIR,
    'commit --allow-empty -m "feat: squash-shaped change (#102)"',
    { author: "2026-09-20T15:00:00+00:00", committer: "2026-09-20T15:00:00+00:00" },
  );

  // Plain local merge (no PR number): branch resolved from local refs.
  git(GIT_REPO_DIR, "checkout -b chore/plain-merge");
  git(GIT_REPO_DIR, 'commit --allow-empty -m "plain work"', { author: "2026-09-20T13:00:00+00:00", committer: "2026-09-20T13:00:00+00:00" });
  git(GIT_REPO_DIR, "checkout main");
  git(GIT_REPO_DIR, 'merge --no-ff chore/plain-merge -m "Merge: plain local merge"', {
    committer: "2026-09-20T16:00:00+00:00",
  });
}

// ---- Setup ---------------------------------------------------------------------

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(GIT_REPO_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---- Tests ---------------------------------------------------------------------

describe("mine-git offline guard", () => {
  it("defaultGitRunner structurally refuses network and mutating verbs", async () => {
    const { defaultGitRunner } = await import("./mine-git.js");
    for (const verb of ["fetch", "clone", "push", "pull", "remote", "ls-remote", "reset", "checkout", "commit"]) {
      expect(() => defaultGitRunner(GIT_REPO_DIR, [verb, "origin"])).toThrow(/offline and read-only/);
    }
  });

  it("defaultGitRunner refuses verbs outside the deliberate allowlist", async () => {
    const { defaultGitRunner } = await import("./mine-git.js");
    expect(() => defaultGitRunner(GIT_REPO_DIR, ["blame", "-x"])).toThrow(/allowlist/);
  });

  it("the mining source invokes git with read-only verbs only (offline invariant, call-site scan)", async () => {
    const source = readFileSync(new URL("./mine-git.ts", import.meta.url), "utf8");
    // Every runGit(...) call site names its verb as the first string literal
    // of the args array — scan them all and pin each to the allowlist.
    const callSiteVerbs = source
      .split("\n")
      .filter((l) => l.includes("runGit(repoPath, ["))
      .map((l) => {
        const m = l.match(/runGit\(repoPath, \["([a-z-]+)"/);
        return m?.[1];
      })
      .filter((v): v is string => v !== undefined);
    expect(callSiteVerbs.length).toBeGreaterThanOrEqual(5); // log x2, rev-parse, for-each-ref, reflog
    for (const verb of callSiteVerbs) {
      expect(["log", "rev-list", "rev-parse", "for-each-ref", "reflog", "show", "config", "describe"]).toContain(verb);
    }
  });
});

describe("mine-git join + windows (fake git runner)", () => {
  it("matches by branch (exact and tail) and records a git_derived actual with the dev window", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const unit = forgejoMergeUnit({
      mergeSha: "m1",
      baseSha: "b1",
      tipSha: "t1",
      prNumber: 60,
      branch: "pm/deflake-date-windows-20260915",
      title: "test: deflake order- and date-sensitive tests",
      mergedAt: "2026-09-15T18:46:46Z",
      branchCommits: [
        { sha: "c2", at: "2026-09-15T09:00:00Z" },
        { sha: "c1", at: "2026-09-15T08:00:00Z" },
      ],
    });
    const world: FakeGitWorld = { merges: unit.merges, nonMerges: [], refs: "", reflogs: new Map(), prHeadRefs: new Set() };
    const runGit = rangeAwareRunner(world, unit.rangeLog);

    writeEstimates([
      { id: "est-branch", tool: "pert_estimate", inputs: { branch: "pm/deflake-date-windows-20260915", task_type: "feature" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-15T07:00:00Z" },
      { id: "est-tail", tool: "pert_estimate", inputs: { branch: "deflake-date-windows-20260915", task_type: "feature" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-15T07:00:00Z" },
      { id: "est-none", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-15T07:00:00Z" },
    ]);

    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit });

    expect(result.units.scanned).toBe(1);
    expect(result.units.byKind.merge_commit_pr).toBe(1);
    expect(result.estimates.matched).toBe(2);
    expect(result.estimates.recorded).toBe(2);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]?.reason).toBe("no_match");

    // Dev window: 08:00 -> 18:46:46 = 10.779h
    const recorded = result.recorded.find((r) => r.estimateId === "est-branch");
    expect(recorded).toBeDefined();
    expect(recorded?.hours).toBeCloseTo(10.78, 1);
    expect(recorded?.provenance).toBe("git_derived");
    expect(recorded?.matchedBy).toBe("branch");

    const persisted = actualFor("est-branch");
    expect(persisted?.["calibrationProvenance"]).toBe("git_derived");
    expect((persisted?.["actualHours"] as number)).toBeCloseTo(10.78, 1);
    expect(String(persisted?.["notes"])).toContain("first-commit→merge");
  });

  it("matches by issue_ref against the PR number (#N, N, and URL forms)", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const unit = forgejoMergeUnit({
      mergeSha: "m1", baseSha: "b1", tipSha: "t1", prNumber: 58,
      branch: "fix/epoch-green-baseline", title: "fix: preserve session-first actual matching",
      mergedAt: "2026-09-13T09:00:00Z",
      branchCommits: [{ sha: "c1", at: "2026-09-13T05:00:00Z" }],
    });
    const world: FakeGitWorld = { merges: unit.merges, nonMerges: [], refs: "", reflogs: new Map(), prHeadRefs: new Set() };
    const runGit = rangeAwareRunner(world, unit.rangeLog);

    writeEstimates([
      { id: "est-hash", tool: "pert_estimate", inputs: { issue_ref: "#58" }, outputs: { totalHours: 3 }, estimatedAt: "2026-09-13T04:00:00Z" },
      { id: "est-bare", tool: "pert_estimate", inputs: { issue_ref: "58" }, outputs: { totalHours: 3 }, estimatedAt: "2026-09-13T04:00:00Z" },
      { id: "est-url", tool: "pert_estimate", inputs: { issue_ref: "https://git.example/Epoch/pulls/58" }, outputs: { totalHours: 3 }, estimatedAt: "2026-09-13T04:00:00Z" },
      { id: "est-wrong", tool: "pert_estimate", inputs: { issue_ref: "#57" }, outputs: { totalHours: 3 }, estimatedAt: "2026-09-13T04:00:00Z" },
    ]);

    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit });
    expect(result.estimates.recorded).toBe(3);
    expect(result.recorded.every((r) => r.matchedBy === "issue_ref")).toBe(true);
    expect(result.unmatched.map((u) => u.estimateId)).toEqual(["est-wrong"]);
  });

  it("matches by task_label token overlap but stays conservative", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const unit = forgejoMergeUnit({
      mergeSha: "m1", baseSha: "b1", tipSha: "t1", prNumber: 59,
      branch: "pm/deflake-date-windows-20260915", title: "test: deflake order- and date-sensitive tests",
      mergedAt: "2026-09-15T18:46:46Z",
      branchCommits: [{ sha: "c1", at: "2026-09-15T12:00:00Z" }],
    });
    const world: FakeGitWorld = { merges: unit.merges, nonMerges: [], refs: "", reflogs: new Map(), prHeadRefs: new Set() };
    const runGit = rangeAwareRunner(world, unit.rangeLog);

    writeEstimates([
      // Two significant shared tokens ("deflake", "date"): match.
      { id: "est-label", tool: "pert_estimate", inputs: { task_label: "deflake flaky date window tests" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-15T08:00:00Z" },
      // Only one shared token ("test" is a stopword; "order" alone): no match.
      { id: "est-thin", tool: "pert_estimate", inputs: { task_label: "sort order handling" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-15T08:00:00Z" },
    ]);

    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit });
    expect(result.recorded.map((r) => r.estimateId)).toEqual(["est-label"]);
    expect(result.recorded[0]?.matchedBy).toBe("task_label");
    expect(result.unmatched.map((u) => u.estimateId)).toEqual(["est-thin"]);
  });

  it("branch beats issue_ref beats task_label when several keys would join", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const a = forgejoMergeUnit({
      mergeSha: "ma", baseSha: "b1", tipSha: "ta", prNumber: 10,
      branch: "feat/older", title: "older unit", mergedAt: "2026-09-10T10:00:00Z",
      branchCommits: [{ sha: "ca", at: "2026-09-10T08:00:00Z" }],
    });
    const b = forgejoMergeUnit({
      mergeSha: "mb", baseSha: "b2", tipSha: "tb", prNumber: 20,
      branch: "feat/newer", title: "newer unit", mergedAt: "2026-09-12T10:00:00Z",
      branchCommits: [{ sha: "cb", at: "2026-09-12T08:00:00Z" }],
    });
    const world: FakeGitWorld = { merges: [...a.merges, ...b.merges], nonMerges: [], refs: "", reflogs: new Map(), prHeadRefs: new Set() };
    const ranges = new Map([...a.rangeLog, ...b.rangeLog]);
    const runGit = rangeAwareRunner(world, ranges);

    // Estimate carries branch=feat/newer AND issue_ref=#10 (older unit's PR):
    // branch must win.
    writeEstimates([
      { id: "est-prec", tool: "pert_estimate", inputs: { branch: "feat/newer", issue_ref: "#10" }, outputs: { totalHours: 2 }, estimatedAt: "2026-09-12T07:00:00Z" },
    ]);
    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit });
    expect(result.recorded[0]?.matchedBy).toBe("branch");
    expect(result.recorded[0]?.prNumber).toBe(20);
  });

  it("reports review-inclusive open→merge separately and stamps git_derived_review_inclusive when selected", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const unit = forgejoMergeUnit({
      mergeSha: "m1", baseSha: "b1", tipSha: "t1", prNumber: 61,
      branch: "sync/mirror", title: "sync: reconcile", mergedAt: "2026-09-25T02:51:18Z",
      branchCommits: [{ sha: "c1", at: "2026-09-24T20:00:00Z" }],
    });
    const world: FakeGitWorld = {
      merges: unit.merges, nonMerges: [], refs: "",
      // Branch created 2026-09-24T18:00 — before the first commit.
      reflogs: new Map([["sync/mirror", `sync/mirror@{2026-09-24T18:00:00+00:00}${SEP}branch: Created from HEAD\n`]]),
      prHeadRefs: new Set(),
    };
    const runGit = rangeAwareRunner(world, unit.rangeLog);

    writeEstimates([
      { id: "est-ri", tool: "pert_estimate", inputs: { branch: "sync/mirror" }, outputs: { totalHours: 30 }, estimatedAt: "2026-09-24T17:00:00Z" },
    ]);

    // Default (dev) run: recorded actual = first-commit→merge (6.85h); the
    // review-inclusive value (8.85h) must ride in the notes, never blended.
    const devRun = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit });
    expect(devRun.recorded[0]?.hours).toBeCloseTo(6.85, 1);
    expect(devRun.cycleTimes.dev.n).toBe(1);
    expect(devRun.cycleTimes.reviewInclusive.n).toBe(1);
    expect(devRun.cycleTimes.reviewInclusive.p50).toBeCloseTo(8.85, 1);
    expect(String(actualFor("est-ri")?.["notes"])).toContain("open→merge) 8.86h reported separately, not blended");

    // Review-inclusive run on a fresh estimate: stamp flips, value = open→merge.
    writeEstimates([
      { id: "est-ri2", tool: "pert_estimate", inputs: { branch: "sync/mirror" }, outputs: { totalHours: 30 }, estimatedAt: "2026-09-24T17:00:00Z" },
    ]);
    const riRun = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit, window: "review-inclusive" });
    expect(riRun.recorded[0]?.hours).toBeCloseTo(8.85, 1);
    expect(riRun.recorded[0]?.provenance).toBe("git_derived_review_inclusive");
    expect(actualFor("est-ri2")?.["calibrationProvenance"]).toBe("git_derived_review_inclusive");
  });

  it("drops out-of-bounds windows (0.05–720h and 10x ratio) and counts them in the report", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const tooLong = forgejoMergeUnit({
      mergeSha: "m1", baseSha: "b1", tipSha: "t1", prNumber: 1,
      branch: "feat/slow", title: "slow", mergedAt: "2026-09-25T00:00:00Z",
      branchCommits: [{ sha: "c1", at: "2026-08-01T00:00:00Z" }], // ~55 days -> >720h
    });
    const ratioBlowout = forgejoMergeUnit({
      mergeSha: "m2", baseSha: "b2", tipSha: "t2", prNumber: 2,
      branch: "feat/ratio", title: "ratio", mergedAt: "2026-09-25T00:00:00Z",
      branchCommits: [{ sha: "c3", at: "2026-09-24T12:00:00Z" }], // 12h window...
    });
    const world: FakeGitWorld = { merges: [...tooLong.merges, ...ratioBlowout.merges], nonMerges: [], refs: "", reflogs: new Map(), prHeadRefs: new Set() };
    const ranges = new Map([...tooLong.rangeLog, ...ratioBlowout.rangeLog]);
    const runGit = rangeAwareRunner(world, ranges);

    writeEstimates([
      { id: "est-slow", tool: "pert_estimate", inputs: { branch: "feat/slow" }, outputs: { totalHours: 40 }, estimatedAt: "2026-08-01T00:00:00Z" },
      // 12h actual vs 0.5h estimate = 24x -> ratio gate.
      { id: "est-ratio", tool: "pert_estimate", inputs: { branch: "feat/ratio" }, outputs: { totalHours: 0.5 }, estimatedAt: "2026-09-24T11:00:00Z" },
    ]);

    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-07-01", runGit });
    expect(result.recorded).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["git_derived_out_of_bounds", "git_derived_out_of_bounds"]);
    expect(result.estimates.skippedByReason["git_derived_out_of_bounds"]).toBe(2);
    expect(readActuals()).toEqual([]);
  });

  it("skips squash PRs without a surviving PR-head ref as no_dev_window (merge timestamp only)", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const world: FakeGitWorld = {
      merges: [],
      nonMerges: [
        commitRow({ sha: "sq1", parents: ["p1"], authorIso: "2026-09-24T19:46:32-07:00", subject: "repo-truth: 0.5.2 version train + 26-tool count everywhere (D139/D141 drift) (#213)" }),
      ],
      refs: "",
      reflogs: new Map(),
      prHeadRefs: new Set(),
    };
    const runGit = rangeAwareRunner(world, new Map());
    writeEstimates([
      { id: "est-sq", tool: "pert_estimate", inputs: { issue_ref: "#213" }, outputs: { totalHours: 8 }, estimatedAt: "2026-09-24T18:00:00-07:00" },
    ]);

    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit });
    expect(result.units.byKind.squash_pr).toBe(1);
    expect(result.units.withDevWindow).toBe(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(["no_dev_window"]);
  });

  it("never overwrites a pre-existing (verified) actual — the estimate is not even pending", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const { recordActualDetailed } = await import("./feedback.js");
    const unit = forgejoMergeUnit({
      mergeSha: "m1", baseSha: "b1", tipSha: "t1", prNumber: 5,
      branch: "feat/locked", title: "locked", mergedAt: "2026-09-20T10:00:00Z",
      branchCommits: [{ sha: "c1", at: "2026-09-20T08:00:00Z" }],
    });
    const world: FakeGitWorld = { merges: unit.merges, nonMerges: [], refs: "", reflogs: new Map(), prHeadRefs: new Set() };
    const runGit = rangeAwareRunner(world, unit.rangeLog);

    writeEstimates([
      { id: "est-verified", tool: "pert_estimate", inputs: { branch: "feat/locked" }, outputs: { totalHours: 2 }, estimatedAt: "2026-09-20T07:00:00Z" },
    ]);
    // A human/agent-verified actual recorded BEFORE mining.
    expect(recordActualDetailed("est-verified", 1.5, "hand-verified actual", undefined, "prospective").ok).toBe(true);

    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit });

    // The verified estimate is not pending, so nothing matches it; the
    // pre-existing actual is byte-for-byte unchanged.
    expect(result.estimates.pending).toBe(0);
    const persisted = actualFor("est-verified");
    expect(persisted?.["actualHours"]).toBe(1.5);
    expect(persisted?.["calibrationProvenance"]).toBe("prospective");
    expect(persisted?.["notes"]).toBe("hand-verified actual");
    expect(readActuals()).toHaveLength(1);
  });

  it("dry-run reports matches without writing any actuals", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const unit = forgejoMergeUnit({
      mergeSha: "m1", baseSha: "b1", tipSha: "t1", prNumber: 7,
      branch: "feat/dry", title: "dry", mergedAt: "2026-09-20T10:00:00Z",
      branchCommits: [{ sha: "c1", at: "2026-09-20T08:00:00Z" }],
    });
    const world: FakeGitWorld = { merges: unit.merges, nonMerges: [], refs: "", reflogs: new Map(), prHeadRefs: new Set() };
    const runGit = rangeAwareRunner(world, unit.rangeLog);
    writeEstimates([
      { id: "est-dry", tool: "pert_estimate", inputs: { branch: "feat/dry" }, outputs: { totalHours: 2 }, estimatedAt: "2026-09-20T07:00:00Z" },
    ]);

    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.recorded).toHaveLength(1);
    expect(readActuals()).toEqual([]);
  });

  it("reports unmatched-by-reason with the keys the matcher had to work with", async () => {
    const { runMineGit } = await import("./mine-git.js");
    const unit = forgejoMergeUnit({
      mergeSha: "m1", baseSha: "b1", tipSha: "t1", prNumber: 9,
      branch: "feat/something-else", title: "unrelated", mergedAt: "2026-09-20T10:00:00Z",
      branchCommits: [{ sha: "c1", at: "2026-09-20T08:00:00Z" }],
    });
    const world: FakeGitWorld = { merges: unit.merges, nonMerges: [], refs: "", reflogs: new Map(), prHeadRefs: new Set() };
    const runGit = rangeAwareRunner(world, unit.rangeLog);
    writeEstimates([
      { id: "est-keys", tool: "pert_estimate", inputs: { task_label: "unrelated thing entirely" }, outputs: { totalHours: 2 }, estimatedAt: "2026-09-20T07:00:00Z" },
    ]);
    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-01", runGit });
    expect(result.unmatched[0]?.reason).toBe("no_match");
    expect(result.unmatched[0]?.keysTried).toEqual({ branch: false, issue_ref: false, task_label: true });
    expect(result.estimates.unmatchedByReason["no_match"]).toBe(1);
  });

  it("throws MineGitError for a missing repo or an invalid --since", async () => {
    const { runMineGit, MineGitError } = await import("./mine-git.js");
    const world: FakeGitWorld = { merges: [], nonMerges: [], refs: "", reflogs: new Map(), prHeadRefs: new Set() };
    const runGit = rangeAwareRunner(world, new Map());
    expect(() => runMineGit({ repo: "/nonexistent/repo", since: "2026-09-01", runGit })).toThrow(MineGitError);
    expect(() => runMineGit({ repo: GIT_REPO_DIR, since: "not-a-date", runGit })).toThrow(MineGitError);
  });
});

describe("mine-git sanity gates (write-time + read-time seams)", () => {
  it("recordActualDetailed refuses out-of-bounds git_derived actuals at write time", async () => {
    const { recordActualDetailed } = await import("./feedback.js");
    writeEstimates([
      { id: "est-g1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-20T07:00:00Z" },
    ]);
    const rejected = recordActualDetailed("est-g1", 1000, undefined, undefined, "git_derived");
    expect(rejected).toEqual({ ok: false, reason: "git_derived_out_of_bounds" });

    const accepted = recordActualDetailed("est-g1", 6, undefined, undefined, "git_derived");
    expect(accepted.ok).toBe(true);
  });

  it("isExcluded gates out-of-bounds git-derived pairs from calibration math", async () => {
    const { isExcluded } = await import("./exclusion.js");
    expect(
      isExcluded({
        id: "real-id", tool: "pert_estimate", estimatedAt: "2026-09-20T07:00:00Z", estimatedHours: 4,
        actual: { actualHours: 2000, calibrationProvenance: "git_derived" },
      }),
    ).toEqual({ excluded: true, reason: "git_derived_sanity_gate" });
    expect(
      isExcluded({
        id: "real-id", tool: "pert_estimate", estimatedAt: "2026-09-20T07:00:00Z", estimatedHours: 4,
        actual: { actualHours: 6, calibrationProvenance: "git_derived_review_inclusive" },
      }).excluded,
    ).toBe(false);
  });

  it("feedback_health segments git-derived pairs into their own byProvenance bucket", async () => {
    const { recordActualDetailed, getFeedbackHealthReport } = await import("./feedback.js");
    writeEstimates([
      { id: "est-v", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-20T07:00:00Z" },
      { id: "est-g", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-20T07:00:00Z" },
    ]);
    expect(recordActualDetailed("est-v", 5, "verified", undefined, "prospective").ok).toBe(true);
    expect(recordActualDetailed("est-g", 6, "mined", undefined, "git_derived").ok).toBe(true);

    const report = getFeedbackHealthReport();
    expect(report.byProvenance.verified.matchedPairs).toBe(1);
    expect(report.byProvenance.gitDerived.matchedPairs).toBe(1);
    expect(report.byProvenance.auto.matchedPairs).toBe(0);
  });
});

describe("runMineGit — real git repository e2e", () => {
  beforeEach(() => {
    buildRealRepo();
  });

  afterEach(() => {
    rmSync(GIT_REPO_DIR, { recursive: true, force: true });
  });

  it("mines real merge commits, squash commits, and plain merges; matches all three key kinds; reports matchRate movement", async () => {
    const { runMineGit, defaultGitRunner } = await import("./mine-git.js");
    const { getFeedbackHealthReport } = await import("./feedback.js");

    writeEstimates([
      { id: "est-branch", tool: "pert_estimate", inputs: { branch: "feat/mining-e2e", task_type: "feature" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-20T10:30:00Z" },
      { id: "est-issue", tool: "pert_estimate", inputs: { issue_ref: "#101" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-20T10:30:00Z" },
      { id: "est-label", tool: "pert_estimate", inputs: { task_label: "mining e2e validation" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-20T10:30:00Z" },
      { id: "est-plain", tool: "pert_estimate", inputs: { branch: "chore/plain-merge" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-20T12:30:00Z" },
      { id: "est-squash", tool: "pert_estimate", inputs: { issue_ref: "#102" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-20T14:30:00Z" },
    ]);

    const before = getFeedbackHealthReport();

    const result = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-19", runGit: defaultGitRunner });

    // Units: #101 merge-commit PR, #102 squash PR, one plain merge.
    expect(result.units.byKind).toEqual({ merge_commit_pr: 1, squash_pr: 1, merged_branch: 1 });
    expect(result.units.scanned).toBe(3);

    // est-branch/est-issue/est-label all join #101 (dev window 11:00→14:00 = 3h);
    // est-plain joins the plain merge (13:00→16:00 = 3h).
    expect(result.estimates.recorded).toBe(4);
    for (const id of ["est-branch", "est-issue", "est-label", "est-plain"]) {
      expect(actualFor(id)?.["calibrationProvenance"]).toBe("git_derived");
    }
    const branchActual = actualFor("est-branch");
    expect((branchActual?.["actualHours"] as number)).toBeCloseTo(3, 5);

    // est-squash: #102 has no surviving PR-head ref in a plain clone -> no dev window.
    expect(result.skipped.map((s) => s.estimateId)).toEqual(["est-squash"]);
    expect(result.skipped[0]?.reason).toBe("no_dev_window");

    // The summary surfaces both window populations separately.
    expect(result.cycleTimes.dev.n).toBeGreaterThanOrEqual(2);
    expect(result.summary).toContain("never blended");

    const after = getFeedbackHealthReport();
    expect(before.matchRate).toBe(0);
    expect(after.matchRate).toBe(80); // 4 of 5 estimates actuated
    expect(after.byProvenance.gitDerived.matchedPairs).toBe(4);
  });

  it("is idempotent: a second run records nothing new (duplicate guard)", async () => {
    const { runMineGit, defaultGitRunner } = await import("./mine-git.js");
    writeEstimates([
      { id: "est-once", tool: "pert_estimate", inputs: { branch: "feat/mining-e2e" }, outputs: { totalHours: 4 }, estimatedAt: "2026-09-20T10:30:00Z" },
    ]);
    const first = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-19", runGit: defaultGitRunner });
    expect(first.estimates.recorded).toBe(1);
    const second = runMineGit({ repo: GIT_REPO_DIR, since: "2026-09-19", runGit: defaultGitRunner });
    expect(second.estimates.pending).toBe(0);
    expect(second.estimates.recorded).toBe(0);
    expect(readActuals()).toHaveLength(1);
  });
});
