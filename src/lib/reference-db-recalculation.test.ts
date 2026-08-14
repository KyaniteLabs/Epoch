import { describe, expect, it } from "vitest";
import { recalculateReferenceDatabase, computeTelemetryBenchmarks } from "./reference-db-recalculation.js";
import type { ToolCallRecord } from "./telemetry.js";

describe("recalculateReferenceDatabase", () => {
  it("uses prospective records for correction factors and holds backfilled/legacy receiver records out", () => {
    const estimates = [
      {
        id: "p1",
        tool: "reference_class_estimate",
        inputs: { task_type: "feature", complexity: 3 },
        outputs: { correctedEstimate: 10 },
        estimatedAt: "2026-05-08T10:00:00.000Z",
      },
      {
        id: "p2",
        tool: "reference_class_estimate",
        inputs: { task_type: "feature", complexity: 3 },
        outputs: { correctedEstimate: 10 },
        estimatedAt: "2026-05-08T11:00:00.000Z",
      },
      {
        id: "p3",
        tool: "reference_class_estimate",
        inputs: { task_type: "feature", complexity: 3 },
        outputs: { correctedEstimate: 10 },
        estimatedAt: "2026-05-08T12:00:00.000Z",
      },
      {
        id: "p4",
        tool: "reference_class_estimate",
        inputs: { task_type: "bugfix", complexity: 2 },
        outputs: { correctedEstimate: 10 },
        estimatedAt: "2026-05-08T13:00:00.000Z",
      },
      {
        id: "p5",
        tool: "reference_class_estimate",
        inputs: { task_type: "bugfix", complexity: 2 },
        outputs: { correctedEstimate: 10 },
        estimatedAt: "2026-05-08T14:00:00.000Z",
      },
      {
        id: "retro",
        tool: "reference_class_estimate",
        inputs: { task_type: "feature", complexity: 3 },
        outputs: { correctedEstimate: 10 },
        estimatedAt: "2026-05-08T15:00:00.000Z",
      },
    ];
    const actuals = [
      { estimateId: "p1", actualHours: 5, reportedAt: "2026-05-08T10:30:00.000Z" },
      { estimateId: "p2", actualHours: 5, reportedAt: "2026-05-08T11:30:00.000Z" },
      { estimateId: "p3", actualHours: 5, reportedAt: "2026-05-08T12:30:00.000Z" },
      { estimateId: "p4", actualHours: 7, reportedAt: "2026-05-08T13:30:00.000Z" },
      { estimateId: "p5", actualHours: 7, reportedAt: "2026-05-08T14:30:00.000Z" },
      {
        estimateId: "retro",
        actualHours: 30,
        completedAt: "2026-05-07T15:00:00.000Z",
        reportedAt: "2026-05-08T15:30:00.000Z",
      },
    ];

    const { db, summary } = recalculateReferenceDatabase(
      {
        taskTypeCorrectionFactors: { feature: 1.8 },
        toolTaskCorrectionFactors: {},
        complexityCorrectionFactors: {},
        globalCorrectionFactor: 1.8,
      },
      {
        generatedAt: "2026-05-09T00:00:00.000Z",
        sources: [
          { name: "sender", estimates, actuals },
          {
            name: "windows-receiver",
            receiverRecords: [
              {
                task_type: "feature",
                complexity: 3,
                tool: "reference_class_estimate",
                estimated_hours: 10,
                actual_hours: 50,
                ratio: 5,
                date: "2026-05-08",
              },
              {
                task_type: "testing",
                complexity: 1,
                tool: "receiver_smoke",
                estimated_hours: 1,
                actual_hours: 1,
                ratio: 1,
                date: "2026-05-08",
              },
            ],
          },
        ],
      },
    );

    expect(db.globalCorrectionFactor).toBe(0.5);
    expect(db.taskTypeCorrectionFactors).toEqual({ feature: 0.5 });
    expect(db.toolTaskCorrectionFactors).toEqual({
      reference_class_estimate: { feature: 0.5 },
    });
    expect(db.complexityCorrectionFactors).toEqual({ feature: { 3: 0.5 } });
    expect(summary.correctionRecords).toBe(5);
    expect(summary.baselineRecords).toBe(2);
    expect(summary.legacyReceiverBaselineRecords).toBe(1);
    expect(summary.excludedRecords).toBe(1);
  });

  it("recomputes tool execution benchmarks from telemetry events", () => {
    const telemetryEvents: ToolCallRecord[] = [
      { timestamp: "2026-05-09T00:00:00.000Z", tool: "pert_estimate", inputHash: "a", outputOk: true, elapsedMs: 1 },
      { timestamp: "2026-05-09T00:00:01.000Z", tool: "pert_estimate", inputHash: "b", outputOk: true, elapsedMs: 3 },
      { timestamp: "2026-05-09T00:00:02.000Z", tool: "pert_estimate", inputHash: "c", outputOk: false, elapsedMs: 5 },
    ];

    const { db, summary } = recalculateReferenceDatabase(
      {
        taskTypeCorrectionFactors: {},
        toolTaskCorrectionFactors: {},
        complexityCorrectionFactors: {},
        globalCorrectionFactor: 1.07,
      },
      {
        generatedAt: "2026-05-09T00:00:00.000Z",
        sources: [{ name: "sender", telemetryEvents }],
      },
    );

    expect(summary.telemetryEvents).toBe(3);
    expect(db.sampleSize).toBe(3);
    expect(db.toolExecutionBenchmarks?.pert_estimate).toMatchObject({
      p50_ms: 3,
      p95_ms: 5,
      mean_ms: 3,
      sampleCount: 3,
    });
  });

  it("uses ceil-rank percentiles: p95 of an n=20 sample is the 19th value, not the max (W2 fix)", () => {
    const telemetryEvents: ToolCallRecord[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `2026-05-09T00:00:${String(i).padStart(2, "0")}.000Z`,
      tool: "pert_estimate",
      inputHash: `h${i}`,
      outputOk: true,
      elapsedMs: i + 1, // 1..20
    }));

    const benchmarks = computeTelemetryBenchmarks(telemetryEvents);
    // Old floor-rank index returned floor(0.95*20) = 19 -> the max (20).
    // Ceil-rank: ceil(0.95*20)-1 = 18 -> the 19th order statistic.
    expect(benchmarks.pert_estimate?.p95_ms).toBe(19);
    expect(benchmarks.pert_estimate?.max_ms).toBe(20);
    // Median at n=20: ceil(10)-1 = index 9 -> 10th order statistic.
    expect(benchmarks.pert_estimate?.p50_ms).toBe(10);
  });

  it("median rank is correct at n=1000 under ceil-rank", () => {
    const telemetryEvents: ToolCallRecord[] = Array.from({ length: 1000 }, (_, i) => ({
      timestamp: "2026-05-09T00:00:00.000Z",
      tool: "pert_estimate",
      inputHash: `h${i}`,
      outputOk: true,
      elapsedMs: i + 1, // 1..1000
    }));

    const benchmarks = computeTelemetryBenchmarks(telemetryEvents);
    // ceil(0.5*1000)-1 = 499 -> the 500th order statistic.
    expect(benchmarks.pert_estimate?.p50_ms).toBe(500);
    expect(benchmarks.pert_estimate?.p95_ms).toBe(950);
  });

  it("deduplicates receiver backfills that already exist in source feedback", () => {
    const estimates = Array.from({ length: 5 }, (_, index) => ({
      id: `p${index}`,
      tool: "pert_estimate",
      inputs: { task_type: "feature", complexity: 2 },
      outputs: { estimatedHours: 10 },
      estimatedAt: `2026-05-07T1${index}:00:00.000Z`,
    }));
    const actuals = estimates.map((estimate, index) => ({
      estimateId: estimate.id,
      actualHours: 5,
      completedAt: "2026-05-08",
      reportedAt: `2026-05-08T1${index}:45:00.000Z`,
    }));

    const { db, summary } = recalculateReferenceDatabase(
      {
        taskTypeCorrectionFactors: {},
        toolTaskCorrectionFactors: {},
        complexityCorrectionFactors: {},
        globalCorrectionFactor: 1.8,
      },
      {
        generatedAt: "2026-05-09T00:00:00.000Z",
        sources: [
          { name: "sender", estimates, actuals },
          {
            name: "windows-receiver",
            receiverRecords: actuals.map((actual) => ({
              task_type: "feature",
              complexity: 2,
              tool: "pert_estimate",
              estimated_hours: 10,
              actual_hours: 5,
              ratio: 0.5,
              date: actual.completedAt.slice(0, 10),
              received_at: "2026-05-09T00:00:00.000Z",
              calibration_provenance: "prospective",
              calibration_usage: "correction",
            })),
          },
        ],
      },
    );

    expect(db.globalCorrectionFactor).toBe(0.5);
    expect(db.sampleSize).toBe(5);
    expect(summary.correctionRecords).toBe(5);
    expect(summary.duplicateCorrectionRecords).toBe(5);
  });

  it("keeps receiver corrections with the same day and rounded hours when source records have distinct timestamps", () => {
    const estimates = Array.from({ length: 5 }, (_, index) => ({
      id: `p${index}`,
      tool: "pert_estimate",
      inputs: { task_type: "feature", complexity: 2 },
      outputs: { estimatedHours: 10 },
      estimatedAt: `2026-05-08T1${index}:00:00.000Z`,
    }));
    const actuals = estimates.map((estimate, index) => ({
      estimateId: estimate.id,
      actualHours: 5,
      completedAt: `2026-05-08T1${index}:30:00.000Z`,
      reportedAt: `2026-05-08T1${index}:45:00.000Z`,
    }));

    const { summary } = recalculateReferenceDatabase(
      {
        taskTypeCorrectionFactors: {},
        toolTaskCorrectionFactors: {},
        complexityCorrectionFactors: {},
        globalCorrectionFactor: 1.8,
      },
      {
        generatedAt: "2026-05-09T00:00:00.000Z",
        sources: [
          { name: "sender", estimates, actuals },
          {
            name: "windows-receiver",
            receiverRecords: [
              {
                task_type: "feature",
                complexity: 2,
                tool: "pert_estimate",
                estimated_hours: 10,
                actual_hours: 5,
                ratio: 0.5,
                date: "2026-05-08",
                received_at: "2026-05-09T00:00:00.000Z",
                calibration_provenance: "prospective",
                calibration_usage: "correction",
              },
            ],
          },
        ],
      },
    );

    expect(summary.correctionRecords).toBe(6);
    expect(summary.duplicateCorrectionRecords).toBe(0);
  });

});
