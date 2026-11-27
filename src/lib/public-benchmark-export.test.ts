import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Integration coverage for scripts/export-public-benchmark.mjs and
// scripts/validate-public-benchmark.mjs: the public benchmark's metadata
// contract for `unique_contributors`.
//
// The field's unit is "distinct contributor ids named by the exported
// records". The exporter used to substitute the record count whenever no id
// was known (`contributors.size || pairs.length`), so two anonymous records
// were published as 2 unique contributors. An unknown identity is not a
// distinct contributor: it stays 0 and is reported as unknown.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const RUN_TIMEOUT_MS = 120_000;

/** Smallest community record the exporter turns into a pair. */
interface FixtureRecord {
  estimated_hours: number;
  actual_hours: number;
  task_type?: string;
  contributor_id?: string;
}

interface FixtureProject {
  /** Path of the script copy to run, e.g. "export-public-benchmark.mjs". */
  run(script: string): { status: number; stdout: string };
  /** The file the exporter writes and the validator reads. */
  benchmarkPath: string;
  env: NodeJS.ProcessEnv;
}

interface PublicBenchmark {
  schema_version: number;
  generated_at: string;
  source: string;
  total_records: number;
  unique_contributors: number;
  by_task_type: Record<string, unknown>;
  by_tool: Record<string, Record<string, number>>;
  _quality: Record<string, unknown>;
}

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * A throwaway project root holding byte copies of the real scripts, with `src`
 * symlinked to the checkout so they import the real library code. Both scripts
 * derive every path from their own location, so this points the real exporter
 * at fixture data and leaves the checkout's `data/` and any ledger untouched.
 * The ledger dir is empty (no local pairs) and no cocomo file exists.
 */
function makeProject(records: FixtureRecord[]): FixtureProject {
  const root = mkdtempSync(join(tmpdir(), "epoch-public-benchmark-"));
  tempRoots.push(root);

  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  for (const name of ["export-public-benchmark.mjs", "validate-public-benchmark.mjs"]) {
    copyFileSync(join(REPO_ROOT, "scripts", name), join(scripts, name));
  }
  symlinkSync(join(REPO_ROOT, "src"), join(root, "src"), "dir");

  const communityDir = join(root, "data", "community");
  mkdirSync(communityDir, { recursive: true });
  writeFileSync(
    join(communityDir, "fixture-estimation.json"),
    JSON.stringify({ _schema: "estimation-record", records }),
  );

  const home = join(root, "home");
  const ledger = join(root, "ledger");
  mkdirSync(home);
  mkdirSync(ledger);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  env["EPOCH_DATA_DIR"] = ledger;

  return {
    benchmarkPath: join(root, "data", "public-benchmark.json"),
    env,
    run(script) {
      try {
        const stdout = execFileSync(process.execPath, [TSX_CLI, join(scripts, script)], {
          env,
          encoding: "utf8",
          timeout: RUN_TIMEOUT_MS,
        });
        return { status: 0, stdout };
      } catch (err) {
        // A non-zero exit is a result (the validator reports through exit code 1).
        const failure = err as { status?: number; stdout?: string };
        return { status: failure.status ?? -1, stdout: failure.stdout ?? "" };
      }
    },
  };
}

function exportBenchmark(project: FixtureProject): PublicBenchmark {
  const run = project.run("export-public-benchmark.mjs");
  expect(run.status).toBe(0);
  return JSON.parse(readFileSync(project.benchmarkPath, "utf8")) as PublicBenchmark;
}

/** The exporter's shape for [a, a, b, anonymous], for validator cases. */
function exportedBenchmark(): PublicBenchmark {
  return {
    schema_version: 1,
    generated_at: "2026-11-27T00:00:00.000Z",
    source: "community + cocomo calibration + local ledger",
    total_records: 4,
    unique_contributors: 2,
    by_task_type: {
      feature: {
        sample_count: 4,
        median_estimated_hours: 4,
        median_actual_hours: 5,
        median_ratio: 1.25,
        mean_ratio: 1.25,
        p25_ratio: 1,
        p75_ratio: 1.5,
      },
    },
    by_tool: { community: { sample_count: 4, median_ratio: 1.25 } },
    _quality: {
      local_pairs_included: 0,
      local_pairs_excluded_by_isExcluded: 0,
      contaminated_pairs_filtered: 0,
      pre_filter_total_pairs: 4,
      pairs_with_contributor_id: 3,
    },
  };
}

