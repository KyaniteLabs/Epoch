import { describe, it, expect } from "vitest";
import { isExcluded, isSyntheticId, SYNTHETIC_ID_PREFIXES, MIN_RATIO, MINIMUM_CALIBRATION_ACTUAL_HOURS, BACKFILL_SIGNATURE_DATE, type ExclusionRecord } from "./exclusion.js";

function baseRecord(overrides: Partial<ExclusionRecord> = {}): ExclusionRecord {
  return {
    id: "est-1",
    tool: "pert_estimate",
    inputs: { task_type: "feature" },
    estimatedAt: "2026-06-01T10:00:00.000Z",
    estimatedHours: 10,
    actual: { actualHours: 8, reportedAt: "2026-06-02T10:00:00.000Z" },
    ...overrides,
  };
}

describe("isSyntheticId", () => {
  for (const prefix of SYNTHETIC_ID_PREFIXES) {
    it(`flags ids starting with "${prefix}"`, () => {
      expect(isSyntheticId(`${prefix}abc123`)).toBe(true);
    });
  }

  it("does not flag ordinary ids", () => {
    expect(isSyntheticId("est-real-123")).toBe(false);
    expect(isSyntheticId(crypto.randomUUID())).toBe(false);
  });
});

describe("isExcluded — overlay flags", () => {
  it("excludes records with flags.quarantined=true", () => {
    const verdict = isExcluded(baseRecord({ flags: { quarantined: true } }));
    expect(verdict).toEqual({ excluded: true, reason: "quarantine_flag" });
  });

  it("excludes records with flags.orphan=true", () => {
    const verdict = isExcluded(baseRecord({ flags: { orphan: true } }));
    expect(verdict).toEqual({ excluded: true, reason: "orphan" });
  });

  it("quarantine flag wins even over an otherwise-clean record", () => {
    const verdict = isExcluded(baseRecord({ flags: { quarantined: true }, actual: { actualHours: 8, reportedAt: "2026-01-01T00:00:00Z" } }));
    expect(verdict.excluded).toBe(true);
    expect(verdict.reason).toBe("quarantine_flag");
  });
});

describe("isExcluded — synthetic id", () => {
  it("excludes when the record id has a synthetic prefix", () => {
    const verdict = isExcluded(baseRecord({ id: "seed-abc" }));
    expect(verdict).toEqual({ excluded: true, reason: "synthetic_id" });
  });

  it("excludes pending (no-actual) records with a synthetic id", () => {
    const verdict = isExcluded(baseRecord({ id: "test-pending", actual: undefined }));
    expect(verdict).toEqual({ excluded: true, reason: "synthetic_id" });
  });
});

describe("isExcluded — pending estimates (no actual)", () => {
  it("does not exclude a pending estimate with no TTL", () => {
    const verdict = isExcluded(baseRecord({ actual: undefined }));
    expect(verdict).toEqual({ excluded: false });
  });

  it("does not exclude a pending estimate with a future expiresAt", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const verdict = isExcluded(baseRecord({ actual: undefined, expiresAt: future }));
    expect(verdict).toEqual({ excluded: false });
  });

  it("excludes a pending estimate past its TTL expiresAt", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const verdict = isExcluded(baseRecord({ actual: undefined, expiresAt: past }));
    expect(verdict).toEqual({ excluded: true, reason: "ttl_expired" });
  });

  it("respects an injected `now` for TTL determinism", () => {
    const verdict = isExcluded(
      baseRecord({ actual: undefined, expiresAt: "2026-01-15T00:00:00Z" }),
      new Date("2026-01-20T00:00:00Z"),
    );
    expect(verdict).toEqual({ excluded: true, reason: "ttl_expired" });

    const verdictBefore = isExcluded(
      baseRecord({ actual: undefined, expiresAt: "2026-01-15T00:00:00Z" }),
      new Date("2026-01-10T00:00:00Z"),
    );
    expect(verdictBefore).toEqual({ excluded: false });
  });
});

