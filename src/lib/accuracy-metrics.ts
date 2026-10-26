/**
 * Accuracy metrics over completed estimates: pure arithmetic over records.
 *
 * A leaf module (it imports only types) so the ledger, feedback, risk and
 * trend code can share it without importing analytics, which is what used to
 * close the analytics -> self-improve -> feedback -> analytics import cycle.
 */
import type { AccuracyMetrics, HistoricalRecord } from "../types/index.js";

export function computeAccuracyMetrics(records: HistoricalRecord[]): AccuracyMetrics {
  if (records.length === 0) {
    return { mape: 0, mdape: 0, cappedMdape: 0, bias: 0, variance: 0, sample_size: 0, trend: "stable" };
  }

  const validRecords = records.filter(r => r.actualHours > 0);
  if (validRecords.length === 0) {
    return { mape: 0, mdape: 0, cappedMdape: 0, bias: 0, variance: 0, sample_size: 0, trend: "stable" };
  }

  const errors = validRecords.map(r => Math.abs(r.actualHours - r.estimatedHours) / r.actualHours);
  const mape = (errors.reduce((a, b) => a + b, 0) / errors.length) * 100;

  const sorted = [...errors].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const mdape = sorted.length % 2 === 0
    ? (((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) * 100
    : (sorted[mid] ?? 0) * 100;

  // Capped MdAPE: clamp individual errors at 500% before taking median.
  const CAP = 5.0;
  const capped = errors.map(e => Math.min(e, CAP)).sort((a, b) => a - b);
  const cappedMdape = capped.length % 2 === 0
    ? (((capped[mid - 1] ?? 0) + (capped[mid] ?? 0)) / 2) * 100
    : (capped[mid] ?? 0) * 100;

  const biases = validRecords.map(r => r.actualHours - r.estimatedHours);
  const bias = biases.reduce((a, b) => a + b, 0) / biases.length;

  const meanBias = bias;
  const variance = biases.reduce((sum, b) => sum + (b - meanBias) ** 2, 0) / biases.length;

  let trend: AccuracyMetrics["trend"] = "stable";
  if (validRecords.length >= 6) {
    const half = Math.floor(validRecords.length / 2);
    const firstHalf = validRecords.slice(0, half);
    const secondHalf = validRecords.slice(half);
    const mapeFirst = avgPercentageError(firstHalf);
    const mapeSecond = avgPercentageError(secondHalf);
    if (mapeSecond < mapeFirst * 0.85) trend = "improving";
    else if (mapeSecond > mapeFirst * 1.15) trend = "degrading";
  }

  return {
    mape: Math.round(mape * 10) / 10,
    mdape: Math.round(mdape * 10) / 10,
    cappedMdape: Math.round(cappedMdape * 10) / 10,
    bias: Math.round(bias * 10) / 10,
    variance: Math.round(variance * 10) / 10,
    sample_size: validRecords.length,
    trend,
  };
}

function avgPercentageError(records: HistoricalRecord[]): number {
  const valid = records.filter(r => r.actualHours > 0);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, r) => sum + Math.abs(r.actualHours - r.estimatedHours) / r.actualHours, 0) / valid.length * 100;
}
