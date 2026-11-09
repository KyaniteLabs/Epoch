// Terminal-only metadata: weak keys retain neither results nor raw samples and
// cannot add fields to the JSON/MCP/HTTP contract.
interface Histogram {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly median: number;
  readonly p90: number;
  readonly seed: number;
  readonly counts: readonly number[];
}
const histograms = new WeakMap<object, Histogram>();

export const HISTOGRAM_BINS = 20;
/** Chart width bounds (columns) and the default when no terminal width is known. */
export const MIN_COLUMNS = 40;
export const MAX_COLUMNS = 160;
export const DEFAULT_COLUMNS = 80;

export function captureHistogram(
  result: object,
  sorted: readonly number[],
  median: number,
  p90: number,
  seed = 42,
): void {
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (min === undefined || max === undefined) return;
  const counts = Array<number>(HISTOGRAM_BINS).fill(0);
  for (const value of sorted) {
    const index = binIndex(value, min, max);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  histograms.set(result, { count: sorted.length, min, max, median, p90, seed, counts });
}

function binIndex(value: number, min: number, max: number): number {
  return max === min ? 0 : Math.min(HISTOGRAM_BINS - 1, Math.floor((value - min) / (max - min) * HISTOGRAM_BINS));
}

export interface HistogramRenderOptions {
  /** Terminal width in columns; clamped to [40, 160]. Default 80. */
  columns?: number;
  /** Plain ASCII glyphs ("#", "<") for terminals without Unicode block elements. */
  ascii?: boolean;
}

// Eighth-block partials give 8x the bar resolution of whole blocks.
const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

function bar(eighths: number, ascii: boolean): string {
  if (ascii) return "#".repeat(Math.round(eighths / 8));
  return "█".repeat(Math.floor(eighths / 8)) + PARTIALS[eighths % 8];
}

/** Fewest decimals (0-6) that keep adjacent bin edges distinct at this bin width. */
function edgeDecimals(width: number): number {
  if (!(width > 0)) return 2;
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(width)) + 1));
}

/** A reported percentile field ("10.09") when present, else the value rounded like the fields are. */
function reported(result: Record<string, unknown>, field: string, fallback: number): string {
  const value = result[field];
  return typeof value === "string" && value !== "" ? value : String(Math.round(fallback * 100) / 100);
}

export function renderHistogram(result: unknown, options: HistogramRenderOptions = {}): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const h = histograms.get(result);
  if (!h) return undefined;
  const fields = result as Record<string, unknown>;
  const ascii = options.ascii === true;
  const columns = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.floor(options.columns ?? DEFAULT_COLUMNS)));
  const p50Label = `P50 ${reported(fields, "p50", h.median)}`;
  const p90Label = `P90 ${reported(fields, "p90", h.p90)}`;
  const runs = h.count.toLocaleString("en-US");

  if (h.count === 1) {
    return `No distribution: one iteration (${reported(fields, "p50", h.min)} days). Run more iterations to chart the spread.`;
  }

  // Every fixed line fits the 40-column minimum (bar the most extreme seeds).
  const dot = ascii ? " - " : " · ";
  const header = `8h days${dot}${runs} runs${dot}seed ${h.seed}`;
  const footer = "Simulated spread, not observed outcomes.";

  if (h.max === h.min) {
    // Point mass: every run produced the same total. One labelled row, not
    // 20 zero-width bins.
    return [
      header,
      `All runs: ${reported(fields, "p50", h.min)} days (point mass).`,
      "The estimates leave no spread to chart.",
      footer,
    ].join("\n");
  }

  const width = (h.max - h.min) / HISTOGRAM_BINS;
  const decimals = edgeDecimals(width);
  const edges = Array.from({ length: HISTOGRAM_BINS + 1 }, (_, i) =>
    (i === HISTOGRAM_BINS ? h.max : h.min + i * width).toFixed(decimals),
  );
  const edgeWidth = Math.max(...edges.map((e) => e.length));
  const maxCount = Math.max(...h.counts);
  const countWidth = String(maxCount).length;
  const medianBin = binIndex(h.median, h.min, h.max);
  const p90Bin = binIndex(h.p90, h.min, h.max);
  const pointer = ascii ? "<" : "◀";
  const markerFor = (i: number): string => {
    const labels = [...(i === medianBin ? [p50Label] : []), ...(i === p90Bin ? [p90Label] : [])];
    return labels.length ? `${pointer} ${labels.join(dot)}` : "";
  };
  const markerWidth = Math.max(...Array.from({ length: HISTOGRAM_BINS }, (_, i) => markerFor(i).length));
  // "[lo, hi) count " then the bar, then one space and the aligned marker column.
  const labelWidth = 2 * edgeWidth + 4;
  const barColumns = Math.max(4, columns - labelWidth - 1 - countWidth - 1 - 1 - markerWidth);

  const lines = [header];
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    const count = h.counts[i] ?? 0;
    const lower = (edges[i] ?? "").padStart(edgeWidth);
    const upper = (edges[i + 1] ?? "").padStart(edgeWidth);
    const label = `[${lower}, ${upper}${i === HISTOGRAM_BINS - 1 ? "]" : ")"}`;
    // Any non-empty bin shows at least the thinnest glyph.
    const eighths = count === 0 ? 0 : Math.max(ascii ? 8 : 1, Math.round((count / maxCount) * barColumns * 8));
    const drawn = bar(eighths, ascii);
    const marker = markerFor(i);
    const row = `${label} ${String(count).padStart(countWidth)} ${marker ? drawn.padEnd(barColumns) + " " + marker : drawn}`;
    lines.push(row.trimEnd());
  }
  lines.push("Bins [lo, hi); the last includes max.", footer);
  return lines.join("\n");
}