describe("isExcluded — explicit exclude / provenance", () => {
  it("excludes when inputs.calibration_usage is 'exclude'", () => {
    const verdict = isExcluded(baseRecord({ inputs: { calibration_usage: "exclude" } }));
    expect(verdict).toEqual({ excluded: true, reason: "explicit_exclude" });
  });

  it("excludes when inputs.calibration_provenance is 'synthetic'", () => {
    const verdict = isExcluded(baseRecord({ inputs: { calibration_provenance: "synthetic" } }));
    expect(verdict).toEqual({ excluded: true, reason: "explicit_exclude" });
  });

  it("excludes when inputs.calibration_provenance is 'smoke'", () => {
    const verdict = isExcluded(baseRecord({ inputs: { calibration_provenance: "smoke" } }));
    expect(verdict).toEqual({ excluded: true, reason: "explicit_exclude" });
  });

  it("excludes when the actual carries calibrationUsage='exclude' (legacy camelCase field)", () => {
    const verdict = isExcluded(baseRecord({ actual: { actualHours: 8, reportedAt: "2026-01-01T00:00:00Z", calibrationUsage: "exclude" } }));
    expect(verdict).toEqual({ excluded: true, reason: "explicit_exclude" });
  });

  it("excludes when the actual carries calibration_provenance='smoke' (legacy snake_case field)", () => {
    const verdict = isExcluded(baseRecord({ actual: { actualHours: 8, reportedAt: "2026-01-01T00:00:00Z", calibration_provenance: "smoke" } }));
    expect(verdict).toEqual({ excluded: true, reason: "explicit_exclude" });
  });

  it("ignores unrecognized calibration_usage values (not a false-positive exclude)", () => {
    const verdict = isExcluded(baseRecord({ inputs: { calibration_usage: "bogus-value" } }));
    expect(verdict.excluded).toBe(false);
  });

  it("ignores unrecognized calibration_provenance values", () => {
    const verdict = isExcluded(baseRecord({ inputs: { calibration_provenance: "made-up" } }));
    expect(verdict.excluded).toBe(false);
  });
});

describe("isExcluded — below calibration threshold", () => {
  it("excludes actuals below MINIMUM_CALIBRATION_ACTUAL_HOURS", () => {
    const verdict = isExcluded(baseRecord({ actual: { actualHours: MINIMUM_CALIBRATION_ACTUAL_HOURS - 0.001, reportedAt: "2026-01-01T00:00:00Z" } }));
    expect(verdict).toEqual({ excluded: true, reason: "below_calibration_threshold" });
  });

  it("keeps actuals at or above the threshold with a plausible ratio", () => {
    const verdict = isExcluded(baseRecord({ estimatedHours: 1, actual: { actualHours: MINIMUM_CALIBRATION_ACTUAL_HOURS + 0.05, reportedAt: "2026-01-01T00:00:00Z" } }));
    expect(verdict.excluded).toBe(false);
  });
});

describe("isExcluded — seed / smoke / industry-calibration notes", () => {
  it("excludes notes containing 'seed'", () => {
    expect(isExcluded(baseRecord({ actual: { actualHours: 8, notes: "seed data", reportedAt: "2026-01-01T00:00:00Z" } }))).toEqual({ excluded: true, reason: "seed_notes" });
  });

  it("excludes notes containing 'synthetic'", () => {
    expect(isExcluded(baseRecord({ actual: { actualHours: 8, notes: "synthetic baseline", reportedAt: "2026-01-01T00:00:00Z" } }))).toEqual({ excluded: true, reason: "seed_notes" });
  });

  it("excludes notes containing 'dogfood-seed'", () => {
    expect(isExcluded(baseRecord({ actual: { actualHours: 8, notes: "dogfood-seed run", reportedAt: "2026-01-01T00:00:00Z" } }))).toEqual({ excluded: true, reason: "seed_notes" });
  });

  it("excludes notes containing 'test data'", () => {
    expect(isExcluded(baseRecord({ actual: { actualHours: 8, notes: "test data batch", reportedAt: "2026-01-01T00:00:00Z" } }))).toEqual({ excluded: true, reason: "seed_notes" });
  });

  it("excludes tool='receiver_smoke'", () => {
    expect(isExcluded(baseRecord({ tool: "receiver_smoke", actual: { actualHours: 8, reportedAt: "2026-01-01T00:00:00Z" } }))).toEqual({ excluded: true, reason: "smoke" });
  });

  it("excludes notes containing 'receiver smoke'", () => {
    expect(isExcluded(baseRecord({ actual: { actualHours: 8, notes: "receiver smoke", reportedAt: "2026-01-01T00:00:00Z" } }))).toEqual({ excluded: true, reason: "smoke" });
  });

  it("excludes notes containing 'smoke test'", () => {
    expect(isExcluded(baseRecord({ actual: { actualHours: 8, notes: "smoke test run", reportedAt: "2026-01-01T00:00:00Z" } }))).toEqual({ excluded: true, reason: "smoke" });
  });

  it("excludes notes containing 'industry calibration'", () => {
    expect(isExcluded(baseRecord({ actual: { actualHours: 8, notes: "industry calibration batch v2", reportedAt: "2026-01-01T00:00:00Z" } }))).toEqual({ excluded: true, reason: "industry_calibration_note" });
  });
});

