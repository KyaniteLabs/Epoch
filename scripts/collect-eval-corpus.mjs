#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Eval-harness corpus collector (S1.4, roadmap Part 3 / PRD item 8)
//
// Harvests GitHub issues that were closed by a merged pull request and turns
// them into reference-class (open-info, actual-duration-window) records for
// the accuracy eval harness (S6.1).
//
// Pipeline per repo (all via `gh api`, authenticated free tier, zero spend):
//   1. search/issues with `is:issue is:closed linked:pr` — GitHub's own
//      closing-link index (sorted closed-date desc for freshness).
//   2. For each issue: /issues/{n}/timeline — cross-referenced events whose
//      source is a PR give candidate closing PRs (same-repo AND cross-repo).
//   3. For each candidate PR: /repos/{pr_repo}/pulls/{n} — keep MERGED PRs
//      only; select the latest merged_at <= issue.closed_at + 120s grace.
//      An issue closed without a merged closing PR (manual close, still-open
//      PR) is DROPPED with reason "no_merged_closing_pr" — counted, never
//      silently discarded.
//   4. First commit of the closing PR: /pulls/{n}/commits?per_page=1.
//
// Bot filtering: issue authors and PR authors whose GitHub account type is
// "Bot", or whose login matches the well-known bot pattern list, are dropped
// (drop reasons "bot_issue_author" / "bot_pr_author") and counted.
//
// Privacy: NO author logins are stored anywhere (raw cache or frozen corpus).
// Only account type + author_association survive, plus issue body length and
// sha256 (title + labels are kept — they feed classifyContext offline).
//
// Actual-window convention (matches S1.1's provenance buckets; never blended):
//   - calendar_window: issue open -> close (review-inclusive) — the
//     "git_derived_review_inclusive" analog.
//   - dev_window: PR first-commit -> merge — the "git_derived" analog.
//   - pr_window: PR open -> merge (review-inclusive).
//
// Rate-limit discipline: search endpoint throttled to <=28 req/min; core
// remaining checked every 20 records; run aborts (resumable — the raw cache
// skips already-fetched issues) when remaining < --min-rate floor.
//
// Determinism: raw cache is append-only keyed by (repo, issue number);
// freeze sorts canonically by (issue repo, issue number) before writing.
//
// Usage:
//   node scripts/collect-eval-corpus.mjs check                        # verify candidate repos (>=1k closed issues, linked counts)
//   node scripts/collect-eval-corpus.mjs collect [--repos a/b,c/d] [--max-per-repo N]
//   node scripts/collect-eval-corpus.mjs freeze                       # raw cache -> frozen corpus + SHA256SUMS + freeze note
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(PROJECT_ROOT, "data", "eval-corpus");
const RAW_DIR = join(OUT_DIR, "raw");

// Mid-size, active public repos with disciplined closing-PR workflows.
// Selection rule (PRD S1.4): 5-10 repos, >=1k closed issues each.
// `check` subcommand verifies the rule live before any harvest.
const DEFAULT_REPOS = [
  "nestjs/nest",
  "facebook/docusaurus",
  "strapi/strapi",
  "nuxt/nuxt",
  "vuejs/core",
  "denoland/deno",
  "zaproxy/zaproxy",
];

const DEFAULT_MAX_PER_REPO = 200;
const RATE_FLOOR = 400; // abort when core remaining drops below this
const SEARCH_THROTTLE_MS = 2200; // search endpoint: 30 req/min authenticated
const MERGE_CLOSE_GRACE_MS = 120_000; // closing PR may merge up to 2min before issue close event lands
const MAX_WINDOW_HOURS = 24 * 365; // sanity bound (auto_wallclock class)
const TITLE_MAX_CHARS = 280;
const COLLECTOR_VERSION = 2; // bump to invalidate stale raw-cache records
const LATE_MERGE_MAX_DAYS = 14; // tier-B cap: merged closing PR up to 14d AFTER the issue close

// Well-known bot logins that GitHub reports as type "User" (CLI-pushed bots).
const BOT_LOGIN_RE =
  /(bot|renovate|dependabot|greenkeeper|semantic-release|github-actions|copilot|netlify|vercel|allcontributors|codecov|imgbot|lock|stale)[-_.]?(\[bot\])?$/i;

const argv = process.argv.slice(2);
const subcommand = argv[0] ?? "help";
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const reposArg = argValue("--repos", DEFAULT_REPOS.join(","));
const maxPerRepo = parseInt(argValue("--max-per-repo", String(DEFAULT_MAX_PER_REPO)), 10);
const rateFloor = parseInt(argValue("--min-rate", String(RATE_FLOOR)), 10);

