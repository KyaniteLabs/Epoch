#!/usr/bin/env node
/**
 * Fleet-IP hygiene gate.
 *
 * Fails if any tracked file under src/, docs/, scripts/, or the root README.md
 * contains a 100.x.y.z IPv4 literal (the Tailscale/CGNAT range the fleet
 * uses). Fleet addresses must be injected at runtime via environment
 * variables, never committed.
 *
 * The only allowlisted literal is the synthetic CGNAT-range fixture
 * (100.100.100.100) used by the endpoint-validation test in src/entries:
 * it exercises the same shared-address-range branch as a real private
 * endpoint while being obviously not a fleet host. .gitea/ is private CI
 * config outside this gate's surface.
 *
 * Usage: node scripts/check-no-fleet-ips.mjs
 */
import { execFileSync } from "node:child_process";

const IP_PATTERN = /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// Tailscale tailnet FQDNs (host.tail<digits>.ts.net) are internal endpoints.
const TAILNET_PATTERN = /\b[\w-]+\.tail\d+\.ts\.net\b/;
const ALLOWED_LITERALS = new Set(["100.100.100.100"]);
const SCOPED = (path) =>
  path === "README.md" || path.startsWith("docs/") || path.startsWith("scripts/") || path.startsWith("src/");

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter(SCOPED);

const { readFileSync } = await import("node:fs");
const violations = [];
for (const file of tracked) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const ips = line.match(IP_PATTERN) ?? [];
    const hasFleetIp = ips.some((ip) => !ALLOWED_LITERALS.has(ip));
    if (hasFleetIp || TAILNET_PATTERN.test(line)) {
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