describe("isExcluded — 2026-05-05 backfill signature (exact-match epsilon AND date, BOTH required)", () => {
  it("excludes when ratio is exact AND estimatedAt falls on the backfill date", () => {
    const verdict = isExcluded(baseRecord({
      estimatedAt: `${BACKFILL_SIGNATURE_DATE}T09:00:00.000Z`,
      estimatedHours: 4,
      actual: { actualHours: 4, reportedAt: `${BACKFILL_SIGNATURE_DATE}T10:00:00.000Z` },
    }));
    expect(verdict).toEqual({ excluded: true, reason: "backfill_signature" });
  });

  it("excludes when ratio is within epsilon of exact AND date matches via actual.completedAt", () => {
    const verdict = isExcluded(baseRecord({
      estimatedAt: "2026-01-01T00:00:00.000Z",
      estimatedHours: 4,
      actual: { actualHours: 4.01, reportedAt: "2026-01-05T00:00:00.000Z", completedAt: `${BACKFILL_SIGNATURE_DATE}T10:00:00.000Z` },
    }));
    expect(verdict).toEqual({ excluded: true, reason: "backfill_signature" });
  });

  it("does NOT exclude an exact-match ratio on a different date (Pre-mortem Scenario 1 guard)", () => {
    const verdict = isExcluded(baseRecord({
      estimatedAt: "2026-06-10T09:00:00.000Z",
      estimatedHours: 4,
      actual: { actualHours: 4, reportedAt: "2026-06-10T10:00:00.000Z" },
    }));
    expect(verdict.excluded).toBe(false);
  });

  it("does NOT exclude a non-exact ratio on the backfill date", () => {
    const verdict = isExcluded(baseRecord({
      estimatedAt: `${BACKFILL_SIGNATURE_DATE}T09:00:00.000Z`,
      estimatedHours: 10,
      actual: { actualHours: 6, reportedAt: `${BACKFILL_SIGNATURE_DATE}T10:00:00.000Z` },
    }));
    expect(verdict.excluded).toBe(false);
  });

  it("keeps a legitimate low-variance pair on the backfill date whose ratio isn't exact", () => {
    // Guards against Scenario 1: quarantine over-matching and shrinking the clean corpus.
    const verdict = isExcluded(baseRecord({
      estimatedAt: `${BACKFILL_SIGNATURE_DATE}T09:00:00.000Z`,
      estimatedHours: 10,
      actual: { actualHours: 9.5, reportedAt: `${BACKFILL_SIGNATURE_DATE}T10:00:00.000Z` },
    }));
    expect(verdict.excluded).toBe(false);
  });
});

describe("isExcluded — ratio outlier", () => {
  it("excludes ratios below MIN_RATIO", () => {
    const verdict = isExcluded(baseRecord({ estimatedHours: 100, actual: { actualHours: 1, reportedAt: "2026-01-10T00:00:00Z" } }));
    expect(verdict).toEqual({ excluded: true, reason: "ratio_outlier" });
  });

  it("keeps ratios at or above MIN_RATIO", () => {
    const verdict = isExcluded(baseRecord({ estimatedHours: 100, actual: { actualHours: 100 * MIN_RATIO, reportedAt: "2026-01-10T00:00:00Z" } }));
    expect(verdict.excluded).toBe(false);
  });

  it("skips the ratio check when estimatedHours is unknown", () => {
    const verdict = isExcluded(baseRecord({ estimatedHours: null, actual: { actualHours: 0.001 + MINIMUM_CALIBRATION_ACTUAL_HOURS, reportedAt: "2026-01-10T00:00:00Z" } }));
    expect(verdict.excluded).toBe(false);
  });
});

describe("isExcluded — clean records", () => {
  it("does not exclude an ordinary matched record", () => {
    expect(isExcluded(baseRecord())).toEqual({ excluded: false });
  });

  it("is deterministic: repeated calls on the same input return the same verdict", () => {
    const record = baseRecord({ estimatedAt: `${BACKFILL_SIGNATURE_DATE}T09:00:00.000Z`, estimatedHours: 4, actual: { actualHours: 4, reportedAt: `${BACKFILL_SIGNATURE_DATE}T10:00:00.000Z` } });
    const now = new Date("2026-07-01T00:00:00Z");
    const first = isExcluded(record, now);
    const second = isExcluded(record, now);
    expect(second).toEqual(first);
  });
});