// ---- gh plumbing -------------------------------------------------------------

function ghApi(path, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const out = execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return JSON.parse(out);
    } catch (err) {
      const status = err.status ?? 0;
      if (status === 404) return null; // missing resource is a valid answer
      if (status === 403 || status === 429) {
        // secondary rate limit: back off and retry
        if (attempt < tries) {
          sleep(30_000 * attempt);
          continue;
        }
      }
      if (attempt < tries && status >= 500) continue;
      throw err;
    }
  }
}

function coreRemaining() {
  try {
    const rl = execFileSync("gh", ["api", "rate_limit", "--jq", ".resources.core.remaining"], {
      encoding: "utf8",
    });
    return parseInt(rl.trim(), 10);
  } catch {
    return Number.MAX_SAFE_INTEGER; // never block on a failed probe alone
  }
}

function sleep(ms) {
  execFileSync("sleep", [String(ms / 1000)]);
}

function isBot(user) {
  if (!user) return true; // missing author = treat as non-human
  return user.type === "Bot" || BOT_LOGIN_RE.test(user.login ?? "");
}

function slug(repo) {
  return repo.replace("/", "__");
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function hoursBetween(aIso, bIso) {
  return (Date.parse(bIso) - Date.parse(aIso)) / 3_600_000;
}

// ---- check: verify candidate repos meet the selection rule -------------------

async function cmdCheck() {
  console.log("repo\tclosed_issues\tlinked_closed\tstars\tarchived\tmeets_rule");
  for (const repo of reposArg.split(",").map((s) => s.trim()).filter(Boolean)) {
    const meta = ghApi(`repos/${repo}`);
    if (!meta || meta.archived) {
      console.log(`${repo}\tNOT_FOUND_OR_ARCHIVED`);
      continue;
    }
    await throttleSearch();
    const closed = ghApi(`search/issues?q=repo:${repo}+is:issue+is:closed&per_page=1`);
    await throttleSearch();
    const linked = ghApi(
      `search/issues?q=repo:${repo}+is:issue+is:closed+linked:pr&per_page=1`,
    );
    const closedCount = closed?.total_count ?? 0;
    console.log(
      `${repo}\t${closedCount}\t${linked?.total_count ?? 0}\t${meta.stargazers_count}\t${meta.archived}\t${closedCount >= 1000 ? "YES" : "NO(<1k)"}`,
    );
  }
}

let lastSearchAt = 0;
async function throttleSearch() {
  const wait = Date.now() - lastSearchAt;
  if (wait < SEARCH_THROTTLE_MS) sleep(SEARCH_THROTTLE_MS - wait);
  lastSearchAt = Date.now();
}

// ---- collect -----------------------------------------------------------------

function cachePath(repo) {
  return join(RAW_DIR, slug(repo), "issues.jsonl");
}

function loadCache(repo) {
  const file = cachePath(repo);
  const seen = new Map();
  if (!existsSync(file)) return seen;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      seen.set(rec.issue.number, rec);
    } catch {
      /* partial line from an interrupted run — ignore */
    }
  }
  return seen;
}

