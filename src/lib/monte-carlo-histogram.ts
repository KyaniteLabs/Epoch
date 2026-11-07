// Terminal-only metadata: weak keys retain neither results nor raw samples and
// cannot add fields to the JSON/MCP/HTTP contract.
interface Histogram {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly median: number;
  readonly p90: number;
  readonly counts: readonly number[];
}
const histograms = new WeakMap<object, Histogram>();

export function captureHistogram(result: object, sorted: readonly number[], median: number, p90: number): void {
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === undefined || max === undefined) return;
  const counts = Array<number>(20).fill(0);
  const binIndex = (value: number): number => max === min ? 0 : Math.min(19, Math.floor((value - min) / (max - min) * 20));
  for (const value of sorted) {
    const index = binIndex(value);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  histograms.set(result, { count: sorted.length, min, max, median, p90, counts });
}

export function renderHistogram(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const h = histograms.get(result);
  if (!h) return undefined;
  if (h.count === 1) return `Single completed iteration: ${h.min} days (no distribution).`;
  const width = (h.max - h.min) / 20;
  const maxCount = Math.max(...h.counts);
  const markerBin = (value: number): number => width === 0 ? 0 : Math.min(19, Math.floor((value - h.min) / (h.max - h.min) * 20));
  const lines = [`Duration histogram (days; ${h.count} completed iterations; 20 equal-width bins)`, "Intervals are [lower, upper), except the final bin includes its upper bound."];
  for (let i = 0; i < 20; i++) {
    const count = h.counts[i] ?? 0;
    const lower = h.min + i * width;
    const upper = i === 19 ? h.max : h.min + (i + 1) * width;
    const markers = [
      ...(i === markerBin(h.median) ? [`◀ Median (p50) = ${h.median} days`] : []),
      ...(i === markerBin(h.p90) ? [`◀ P90 = ${h.p90} days`] : []),
    ];
    const bar = "█".repeat(count === 0 ? 0 : Math.max(1, Math.round(count / maxCount * 32)));
    lines.push(`[${lower}, ${upper}${i === 19 ? "]" : ")"} ${bar} count=${count}${markers.length ? ` ${markers.join("; ")}` : ""}`);
  }
  if (width === 0) lines.push("All completed iterations have the same value; zero-width bins, all counts in the first bin.");
  return lines.join("\n");
}
