#!/usr/bin/env node
// ---------------------------------------------------------------------------
// stamp-release-versions.mjs — derive release-surface version strings ONCE
//
// Ticket 09 (public-face truth): server.json, docs/llms.txt, and
// site/llms-full.txt all carry hand-edited version strings that drifted from
// package.json (0.3.1 / 0.2.5 vs the shipped 0.4.x). This script is the
// single derivation: it stamps every surface from package.json's `version`.
//
// Usage:
//   node scripts/stamp-release-versions.mjs          # write stamps in place
//   node scripts/stamp-release-versions.mjs --check  # exit 1 on drift (CI guard)
//
// Wired into .github/workflows/release.yml before every publish step, so a
// forgotten hand-edit can never ship a stale version on a release surface.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_MODE = process.argv.includes("--check");

// ---- Read the version from package.json (the single source of truth) -------

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`stamp-release-versions: package.json has no valid semver version (got ${JSON.stringify(version)})`);
  process.exit(1);
}

let drift = [];

// ---- Stamped surfaces --------------------------------------------------------

/** JSON surfaces: parse, set fields, re-serialize preserving 2-space style. */
function stampServerJson() {
  const path = join(repoRoot, "server.json");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const touched = [];

  if (doc.version !== version) {
    touched.push(`version: ${doc.version} -> ${version}`);
    doc.version = version;
  }
  const npmPackage = Array.isArray(doc.packages)
    ? doc.packages.find((p) => p.registryType === "npm")
    : undefined;
  if (npmPackage && npmPackage.version !== version) {
    touched.push(`packages[npm].version: ${npmPackage.version} -> ${version}`);
    npmPackage.version = version;
  }

  if (touched.length === 0) return [];
  if (!CHECK_MODE) writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return touched;
}

/** Text surfaces: replace the `@kyanitelabs/epoch vX.Y.Z` header stamp. */
function stampLlmsTxt(relativePath) {
  const path = join(repoRoot, relativePath);
  const before = readFileSync(path, "utf8");
  const pattern = /(@kyanitelabs\/epoch v)\d+\.\d+\.\d+(-[\w.]+)?/;
  if (!pattern.test(before)) {
    console.error(`stamp-release-versions: ${relativePath} has no "@kyanitelabs/epoch vX.Y.Z" stamp to update — update the script's pattern.`);
    process.exit(1);
  }
  const after = before.replace(pattern, `$1${version}`);
  if (after === before) return [];
  if (!CHECK_MODE) writeFileSync(path, after);
  return [`${relativePath}: version header -> v${version}`];
}

const changes = [
  ...stampServerJson(),
  ...stampLlmsTxt("docs/llms.txt"),
  ...stampLlmsTxt("site/llms-full.txt"),
];

// ---- Report ------------------------------------------------------------------

if (changes.length === 0) {
  console.log(`stamp-release-versions: all surfaces already at v${version} (server.json, docs/llms.txt, site/llms-full.txt)`);
  process.exit(0);
}

if (CHECK_MODE) {
  console.error(`stamp-release-versions: version drift detected (package.json is v${version}):`);
  for (const change of changes) console.error(`  - ${change}`);
  console.error("Run `node scripts/stamp-release-versions.mjs` and commit the result.");
  process.exit(1);
}

console.log(`stamp-release-versions: stamped v${version} from package.json:`);
for (const change of changes) console.log(`  - ${change}`);