async function cmdCollect() {
  mkdirSync(RAW_DIR, { recursive: true });
  const repos = reposArg.split(",").map((s) => s.trim()).filter(Boolean);
  const summary = [];

  for (const repo of repos) {
    const cacheFile = cachePath(repo);
    mkdirSync(dirname(cacheFile), { recursive: true });
    const cache = loadCache(repo);

    // 1. candidate closed issues with a closing-PR link (GitHub's index)
    const candidates = [];
    for (let page = 1; candidates.length < maxPerRepo; page++) {
      await throttleSearch();
      const q = `search/issues?q=repo:${repo}+is:issue+is:closed+linked:pr&sort=closed-date&order=desc&per_page=100&page=${page}`;
      const res = ghApi(q);
      if (!res || !res.items || res.items.length === 0) break;
      candidates.push(...res.items.slice(0, maxPerRepo - candidates.length));
      if (res.items.length < 100 || candidates.length >= res.total_count) break;
    }

    let fetched = 0;
    let cached = 0;
    let dropped = { no_merged_closing_pr: 0, bot_issue_author: 0, bot_pr_author: 0, fetch_error: 0 };
    let kept = 0;

    for (const it of candidates) {
      const prev = cache.get(it.number);
      if (prev && prev.collector_version === COLLECTOR_VERSION) {
        cached++;
        if (prev.drop_reason === null) kept++;
        else dropped[prev.drop_reason] = (dropped[prev.drop_reason] ?? 0) + 1;
        continue;
      }
      if (fetched % 20 === 0) {
        const rem = coreRemaining();
        if (rem < rateFloor) {
          console.error(
            `[rate-guard] core remaining ${rem} < floor ${rateFloor} — aborting mid-repo. Raw cache is resumable: rerun the same command.`,
          );
          process.exit(2);
        }
      }

      const rec = harvestIssue(repo, it);
      cache.set(it.number, rec);
      appendFileSync(cacheFile, JSON.stringify(rec) + "\n");
      fetched++;
      if (rec.drop_reason === null) kept++;
      else dropped[rec.drop_reason] = (dropped[rec.drop_reason] ?? 0) + 1;
    }

    const meta = {
      repo,
      fetched_at: new Date().toISOString(),
      candidates_from_search: candidates.length,
      newly_fetched: fetched,
      served_from_cache: cached,
      kept_records: kept,
      dropped,
    };
    writeFileSync(join(dirname(cacheFile), "fetch-metadata.json"), JSON.stringify(meta, null, 2) + "\n");
    summary.push(meta);
    console.log(
      `${repo}: candidates=${candidates.length} fetched=${fetched} cached=${cached} kept=${kept} dropped=${JSON.stringify(dropped)}`,
    );
  }

  writeFileSync(
    join(RAW_DIR, "collect-summary.json"),
    JSON.stringify({ completed_at: new Date().toISOString(), repos: summary }, null, 2) + "\n",
  );
}

