// ---------------------------------------------------------------------------
// Epoch Calibration Dashboard — HTML renderer (Phase 6)
// ---------------------------------------------------------------------------
//
// Pure presentation layer: takes a DashboardData object (computed read-only
// by src/lib/dashboard-data.ts) and renders one self-contained HTML string.
// No I/O here — scripts/build-calibration-dashboard.mjs owns reading the
// dataset and writing the file. Self-contained: inline CSS + JS only, no
// external fetch(), no CDN, works from file://.
//
// Design tokens (colors/spacing/type scale) live entirely in the <style>
// block's CSS custom properties; this renderer never emits a raw hex color
// or literal px font-size in a generated element's inline style — every
// visual choice is a CSS class defined once in the stylesheet.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 6.

// ---- Small formatting helpers ----------------------------------------------

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtInt(n) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US");
}

function fmtPct(n, decimals = 1) {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(decimals)}%`;
}

function fmtRatio(n, decimals = 2) {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(decimals)}×`;
}

function fmtRate01(n, decimals = 1) {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
}

function fmtBias(n) {
  if (n === null || n === undefined) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}h`;
}

const TREND_LABELS = {
  improving: "improving",
  degrading: "degrading",
  stable: "stable",
};

function trendBadge(trend) {
  if (!trend) return `<span class="badge badge--muted">no data</span>`;
  const tone = trend === "improving" ? "success" : trend === "degrading" ? "danger" : "muted";
  const arrow = trend === "improving" ? "↓" : trend === "degrading" ? "↑" : "→";
  return `<span class="badge badge--${tone}">${arrow} ${esc(TREND_LABELS[trend] ?? trend)}</span>`;
}

function gateBadge(gated, minN) {
  return gated
    ? `<span class="badge badge--warning">gated (n&lt;${minN})</span>`
    : `<span class="badge badge--success">ok</span>`;
}

function boolBadge(value, trueLabel, falseLabel) {
  return value
    ? `<span class="badge badge--success">${esc(trueLabel)}</span>`
    : `<span class="badge badge--danger">${esc(falseLabel)}</span>`;
}

// ---- Section header ----------------------------------------------------------

function sectionHeader(num, title, soWhat) {
  return `
    <header class="section-header">
      <h2 id="section-${num}"><span class="section-number">${num}</span>${esc(title)}</h2>
      ${soWhat ? `<p class="so-what">${esc(soWhat)}</p>` : ""}
    </header>`;
}

// ---- Section 1: Headline ------------------------------------------------------

function renderStatTile(label, value, sub) {
  return `
    <div class="stat-tile">
      <div class="stat-tile__label">${esc(label)}</div>
      <div class="stat-tile__value">${value}</div>
      ${sub ? `<div class="stat-tile__sub">${sub}</div>` : ""}
    </div>`;
}

function renderHeadline(data) {
  const h = data.headline;
  return `
    <section aria-labelledby="section-1" class="panel">
      ${sectionHeader(1, "Headline", h.soWhat)}
      <div class="stat-grid">
        ${renderStatTile("Matched pairs", fmtInt(h.matchedPairs), `of ${fmtInt(h.totalEstimates)} estimates / ${fmtInt(h.totalActuals)} actuals`)}
        ${renderStatTile("Capped MdAPE", fmtPct(h.cappedMdape, 0), "median % error, outliers clamped at 500%")}
        ${renderStatTile("Match rate", fmtPct(h.matchRate), "estimates with a recorded actual")}
        ${renderStatTile("Accuracy trend", trendBadge(h.trend), h.trendMinNGated ? `below min-n=${h.minNForVerdict} — informational only` : "windowed MdAPE comparison")}
      </div>
      <p class="note">${esc(h.trendHumanReadable)}</p>
      <p class="note">${esc(h.recommendation)}</p>
      <h3 class="subhead">What changed under remediation</h3>
      <ul class="note-list">
        ${h.remediationNotes.map((n) => `<li>${esc(n)}</li>`).join("")}
      </ul>
    </section>`;
}

// ---- Sections 2 & 3: calibration tables ---------------------------------------

function renderCalibrationTable(num, title, soWhat, rows, minN, keyLabel) {
  const body = rows.length === 0
    ? `<tr><td colspan="9" class="empty-cell">No data.</td></tr>`
    : rows.map((r) => `
      <tr>
        <td class="cell--key"><code>${esc(r.key)}</code></td>
        <td class="cell--num">${fmtInt(r.estimates)}</td>
        <td class="cell--num">${fmtInt(r.actuals)}</td>
        <td class="cell--num">${fmtInt(r.matchedPairs)}</td>
        <td class="cell--num">${fmtRatio(r.medianActualOverPredicted)}</td>
        <td class="cell--num">${fmtPct(r.mdape, 1)}</td>
        <td class="cell--num">${fmtPct(r.cappedMdape, 1)}</td>
        <td class="cell--num">${fmtBias(r.bias)}</td>
        <td>${trendBadge(r.trend)}</td>
        <td>${gateBadge(r.minNGated, minN)}</td>
      </tr>`).join("");

  return `
    <section aria-labelledby="section-${num}" class="panel">
      ${sectionHeader(num, title, soWhat)}
      <div class="table-scroll">
        <table>
          <caption class="sr-only">${esc(title)}</caption>
          <thead>
            <tr>
              <th scope="col">${esc(keyLabel)}</th>
              <th scope="col">Estimates</th>
              <th scope="col">Actuals</th>
              <th scope="col">Matched</th>
              <th scope="col">Median actual/predicted</th>
              <th scope="col">MdAPE</th>
              <th scope="col">Capped MdAPE</th>
              <th scope="col">Bias</th>
              <th scope="col">Trend</th>
              <th scope="col">Min-n gate</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </section>`;
}

// ---- Section 4: PERT learned-correction status --------------------------------

const BAND_CHART_WIDTH = 640;
const BAND_CHART_HEIGHT = 96;
const BAND_CHART_PAD_X = 24;
const BAND_CHART_AXIS_Y = 56;
const BAND_CHART_MAX_RATIO = 1.6;

function ratioToX(ratio) {
  const usable = BAND_CHART_WIDTH - BAND_CHART_PAD_X * 2;
  const clamped = Math.max(0, Math.min(BAND_CHART_MAX_RATIO, ratio));
  return BAND_CHART_PAD_X + (clamped / BAND_CHART_MAX_RATIO) * usable;
}

function renderBandChart(backtest, tier1Band) {
  if (!backtest.ok) {
    return `<p class="note">${esc(backtest.recommendation)}</p>`;
  }
  const [lo, hi] = tier1Band;
  const bandX0 = ratioToX(lo);
  const bandX1 = ratioToX(hi);
  const centerX = ratioToX(1);
  const currentX = backtest.current.medianActualOverPredicted !== null ? ratioToX(backtest.current.medianActualOverPredicted) : null;
  const correctedX = backtest.corrected.medianActualOverPredicted !== null ? ratioToX(backtest.corrected.medianActualOverPredicted) : null;
  const ticks = [0, 0.5, 1.0, 1.5];

  return `
    <figure class="chart-figure">
      <svg viewBox="0 0 ${BAND_CHART_WIDTH} ${BAND_CHART_HEIGHT}" role="img" aria-label="Median actual over predicted ratio, current ${fmtRatio(backtest.current.medianActualOverPredicted)} versus corrected ${fmtRatio(backtest.corrected.medianActualOverPredicted)}, against the Tier-1 target band ${lo} to ${hi}">
        <line x1="${BAND_CHART_PAD_X}" y1="${BAND_CHART_AXIS_Y}" x2="${BAND_CHART_WIDTH - BAND_CHART_PAD_X}" y2="${BAND_CHART_AXIS_Y}" class="chart-axis" />
        <rect x="${bandX0}" y="${BAND_CHART_AXIS_Y - 10}" width="${bandX1 - bandX0}" height="20" class="chart-band" />
        <line x1="${centerX}" y1="${BAND_CHART_AXIS_Y - 18}" x2="${centerX}" y2="${BAND_CHART_AXIS_Y + 18}" class="chart-center-line" />
        <text x="${centerX}" y="${BAND_CHART_AXIS_Y - 24}" text-anchor="middle" class="chart-label">1.0 (perfect)</text>
        ${ticks.map((t) => `<line x1="${ratioToX(t)}" y1="${BAND_CHART_AXIS_Y + 10}" x2="${ratioToX(t)}" y2="${BAND_CHART_AXIS_Y + 16}" class="chart-tick" /><text x="${ratioToX(t)}" y="${BAND_CHART_AXIS_Y + 32}" text-anchor="middle" class="chart-tick-label">${t.toFixed(1)}×</text>`).join("")}
        ${currentX !== null ? `<circle cx="${currentX}" cy="${BAND_CHART_AXIS_Y}" r="6" class="chart-marker chart-marker--current" /><text x="${currentX}" y="${BAND_CHART_AXIS_Y - 30}" text-anchor="middle" class="chart-marker-label chart-marker-label--current">current ${fmtRatio(backtest.current.medianActualOverPredicted)}</text>` : ""}
        ${correctedX !== null ? `<circle cx="${correctedX}" cy="${BAND_CHART_AXIS_Y}" r="6" class="chart-marker chart-marker--corrected" /><text x="${correctedX}" y="${BAND_CHART_AXIS_Y + 46}" text-anchor="middle" class="chart-marker-label chart-marker-label--corrected">corrected ${fmtRatio(backtest.corrected.medianActualOverPredicted)}</text>` : ""}
      </svg>
      <figcaption class="chart-caption">Shaded band = Tier-1 target [${lo}, ${hi}]. Held-out test split (n=${fmtInt(backtest.testPairs)} of ${fmtInt(backtest.totalMatchedPairs)} matched pert_estimate pairs, trained on the other ${fmtInt(backtest.trainPairs)}).</figcaption>
    </figure>`;
}

function renderPertSection(data) {
  const p = data.pert;
  const b = p.backtest;
  return `
    <section aria-labelledby="section-4" class="panel">
      ${sectionHeader(4, "PERT learned-correction status", "This is the headline fix from the remediation plan — it is not live yet.")}
      <div class="stat-grid stat-grid--three">
        ${renderStatTile("Flag state", boolBadge(p.flagEnabled, "ON", "OFF"), p.envVar)}
        ${renderStatTile("Backtest guard", b.ok ? boolBadge(b.guards.correctedMdapeLeCurrentMdape, "MdAPE improves", "MdAPE regresses") : "—", b.ok ? `${fmtPct(b.current.mdapePercent)} → ${fmtPct(b.corrected.mdapePercent)}` : "no data")}
        ${renderStatTile("Tier-1 band guard", b.ok ? boolBadge(b.guards.tier1BandMet, "in band", "outside band") : "—", `target [${p.tier1Band[0]}, ${p.tier1Band[1]}]`)}
      </div>
      ${renderBandChart(b, p.tier1Band)}
      <p class="note"><strong>${esc(b.recommendation)}</strong></p>
      <p class="note">Composition rule: the learned (tool, task_type) correction factor replaces the developer-profile heuristic only once a cell has n ≥ 3 matched pairs; below that, the profile factor (or a neutral 1.0 with a low-n note) is kept — never both multiplied together.</p>
    </section>`;
}

// ---- Section 5: interval coverage ----------------------------------------------

const COV_CHART_WIDTH = 640;
const COV_BAR_HEIGHT = 18;
const COV_BAR_GAP = 10;
const COV_LABEL_WIDTH = 130;
const COV_CHART_PAD_TOP = 20;
const COV_TARGET_RATE = 0.8;

function renderCoverageChart(rows) {
  if (rows.length === 0) return `<p class="note">No task types with enough matched pairs to score coverage.</p>`;
  const barAreaWidth = COV_CHART_WIDTH - COV_LABEL_WIDTH - 60;
  const height = COV_CHART_PAD_TOP + rows.length * (COV_BAR_HEIGHT + COV_BAR_GAP) + 24;
  const targetX = COV_LABEL_WIDTH + COV_TARGET_RATE * barAreaWidth;

  const bars = rows.map((r, i) => {
    const y = COV_CHART_PAD_TOP + i * (COV_BAR_HEIGHT + COV_BAR_GAP);
    const rate = r.p80CoverageRate ?? 0;
    const barWidth = Math.max(0, Math.min(1, rate)) * barAreaWidth;
    const tone = r.p80CoverageRate === null ? "muted" : Math.abs(rate - COV_TARGET_RATE) <= 0.05 ? "success" : rate < COV_TARGET_RATE ? "warning" : "info";
    return `
      <text x="${COV_LABEL_WIDTH - 10}" y="${y + COV_BAR_HEIGHT * 0.75}" text-anchor="end" class="chart-label">${esc(r.taskType)} (n=${fmtInt(r.n)})</text>
      <rect x="${COV_LABEL_WIDTH}" y="${y}" width="${barAreaWidth}" height="${COV_BAR_HEIGHT}" class="chart-bar-track" />
      <rect x="${COV_LABEL_WIDTH}" y="${y}" width="${barWidth}" height="${COV_BAR_HEIGHT}" class="chart-bar chart-bar--${tone}" />
      <text x="${COV_LABEL_WIDTH + barWidth + 8}" y="${y + COV_BAR_HEIGHT * 0.75}" class="chart-value-label">${fmtRate01(r.p80CoverageRate)}</text>`;
  }).join("");

  return `
    <figure class="chart-figure">
      <svg viewBox="0 0 ${COV_CHART_WIDTH} ${height}" role="img" aria-label="P80 interval coverage rate by task type, against an 80 percent target">
        <line x1="${targetX}" y1="${COV_CHART_PAD_TOP - 8}" x2="${targetX}" y2="${height - 16}" class="chart-target-line" />
        <text x="${targetX}" y="${height - 4}" text-anchor="middle" class="chart-tick-label">target 80%</text>
        ${bars}
      </svg>
      <figcaption class="chart-caption">Fraction of matched actuals landing inside their predicted P80 interval, per task type. In-sample sanity check, not out-of-sample validation.</figcaption>
    </figure>`;
}

function renderCoverageSection(data) {
  const c = data.coverage;
  const overallGap = c.overall.p80CoverageRate === null ? null : c.overall.p80CoverageRate - c.overall.target;
  const soWhat = c.overall.p80CoverageRate === null
    ? "Not enough scored pairs yet to judge interval coverage."
    : overallGap >= -0.05
      ? "Coverage is close to the 80% target — predicted intervals are roughly honest."
      : "Coverage is running below the 80% target — predicted P80 intervals are too narrow (overconfident) for at least some task types below.";
  return `
    <section aria-labelledby="section-5" class="panel">
      ${sectionHeader(5, "Interval coverage (P80)", soWhat)}
      <div class="stat-grid stat-grid--three">
        ${renderStatTile("Overall P80 coverage", fmtRate01(c.overall.p80CoverageRate), `target ${fmtRate01(c.overall.target)}`)}
        ${renderStatTile("Scored pairs", fmtInt(c.overall.n), "matched pairs with a predictable interval")}
        ${renderStatTile("Task types covered", fmtInt(c.rows.filter((r) => r.p80CoverageRate !== null).length), `of ${fmtInt(c.rows.length)} total`)}
      </div>
      ${renderCoverageChart(c.rows)}
      <p class="note">${esc(c.note)}</p>
    </section>`;
}

// ---- Section 6: data-integrity audit -------------------------------------------

function renderIntegritySection(data) {
  const i = data.integrity;
  return `
    <section aria-labelledby="section-6" class="panel">
      ${sectionHeader(6, "Data-integrity audit", "Quarantine, orphans, and labels are visible here via the shared overlay-merge loader — Sections 1-3 now merge the same overlay flags, so these counts agree.")}
      <div class="stat-grid">
        ${renderStatTile("Quarantined", fmtInt(i.quarantine.count), `${esc(i.quarantine.backfillSignatureDate)} exact-match backfill signature, overlay flag`)}
        ${renderStatTile("Retro-labeled", fmtInt(i.labels.count), "task_label overlay records")}
        ${renderStatTile("Orphaned actuals", fmtInt(i.orphans.total), `${fmtInt(i.orphans.testFixtureLeakage)} test-fixture leakage, ${fmtInt(i.orphans.unresolved)} unresolved`)}
        ${renderStatTile("Expired pending", fmtInt(i.expiredPending.count), `TTL ${i.expiredPending.ttlDays} days`)}
        ${renderStatTile("Task-type overlay", fmtInt(i.taskTypeOverlay.count), "not yet merged by the shared loader")}
        ${renderStatTile("Physically archived", fmtInt(i.archive.count), "moved out of the hot ledger")}
        ${renderStatTile("Dedup", boolBadge(i.dedup.enabled, "enabled", "disabled"), i.dedup.enabled ? `${i.dedup.windowMinutes}min window, ${fmtInt(i.dedup.hitCount)} hits this run` : "EPOCH_DEDUP_WINDOW unset")}
      </div>
      <p class="note">${esc(i.orphans.note)}</p>
      <p class="note">${esc(i.taskTypeOverlay.note)}</p>
      <p class="note">${esc(i.dedup.note)}</p>
      <h3 class="subhead">Known limitations</h3>
      <ul class="note-list note-list--warning">
        ${data.knownLimitations.map((n) => `<li>${esc(n)}</li>`).join("")}
      </ul>
    </section>`;
}

// ---- Section 7: footer -----------------------------------------------------------

function renderFooter(data) {
  return `
    <footer class="page-footer">
      <p>Generated ${esc(data.generatedAt)} · data dir <code>${esc(data.dataDir)}</code></p>
      <p>${esc(data.reconciliationNote)}</p>
    </footer>`;
}

// ---- Theme toggle (the only client-side script) ---------------------------------

const THEME_TOGGLE_SCRIPT = `
(function () {
  var root = document.documentElement;
  var STORAGE_KEY = "epoch-dashboard-theme";
  function apply(theme) {
    if (theme === "light" || theme === "dark") {
      root.setAttribute("data-theme", theme);
    } else {
      root.removeAttribute("data-theme");
    }
    var btn = document.getElementById("theme-toggle");
    if (btn) btn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  }
  var saved = null;
  try { saved = window.localStorage.getItem(STORAGE_KEY); } catch (e) { saved = null; }
  apply(saved);
  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var current = root.getAttribute("data-theme");
      var system = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      var effective = current || system;
      var next = effective === "dark" ? "light" : "dark";
      apply(next);
      try { window.localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
    });
  }
})();
`;

// ---- Stylesheet -------------------------------------------------------------------

const STYLE = `
  :root {
    color-scheme: light dark;
    --font-sans: "IBM Plex Sans", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
    --font-mono: "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

    --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
    --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;

    --radius-sm: 4px; --radius-md: 8px; --radius-lg: 14px;

    --font-size-xs: 11px; --font-size-sm: 12px; --font-size-base: 14px;
    --font-size-md: 16px; --font-size-lg: 20px; --font-size-xl: 28px; --font-size-2xl: 36px;

    --bg: #f7f8fb;
    --bg-elevated: #ffffff;
    --bg-inset: #eef0f5;
    --border: #d8dce6;
    --text-primary: #12161f;
    --text-secondary: #434b5e;
    --text-muted: #6b7385;
    --accent: #0f8b8d;
    --accent-soft: #d3f3ef;
    --warning: #9a5b06;
    --warning-soft: #fdecc8;
    --danger: #a91c1c;
    --danger-soft: #fbdada;
    --success: #157a3d;
    --success-soft: #d9f3e2;
    --focus-ring: #1d4ed8;
    --shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.05);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0e14;
      --bg-elevated: #12161f;
      --bg-inset: #181d29;
      --border: #262c3b;
      --text-primary: #e7eaf1;
      --text-secondary: #aab0c2;
      --text-muted: #7a8298;
      --accent: #2dd4c8;
      --accent-soft: #113531;
      --warning: #f0b429;
      --warning-soft: #3a2c0c;
      --danger: #f87171;
      --danger-soft: #3a1414;
      --success: #34d399;
      --success-soft: #0f2f22;
      --focus-ring: #60a5fa;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.35);
    }
  }

  :root[data-theme="light"] {
    --bg: #f7f8fb; --bg-elevated: #ffffff; --bg-inset: #eef0f5; --border: #d8dce6;
    --text-primary: #12161f; --text-secondary: #434b5e; --text-muted: #6b7385;
    --accent: #0f8b8d; --accent-soft: #d3f3ef;
    --warning: #9a5b06; --warning-soft: #fdecc8;
    --danger: #a91c1c; --danger-soft: #fbdada;
    --success: #157a3d; --success-soft: #d9f3e2;
    --focus-ring: #1d4ed8;
    --shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.05);
  }

  :root[data-theme="dark"] {
    --bg: #0b0e14; --bg-elevated: #12161f; --bg-inset: #181d29; --border: #262c3b;
    --text-primary: #e7eaf1; --text-secondary: #aab0c2; --text-muted: #7a8298;
    --accent: #2dd4c8; --accent-soft: #113531;
    --warning: #f0b429; --warning-soft: #3a2c0c;
    --danger: #f87171; --danger-soft: #3a1414;
    --success: #34d399; --success-soft: #0f2f22;
    --focus-ring: #60a5fa;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.35);
  }

  * { box-sizing: border-box; }

  html, body { margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--font-size-base);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }

  .skip-link {
    position: absolute; left: var(--space-3); top: -48px;
    background: var(--accent); color: var(--bg-elevated);
    padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm);
    z-index: 100; transition: top 0.15s ease;
    text-decoration: none; font-weight: 600;
  }
  .skip-link:focus { top: var(--space-3); }

  a { color: var(--accent); }

  :focus-visible {
    outline: 3px solid var(--focus-ring);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .page-header {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
    padding: var(--space-4) var(--space-6);
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
  }
  .page-header h1 { font-size: var(--font-size-lg); margin: 0; }
  .page-header .meta { color: var(--text-muted); font-size: var(--font-size-sm); font-family: var(--font-mono); }

  #theme-toggle {
    font-family: var(--font-sans);
    font-size: var(--font-size-sm);
    background: var(--bg-inset);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-4);
    cursor: pointer;
  }
  #theme-toggle:hover { border-color: var(--accent); }

  main { max-width: 1100px; margin: 0 auto; padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-6); }

  nav.toc { padding: var(--space-4) var(--space-6) 0; max-width: 1100px; margin: 0 auto; }
  nav.toc ul { display: flex; flex-wrap: wrap; gap: var(--space-2); list-style: none; padding: 0; margin: var(--space-2) 0 0; }
  nav.toc a {
    display: inline-block; text-decoration: none; font-size: var(--font-size-sm);
    padding: var(--space-1) var(--space-3); border-radius: var(--radius-md);
    background: var(--bg-inset); color: var(--text-secondary); border: 1px solid var(--border);
  }
  nav.toc a:hover { color: var(--accent); border-color: var(--accent); }

  .panel {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-5) var(--space-6);
    box-shadow: var(--shadow);
  }

  .section-header h2 {
    font-size: var(--font-size-md);
    margin: 0 0 var(--space-2);
    display: flex; align-items: baseline; gap: var(--space-3);
  }
  .section-number {
    font-family: var(--font-mono);
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }
  .so-what {
    margin: 0 0 var(--space-4);
    color: var(--text-secondary);
    font-size: var(--font-size-base);
    border-left: 3px solid var(--accent);
    padding-left: var(--space-3);
  }

  .subhead { font-size: var(--font-size-base); margin: var(--space-5) 0 var(--space-2); }

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }
  .stat-grid--three { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }

  .stat-tile {
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }
  .stat-tile__label { font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: var(--space-2); }
  .stat-tile__value { font-family: var(--font-mono); font-size: var(--font-size-xl); font-weight: 600; line-height: 1.1; }
  .stat-tile__sub { font-size: var(--font-size-xs); color: var(--text-muted); margin-top: var(--space-2); }

  .note { color: var(--text-secondary); font-size: var(--font-size-sm); margin: var(--space-2) 0; }
  .note-list { margin: var(--space-2) 0; padding-left: var(--space-5); color: var(--text-secondary); font-size: var(--font-size-sm); }
  .note-list li { margin-bottom: var(--space-2); }
  .note-list--warning { border-left: 3px solid var(--warning); padding-left: var(--space-4); list-style: none; margin-left: 0; }

  .badge {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    padding: 2px var(--space-2);
    border-radius: 999px;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .badge--success { background: var(--success-soft); color: var(--success); border-color: var(--success); }
  .badge--danger { background: var(--danger-soft); color: var(--danger); border-color: var(--danger); }
  .badge--warning { background: var(--warning-soft); color: var(--warning); border-color: var(--warning); }
  .badge--muted { background: var(--bg-inset); color: var(--text-muted); border-color: var(--border); }

  .table-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
  table { border-collapse: collapse; width: 100%; min-width: 780px; font-size: var(--font-size-sm); }
  thead th {
    position: sticky; top: 0;
    background: var(--bg-inset);
    text-align: left; font-weight: 600;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  tbody td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); white-space: nowrap; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--bg-inset); }
  .cell--key code { font-family: var(--font-mono); }
  .cell--num { font-family: var(--font-mono); text-align: right; }
  .empty-cell { text-align: center; color: var(--text-muted); padding: var(--space-5); }

  code { font-family: var(--font-mono); font-size: 0.95em; }

  .chart-figure { margin: var(--space-4) 0; }
  .chart-figure svg { width: 100%; height: auto; display: block; }
  .chart-caption { font-size: var(--font-size-xs); color: var(--text-muted); margin-top: var(--space-2); }
  .chart-axis, .chart-bar-track { stroke: var(--border); fill: var(--bg-inset); }
  .chart-tick { stroke: var(--text-muted); }
  .chart-target-line { stroke: var(--danger); stroke-width: 2; stroke-dasharray: 4 4; }
  .chart-center-line { stroke: var(--text-muted); stroke-dasharray: 3 3; }
  .chart-band { fill: var(--accent-soft); }
  .chart-label { fill: var(--text-secondary); font-size: var(--font-size-xs); font-family: var(--font-sans); }
  .chart-tick-label { fill: var(--text-muted); font-size: var(--font-size-xs); font-family: var(--font-mono); }
  .chart-value-label { fill: var(--text-primary); font-size: var(--font-size-xs); font-family: var(--font-mono); }
  .chart-marker--current { fill: var(--text-muted); }
  .chart-marker--corrected { fill: var(--accent); }
  .chart-marker-label { font-size: var(--font-size-xs); font-family: var(--font-mono); }
  .chart-marker-label--current { fill: var(--text-muted); }
  .chart-marker-label--corrected { fill: var(--accent); }
  .chart-bar--success { fill: var(--success); }
  .chart-bar--warning { fill: var(--warning); }
  .chart-bar--info { fill: var(--accent); }
  .chart-bar--muted { fill: var(--text-muted); }

  .page-footer {
    max-width: 1100px; margin: 0 auto; padding: 0 var(--space-6) var(--space-8);
    color: var(--text-muted); font-size: var(--font-size-xs);
  }

  @media (prefers-reduced-motion: reduce) {
    .skip-link { transition: none; }
  }

  @media (max-width: 560px) {
    .page-header { padding: var(--space-3) var(--space-4); flex-wrap: wrap; }
    main { padding: var(--space-4); }
    .panel { padding: var(--space-4); }
  }