describe("export-public-benchmark.mjs: unique_contributors", () => {
  it("writes 0, not the record count, when no record names a contributor", { timeout: RUN_TIMEOUT_MS }, () => {
    const project = makeProject([
      { estimated_hours: 4, actual_hours: 6, task_type: "bugfix" },
      { estimated_hours: 8, actual_hours: 5, task_type: "feature" },
    ]);

    const benchmark = exportBenchmark(project);

    expect(benchmark.total_records).toBe(2);
    expect(benchmark.unique_contributors).toBe(0);
    expect(benchmark._quality["pairs_with_contributor_id"]).toBe(0);
  });

  it("counts two records sharing one explicit contributor_id as one contributor", { timeout: RUN_TIMEOUT_MS }, () => {
    const project = makeProject([
      { estimated_hours: 4, actual_hours: 6, task_type: "bugfix", contributor_id: "fixture-contributor-a" },
      { estimated_hours: 8, actual_hours: 5, task_type: "feature", contributor_id: "fixture-contributor-a" },
    ]);

    const benchmark = exportBenchmark(project);

    expect(benchmark.total_records).toBe(2);
    expect(benchmark.unique_contributors).toBe(1);
    expect(benchmark._quality["pairs_with_contributor_id"]).toBe(2);
  });

  it("counts distinct ids only and never infers one for a record without an id", { timeout: RUN_TIMEOUT_MS }, () => {
    const project = makeProject([
      { estimated_hours: 4, actual_hours: 6, task_type: "bugfix", contributor_id: "fixture-contributor-a" },
      { estimated_hours: 8, actual_hours: 5, task_type: "feature", contributor_id: "fixture-contributor-a" },
      { estimated_hours: 2, actual_hours: 3, task_type: "refactor", contributor_id: "fixture-contributor-b" },
      { estimated_hours: 6, actual_hours: 4, task_type: "testing" },
    ]);

    const benchmark = exportBenchmark(project);

    expect(benchmark.total_records).toBe(4);
    expect(benchmark.unique_contributors).toBe(2);
    expect(benchmark._quality["pairs_with_contributor_id"]).toBe(3);
  });
});

describe("validate-public-benchmark.mjs: contributor coverage", () => {
  it("accepts an export whose contributors are covered by the records naming one", { timeout: RUN_TIMEOUT_MS }, () => {
    const project = makeProject([
      { estimated_hours: 4, actual_hours: 6, task_type: "bugfix", contributor_id: "fixture-contributor-a" },
      { estimated_hours: 8, actual_hours: 5, task_type: "feature", contributor_id: "fixture-contributor-a" },
      { estimated_hours: 2, actual_hours: 3, task_type: "refactor", contributor_id: "fixture-contributor-b" },
      { estimated_hours: 6, actual_hours: 4, task_type: "testing" },
    ]);
    expect(exportBenchmark(project).unique_contributors).toBe(2);

    const run = project.run("validate-public-benchmark.mjs");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("VALID");
  });

  it("fails when unique_contributors exceeds the records that name a contributor", { timeout: RUN_TIMEOUT_MS }, () => {
    const project = makeProject([]);
    // 2072-style fallback artifact: every record counted as its own contributor.
    const benchmark = exportedBenchmark();
    benchmark.unique_contributors = benchmark.total_records;
    writeFileSync(project.benchmarkPath, JSON.stringify(benchmark));

    const run = project.run("validate-public-benchmark.mjs");

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("INVALID");
    expect(run.stdout).toContain("unique_contributors (4) exceeds the 3");
  });

  it("marks an export built before contributor coverage as unverified without failing", { timeout: RUN_TIMEOUT_MS }, () => {
    const project = makeProject([]);
    const benchmark = exportedBenchmark();
    benchmark.unique_contributors = benchmark.total_records;
    delete benchmark._quality["pairs_with_contributor_id"];
    writeFileSync(project.benchmarkPath, JSON.stringify(benchmark));

    const run = project.run("validate-public-benchmark.mjs");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("VALID");
    expect(run.stdout).toContain("unverified");
  });
});