// One issue -> raw cache record (or a counted drop).
//
// Closing-link tiers (recorded per kept record, never blended):
//   - "merge_closed":  the PR merge demonstrably closed the issue
//                     (merged_at within closed_at +/- grace). Highest confidence.
//   - "linked_merged": no merge in the close window — maintainers closed the
//                     issue manually — but a MERGED cross-referenced PR tied
//                     to the issue by GitHub's closing-link index exists
//                     within [issue.created_at, closed_at + LATE_MERGE_MAX_DAYS].
//                     Flagged close_before_merge when merged_at > closed_at.
//                     Harness may stratify by this tier.
function harvestIssue(repo, searchItem) {
  const drop = (reason, extra = {}) => ({
    schema_version: 1,
    collector_version: COLLECTOR_VERSION,
    collected_at: new Date().toISOString(),
    issue: {
      repo,
      number: searchItem.number,
      state: searchItem.state,
    },
    ...extra,
    selected_pr: null,
    drop_reason: reason,
  });

  if (isBot(searchItem.user)) return drop("bot_issue_author");

  const issuePath = `repos/${repo}/issues/${searchItem.number}`;
  const issue = ghApi(issuePath);
  if (!issue || !issue.closed_at || issue.pull_request) return drop("fetch_error");

  const base = {
    schema_version: 1,
    collector_version: COLLECTOR_VERSION,
    collected_at: new Date().toISOString(),
    issue: {
      repo,
      number: searchItem.number,
      state: issue.state,
      title: (issue.title ?? "").slice(0, TITLE_MAX_CHARS),
      labels: (issue.labels ?? []).map((l) => l.name).sort(),
      author_type: issue.user?.type ?? "UNKNOWN",
      author_association: issue.author_association ?? "UNKNOWN",
      created_at: issue.created_at,
      closed_at: issue.closed_at,
      body_length: (issue.body ?? "").length,
      body_sha256: issue.body ? sha256(issue.body) : null,
    },
  };

  // 2. candidate closing PRs from the issue timeline (cross-references)
  const timeline = ghApi(`repos/${repo}/issues/${searchItem.number}/timeline?per_page=100`);
  if (!timeline) return { ...base, candidates_considered: 0, selected_pr: null, drop_reason: "fetch_error" };

  const prCandidates = [];
  for (const ev of timeline) {
    if (ev.event !== "cross-referenced") continue;
    const src = ev.source?.issue;
    if (!src?.pull_request) continue; // cross-ref from another issue, not a PR
    const prRepo = src.repository?.full_name;
    if (!prRepo) continue;
    prCandidates.push({ repo: prRepo, number: src.number });
  }
  const withCands = { ...base, candidates_considered: prCandidates.length };
  if (prCandidates.length === 0) return { ...withCands, selected_pr: null, drop_reason: "no_merged_closing_pr" };

  // 3. merged candidates; tier A = merge within the close-event window,
  //    tier B = merged within [issue.created_at, closed_at + LATE_MERGE_MAX_DAYS]
  const closedAtMs = Date.parse(issue.closed_at);
  const lateCutoffMs = closedAtMs + LATE_MERGE_MAX_DAYS * 86_400_000;
  const tierA = [];
  const tierB = [];
  for (const cand of prCandidates) {
    const pr = ghApi(`repos/${cand.repo}/pulls/${cand.number}`);
    if (!pr || !pr.merged_at) continue;
    const mergedMs = Date.parse(pr.merged_at);
    if (mergedMs < Date.parse(issue.created_at)) continue; // PR older than the issue
    if (Math.abs(mergedMs - closedAtMs) <= MERGE_CLOSE_GRACE_MS) tierA.push({ cand, pr });
    else if (mergedMs <= lateCutoffMs) tierB.push({ cand, pr });
  }
  if (tierA.length === 0 && tierB.length === 0) {
    return { ...withCands, selected_pr: null, drop_reason: "no_merged_closing_pr" };
  }

  // tier A wins; the closer is the merge closest to the close event, else the
  // latest qualifying merge before the late cutoff
  const pool = tierA.length > 0 ? tierA : tierB;
  pool.sort((a, b) =>
    tierA.length > 0
      ? Math.abs(Date.parse(a.pr.merged_at) - closedAtMs) - Math.abs(Date.parse(b.pr.merged_at) - closedAtMs)
      : Date.parse(b.pr.merged_at) - Date.parse(a.pr.merged_at),
  );
  const { cand, pr } = pool[0];

  if (isBot(pr.user)) {
    return {
      ...withCands,
      selected_pr: null,
      drop_reason: "bot_pr_author",
    };
  }

  // 4. first commit of the closing PR (dev-window start)
  const commits = ghApi(`repos/${cand.repo}/pulls/${cand.number}/commits?per_page=1`);
  const firstCommitAt = commits?.[0]?.commit?.author?.date ?? null;

  const mergedMs = Date.parse(pr.merged_at);
  return {
    ...withCands,
    closing_pr: {
      repo: cand.repo,
      number: cand.number,
      cross_repo: cand.repo !== repo,
      author_type: pr.user?.type ?? "UNKNOWN",
      author_association: pr.author_association ?? "UNKNOWN",
      created_at: pr.created_at,
      merged_at: pr.merged_at,
      first_commit_at: firstCommitAt,
      commits_count: pr.commits ?? null,
      closing_link: tierA.length > 0 ? "merge_closed" : "linked_merged",
      close_before_merge: mergedMs > closedAtMs + MERGE_CLOSE_GRACE_MS,
    },
    selected_pr: cand.repo + "#" + cand.number,
    drop_reason: null,
  };
}

// ---- freeze ------------------------------------------------------------------

