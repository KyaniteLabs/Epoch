#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Calibration Dashboard Builder (Phase 6)
// ---------------------------------------------------------------------------
//
// Reads ~/.epoch STRICTLY READ-ONLY via src/lib/dashboard-data.ts's
// computeDashboardData() — which itself only calls the shared, exclusion-
// filtered, overlay-merged API surface (feedback.ts / ledger.ts /
// exclusion.ts / coverage.ts / calibration-factors.ts / accuracy-trend.ts).
// This script never reads estimates.jsonl / feedback.jsonl directly and
// never writes to the Epoch data dir.
//
// Emits a SINGLE self-contained HTML file: design tokens (CSS custom
// properties), light/dark themes (prefers-color-scheme + a visible toggle),
// inline SVG charts with direct labels, accessible markup (skip link, <main>
// landmark, role/aria on SVGs, :focus-visible, prefers-reduced-motion), and
// no external fetches — self-contained, works from file://, no CDN.
//
// Rendering is server-side (this script computes the full HTML from the
// dataset directly) so the page is correct even with JavaScript disabled;
// the only client-side script is the light/dark theme toggle.
//
// Usage:
//   npx tsx scripts/build-calibration-dashboard.mjs                # default out
//   npx tsx scripts/build-calibration-dashboard.mjs --out path.html
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 6.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { computeDashboardData } from "../src/lib/dashboard-data.ts";
import { renderDashboardHtml } from "./lib/render-calibration-dashboard.mjs";

const DEFAULT_OUT = ".omc/reports/epoch-calibration-dashboard.html";

function parseOutFlag(argv) {
  const eqArg = argv.find((a) => a.startsWith("--out="));
  if (eqArg) return eqArg.slice("--out=".length);
  const idx = argv.indexOf("--out");
  if (idx >= 0 && argv[idx + 1] !== undefined) return argv[idx + 1];
  return DEFAULT_OUT;
}

function main() {
  const outArg = parseOutFlag(process.argv.slice(2));
  const outPath = resolve(process.cwd(), outArg);

  console.error(`[build-calibration-dashboard] computing dataset (read-only) ...`);
  const data = computeDashboardData();

  console.error(`[build-calibration-dashboard] dataDir=${data.dataDir}`);
  console.error(`[build-calibration-dashboard] matchedPairs=${data.headline.matchedPairs} cappedMdape=${data.headline.cappedMdape} matchRate=${data.headline.matchRate}% trend=${data.headline.trend}`);
  console.error(`[build-calibration-dashboard] quarantined=${data.integrity.quarantine.count} labeled=${data.integrity.labels.count} orphans=${data.integrity.orphans.total} (leakage=${data.integrity.orphans.testFixtureLeakage}, unresolved=${data.integrity.orphans.unresolved})`);
  console.error(`[build-calibration-dashboard] pertFlagEnabled=${data.pert.flagEnabled} pertBacktestRecommendation="${data.pert.backtest.recommendation}"`);

  const html = renderDashboardHtml(data);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf-8");

  console.error(`[build-calibration-dashboard] wrote ${html.length} bytes -> ${outPath}`);
}

main();
