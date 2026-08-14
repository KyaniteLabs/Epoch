#!/usr/bin/env node
/**
 * Fleet-IP hygiene gate.
 *
 * Fails if any tracked file under docs/, scripts/, or the root README.md
 * contains a 100.x.y.z IPv4 literal (the Tailscale/CGNAT range the fleet
 * uses). Fleet addresses must be injected at runtime via environment
 * variables, never committed.
 *
 * Scope is intentionally limited to docs/, scripts/, and README.md:
 * src/ tests contain a synthetic Tailscale endpoint fixture that exercises
 * endpoint-validation logic, and .gitea/ is private CI config outside this
 * gate's surface.
 *
 * Usage: node scripts/check-no-fleet-ips.mjs
 */
import { execFileSync } from "node:child_process";

const IP_PATTERN = /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
// Tailscale tailnet FQDNs (e.g. host.tail123456.ts.net) are internal endpoints.
const TAILNET_PATTERN = /\b[\w-]+\.tail\d+\.ts\.net\b/;
const SCOPED = (path) =>
  path === "README.md" || path.startsWith("docs/") || path.startsWith("scripts/");

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter(SCOPED);

const { readFileSync } = await import("node:fs");
const violations = [];
for (const file of tracked) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (IP_PATTERN.test(line) || TAILNET_PATTERN.test(line)) {
      violations.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    `Fleet IP hygiene gate: found ${violations.length} line(s) with fleet addresses (100.x.y.z or *.tail*.ts.net).\n` +
      "Fleet addresses must not be committed — pass them via environment variables instead.\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`Fleet IP hygiene gate: clean (${tracked.length} tracked files scanned).`);