function windowGates(base, issue, pr) {
  if (!pr.first_commit_at) return "missing_first_commit";
  const cal = hoursBetween(issue.created_at, issue.closed_at);
  const dev = hoursBetween(pr.first_commit_at, pr.merged_at);
  const prw = hoursBetween(pr.created_at, pr.merged_at);
  if (!(cal > 0 && cal <= MAX_WINDOW_HOURS)) return "calendar_window_out_of_bounds";
  if (!(dev > 0 && dev <= MAX_WINDOW_HOURS)) return "dev_window_out_of_bounds";
  if (!(prw > 0 && prw <= MAX_WINDOW_HOURS)) return "pr_window_out_of_bounds";
  return { cal: round3(cal), dev: round3(dev), prw: round3(prw) };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function cmdFreeze() {
  const perRepo = [];
  const records = [];
  const dropCounts = {};
  let totalIssues = 0;

  for (const dir of readdirSync(RAW_DIR).sort()) {
    const file = join(RAW_DIR, dir, "issues.jsonl");
    if (!existsSync(file)) continue;
    const repo = dir.replace("__", "/");
    const meta = existsSync(join(RAW_DIR, dir, "fetch-metadata.json"))
      ? JSON.parse(readFileSync(join(RAW_DIR, dir, "fetch-metadata.json"), "utf8"))
      : null;
    // dedupe: an issue refetched after a collector bump leaves stale lines;
    // the LAST line for a number is authoritative
    const latest = new Map();
    let staleLines = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (latest.has(raw.issue.number)) staleLines++;
      latest.set(raw.issue.number, raw);
    }
    let kept = 0;
    const repoDrops = {};
    for (const raw of [...latest.values()].sort((a, b) => a.issue.number - b.issue.number)) {
      totalIssues++;
      if (raw.drop_reason !== null) {
        repoDrops[raw.drop_reason] = (repoDrops[raw.drop_reason] ?? 0) + 1;
        continue;
      }
      const gated = windowGates(raw, raw.issue, raw.closing_pr);
      if (typeof gated === "string") {
        repoDrops[gated] = (repoDrops[gated] ?? 0) + 1;
        continue;
      }
      records.push(freezeRecord(raw, gated));
      kept++;
    }
    for (const [k, v] of Object.entries(repoDrops)) dropCounts[k] = (dropCounts[k] ?? 0) + v;
    perRepo.push({
      repo,
      fetch_dates: meta ? [meta.fetched_at] : ["unknown"],
      issues_examined: latest.size,
      kept_records: kept,
      stale_lines_deduped: staleLines,
      drops: repoDrops,
    });
  }

  // canonical deterministic order: (issue repo, issue number)
  records.sort((a, b) =>
    a.issue.repo === b.issue.repo ? a.issue.number - b.issue.number : a.issue.repo < b.issue.repo ? -1 : 1,
  );

  const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const corpusFile = join(OUT_DIR, `corpus-${dateTag}.jsonl`);
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  writeFileSync(corpusFile, body);
  const corpusSha = sha256(body);

  const schemaFile = join(PROJECT_ROOT, "data", "schemas", "eval-corpus.schema.json");
  const schemaSha = sha256(readFileSync(schemaFile, "utf8"));
  writeFileSync(
    join(OUT_DIR, "SHA256SUMS.txt"),
    `${corpusSha}  ${corpusFile.replace(PROJECT_ROOT + "/", "")}\n${schemaSha}  ${schemaFile.replace(PROJECT_ROOT + "/", "")}\n`,
  );

  const freeze = {
    frozen_at: new Date().toISOString(),
    corpus_file: corpusFile.replace(PROJECT_ROOT + "/", ""),
    corpus_sha256: corpusSha,
    schema_file: schemaFile.replace(PROJECT_ROOT + "/", ""),
    schema_sha256: schemaSha,
    record_count: records.length,
    collection_window: collectionWindow(records),
    filters: {
      selection: "GitHub search `is:issue is:closed linked:pr` (closing-link index), sorted closed-date desc",
      bot_filter:
        "issue+PR authors with GitHub account type Bot, or login matching known bot patterns (dependabot/renovate/actions/...), are dropped and counted",
      closing_pr_rule:
        "tiered: 'merge_closed' = merged PR within closed_at +/- 120s (the merge closed the issue); 'linked_merged' = merged cross-referenced PR (GitHub linked:pr index) within [issue.created_at, closed_at + 14d] when maintainers closed manually first (close_before_merge flagged); tier recorded per record",
      window_bounds: `0 < hours <= ${MAX_WINDOW_HOURS} per window (auto_wallclock-class sanity gate)`,
      privacy: "no author logins stored; body kept as length+sha256 only; title truncated to 280 chars",
    },
    per_repo: perRepo,
    drop_counts: dropCounts,
    total_issues_examined: totalIssues,
  };
  writeFileSync(join(OUT_DIR, "freeze-note.json"), JSON.stringify(freeze, null, 2) + "\n");

  console.log(JSON.stringify(freeze, null, 2));
}

function collectionWindow(records) {
  if (records.length === 0) return null;
  let minC = Infinity;
  let maxC = -Infinity;
  for (const r of records) {
    const t = Date.parse(r.issue.created_at);
    if (t < minC) minC = t;
    if (t > maxC) maxC = t;
  }
  return { earliest_issue_open: new Date(minC).toISOString(), latest_issue_open: new Date(maxC).toISOString() };
}

function freezeRecord(raw, gated) {
  return {
    schema_version: 1,
    record_id: `${raw.issue.repo}#${raw.issue.number}`,
    source: "github-closing-issues",
    collected_at: raw.collected_at,
    issue: raw.issue,
    closing_pr: raw.closing_pr,
    actuals: {
      calendar_window_hours: gated.cal,
      calendar_window_definition: "issue open -> close (review-inclusive)",
      dev_window_hours: gated.dev,
      dev_window_definition: "PR first-commit -> merge",
      pr_window_hours: gated.prw,
      pr_window_definition: "PR open -> merge (review-inclusive)",
      provenance_note:
        "windows are reported separately, never blended; calendar/pr windows map to the git_derived_review_inclusive bucket, dev window to git_derived (S1.1 conventions)",
    },
  };
}