`;

// ---- Full document -----------------------------------------------------------

/**
 * Render the full self-contained calibration-dashboard HTML document.
 * Server-side rendered from the dataset — no external fetch, no CDN, works
 * from file://. The dataset is also embedded verbatim as JSON for anyone
 * who wants to script against the same numbers this page shows.
 */
export function renderDashboardHtml(data) {
  const dataJson = JSON.stringify(data, null, 2)
    .replace(/</g, "\\u003c"); // guard against premature </script> in embedded strings

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Epoch Calibration Dashboard</title>
<meta name="description" content="Self-contained, read-only calibration decision surface for the Epoch estimation ledger: per-tool/per-task-type accuracy, PERT learned-correction backtest, interval coverage, and data-integrity audit." />
<!-- Self-contained: no external fetch(), no CDN, works from file://. -->
<style>${STYLE}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="page-header">
  <div>
    <h1>Epoch Calibration Dashboard</h1>
    <div class="meta">generated ${esc(data.generatedAt)}</div>
  </div>
  <button type="button" id="theme-toggle" aria-pressed="false">Toggle light / dark</button>
</header>
<nav class="toc" aria-label="Section navigation">
  <ul>
    <li><a href="#section-1">1. Headline</a></li>
    <li><a href="#section-2">2. Per-tool</a></li>
    <li><a href="#section-3">3. Per-task-type</a></li>
    <li><a href="#section-4">4. PERT correction</a></li>
    <li><a href="#section-5">5. Coverage</a></li>
    <li><a href="#section-6">6. Data integrity</a></li>
  </ul>
</nav>
<main id="main">
  ${renderHeadline(data)}
  ${renderCalibrationTable(2, "Per-tool calibration", "Sorted by matched-pair count — the tools with real signal come first; the rest are honestly gated.", data.byTool, data.minNForVerdict, "Tool")}
  ${renderCalibrationTable(3, "Per-task-type calibration", "Retro-labeling (Section 6) sharpens this breakdown as more rows carry a task_label overlay.", data.byTaskType, data.minNForVerdict, "Task type")}
  ${renderPertSection(data)}
  ${renderCoverageSection(data)}
  ${renderIntegritySection(data)}
</main>
${renderFooter(data)}
<script type="application/json" id="dashboard-data">${dataJson}</script>
<script>${THEME_TOGGLE_SCRIPT}</script>
</body>
</html>
`;
}
