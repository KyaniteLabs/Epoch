#!/usr/bin/env node
/**
 * Fleet-IP hygiene gate.
 *
 * Fails if any tracked text file contains a 100.x.y.z IPv4 literal (the
 * Tailscale/CGNAT range the fleet uses) or any *.ts.net hostname (Tailscale
 * tailnet FQDN, any subdomain shape). Fleet addresses must be injected at
 * runtime via environment variables, never committed.
 *
 * Scope: EVERY file returned by `git ls-files` that decodes as UTF-8 text —
 * src/, docs/, site/, skills/, .gitea/, root configs — except (a) the
 * dependency lockfiles, whose version strings like "100.4.5.2" would false-
 * positive the CGNAT pattern, and (b) this script itself, whose comments
 * name the patterns it enforces. Binary or undecodable files are skipped.
 *
 * The only allowlisted literal is the synthetic CGNAT-range fixture
 * (100.100.100.100) used by the endpoint-validation test in src/entries:
 * it exercises the same shared-address-range branch as a real private
 * endpoint while being obviously not a fleet host.
 *
 * Usage: node scripts/check-no-fleet-ips.mjs
 */
import { execFileSync } from "node:child_process";

const IP_PATTERN = /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// Tailscale tailnet FQDNs — any subdomain shape, not just host.tailNNN.ts.net.
const TAILNET_PATTERN = /\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/;
const ALLOWED_LITERALS = new Set(["100.100.100.100"]);
const EXCLUDED_PATHS = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "scripts/check-no-fleet-ips.mjs",
]);

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((path) => !EXCLUDED_PATHS.has(path));

const { readFileSync } = await import("node:fs");
const violations = [];
let scanned = 0;
for (const file of tracked) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable — out of scope
  }
  if (content.includes("\u0000")) continue; // NUL byte = binary
  scanned += 1;
  const lines = content.split("\n");
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

console.log(`Fleet IP hygiene gate: clean (${scanned} tracked text files scanned).`);