// ---- validate (standing check; mirrors scripts/validate-public-benchmark.mjs discipline) ----

function cmdValidate() {
  const note = JSON.parse(readFileSync(join(OUT_DIR, "freeze-note.json"), "utf8"));
  const corpusFile = join(PROJECT_ROOT, note.corpus_file);
  const body = readFileSync(corpusFile, "utf8");
  const actualSha = sha256(body);
  const errors = [];
  if (actualSha !== note.corpus_sha256) {
    errors.push(`corpus sha256 mismatch: freeze-note ${note.corpus_sha256} != actual ${actualSha}`);
  }
  const sums = readFileSync(join(OUT_DIR, "SHA256SUMS.txt"), "utf8");
  if (!sums.includes(actualSha)) errors.push("corpus sha256 missing from SHA256SUMS.txt");

  const schema = JSON.parse(readFileSync(join(PROJECT_ROOT, note.schema_file), "utf8"));
  const reqTop = schema.required;
  const reqIssue = schema.properties.issue.required;
  const reqPr = schema.properties.closing_pr.required;
  const reqAct = schema.properties.actuals.required;
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

  let n = 0;
  let prevKey = null;
  const seen = new Set();
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    n++;
    const d = JSON.parse(line);
    const rid = d.record_id ?? "?";
    if (seen.has(rid)) errors.push(`${rid}: duplicate record`);
    seen.add(rid);
    const key = d.issue?.repo ?? "";
    const num = d.issue?.number ?? 0;
    if (prevKey !== null && (key < prevKey.repo || (key === prevKey.repo && num < prevKey.num))) {
      errors.push(`${rid}: canonical order violated`);
    }
    prevKey = { repo: key, num };
    for (const k of reqTop) if (!(k in d)) errors.push(`${rid}: missing ${k}`);
    if (!reqIssue.every((k) => k in (d.issue ?? {}))) errors.push(`${rid}: issue fields missing`);
    if (!reqPr.every((k) => k in (d.closing_pr ?? {}))) errors.push(`${rid}: closing_pr fields missing`);
    if (!reqAct.every((k) => k in (d.actuals ?? {}))) errors.push(`${rid}: actuals fields missing`);
    for (const fld of ["created_at", "closed_at"]) {
      if (!isoRe.test(d.issue?.[fld] ?? "")) errors.push(`${rid}: bad iso issue.${fld}`);
    }
    for (const fld of ["created_at", "merged_at", "first_commit_at"]) {
      if (!isoRe.test(d.closing_pr?.[fld] ?? "")) errors.push(`${rid}: bad iso closing_pr.${fld}`);
    }
    const a = d.actuals ?? {};
    for (const fld of ["calendar_window_hours", "dev_window_hours", "pr_window_hours"]) {
      if (!(a[fld] > 0 && a[fld] <= MAX_WINDOW_HOURS)) errors.push(`${rid}: ${fld} out of bounds`);
    }
    if (!["merge_closed", "linked_merged"].includes(d.closing_pr?.closing_link)) {
      errors.push(`${rid}: bad closing_link tier`);
    }
    if (/"(login|author_login|user_login)"/.test(JSON.stringify(d))) {
      errors.push(`${rid}: possible login field leaked`);
    }
  }
  if (n !== note.record_count) {
    errors.push(`record count mismatch: freeze-note ${note.record_count} != actual ${n}`);
  }
  if (errors.length > 0) {
    console.error(`eval-corpus validation FAILED (${errors.length} errors):`);
    for (const e of errors.slice(0, 20)) console.error("  - " + e);
    process.exit(1);
  }
  console.log(
    `eval-corpus validation OK: ${n} records, sha256 ${actualSha.slice(0, 12)}..., order canonical, no duplicates, bounds respected`,
  );
}

// ---- main --------------------------------------------------------------------

const COMMANDS = { check: cmdCheck, collect: cmdCollect, freeze: cmdFreeze, validate: cmdValidate };
if (COMMANDS[subcommand]) {
  await COMMANDS[subcommand]();
} else {
  console.log(
    "usage: node scripts/collect-eval-corpus.mjs <check|collect|freeze|validate> [--repos owner/name,...] [--max-per-repo N] [--min-rate N]",
  );
  process.exit(subcommand === "help" ? 0 : 1);
}
