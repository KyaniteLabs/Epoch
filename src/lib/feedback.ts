/** Feedback pipeline — public barrel (split, L6).

    The implementation now lives in three modules with a strict downward
    dependency order:
      feedback-ledger.ts    — ingest, dedup, JSONL append, dry-run routing
      feedback-analytics.ts — actuals intake, matching, calibration, batch
      feedback-health.ts    — the health report
    This module re-exports the original public surface unchanged, so every
    existing importer (26 files) is untouched. The characterization golden
    (feedback-split.golden.test.ts) pins the behavior byte-for-byte. */
export type { EstimateRecord, ActualRecord } from "./ledger.js";

export {
  getDedupHitCount,
  getBatchAppendWriteCallCount,
  recordEstimate,
  recordToolCall,
} from "./feedback-ledger.js";
export type { ToolCallRecord } from "./feedback-ledger.js";

export {
  ESTIMATE_UNIT_TO_HOURS,
  UNIT_SUSPECT_FLAG_HINT,
  minNForVerdict,
  recordActual,
  recordActualDetailed,
  getPendingEstimates,
  hasEstimateForSession,
  getCalibrationData,
  matchEstimatesToActuals,
  extractEstimatedHours,
  batchRecordActuals,
} from "./feedback-analytics.js";
export type { ActualUnit, RecordActualResult, BatchActualEntry, BatchResult } from "./feedback-analytics.js";

export {
  getFeedbackHealthReport,
  FEEDBACK_HEALTH_CALIBRATION_TOOLS,
} from "./feedback-health.js";
export type { FeedbackHealthReport } from "./feedback-health.js";
