#!/usr/bin/env node

import { readFileSync } from "node:fs";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}
function text(path) {
  return readFileSync(path, "utf8");
}

const report = text("docs/plans/2026-05-09-epoch-audit-remediation-report.md");
check("report has no accepted-residual section", !/## Accepted residuals/i.test(report), "accepted residuals must be closed or moved to explicit follow-up closure");

const eslint = text("eslint.config.js");
check("non-null assertions are not downgraded in tests", !/no-non-null-assertion[\s\S]{0,80}warn/.test(eslint), "rule must remain error-level for all src files");

const llms = text("docs/llms.txt");
check("llms doc avoids stale test-count literals", !/\b\d+ tests, \d+ test files\b/.test(llms), "test counts drift; docs should point to pnpm test/current report");

for (const path of [
  "docs/superpowers/specs/2026-05-01-ship-ready-polish.md",
  "docs/superpowers/plans/2026-05-01-ship-ready-polish.md",
]) {
  check(`${path} marked historical`, /Historical archive:/.test(text(path)), "archived plans with stale counts need an explicit historical banner");
}

const pkg = JSON.parse(text("package.json"));
check("default canary is local-only", pkg.scripts?.canary === "node canary-runner.mjs --local-only", "release canary should not depend on external provider credentials");
check("provider canary remains explicit", pkg.scripts?.["canary:providers"] === "node canary-runner.mjs", "external provider compatibility must be opt-in");
for (const file of ["docs/TELEMETRY.md", "docs/PRIVACY.md", "scripts/backfill-telemetry.mjs"]) {
  check(`package includes ${file}`, pkg.files?.includes(file), `${file} should be in package.json.files`);
}

for (const path of ["scripts/configure-mac-mini-telemetry.sh", "scripts/install-telemetry-launchd.sh"]) {
  const body = text(path);
  check(`${path} supports dry-run`, /--dry-run/.test(body) && /DRY RUN:/.test(body), "side-effecting ops helpers need a non-mutating verification path");
  check(`${path} requires explicit endpoint`, !/100\.66\.225\.85/.test(body) && /EPOCH_TELEMETRY_ENDPOINT/.test(body), "ops helpers must not default to a private receiver");
}
check("data gather defaults to localhost LM Studio", /localhost:1234/.test(text("scripts/data-gather.mjs")), "provider data gathering must not default to a private Tailscale host");

const profiles = text("src/lib/profiles.ts");
check("deprecated profile wrapper removed", !/function getDeveloperProfile\(/.test(profiles) && !/@deprecated/.test(profiles), "only getDeveloperProfileGradient should remain");

const refDb = JSON.parse(text("src/data/reference-database.json"));
check(
  "empty bundled complexity factors are explained",
  Object.keys(refDb.complexityCorrectionFactors ?? {}).length > 0 || typeof refDb.complexityCorrectionFactorStatus === "string",
  "if bundled complexity factors are empty, the DB must carry a machine-readable status reason",
);

const failed = checks.filter(c => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : ` — ${c.detail}`}`);
}
if (failed.length > 0) {
  console.error(`\n${failed.length} remediation closure checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} remediation closure checks passed.`);
