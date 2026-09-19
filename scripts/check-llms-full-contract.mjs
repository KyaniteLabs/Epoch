#!/usr/bin/env node
// check-llms-full-contract — contract check (WS-B B3b, doc-drift audit 2026-08-28).
// Contract (README.md:203 class): site/llms-full.txt is the agent-facing surface and
// must carry the country-gate facts — the `holidaySupport` field and the two-letter
// country note. Drift class guarded: generated-agent-surface-stale (H8 class: the
// 2026-08-28 audit found llms-full.txt missing both after a contract change).
// Exit 0 = contract holds. Exit 1 = drift or unreadable file (fail closed).
// No-weakening clause applies: do not edit this check to make a lane pass — a failing
// check is a finding. If llms-full.txt is generated, fix the generator, then regenerate.
// Usage: node scripts/check-llms-full-contract.mjs [path-to-llms-full.txt]
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'site/llms-full.txt';
let txt;
try {
  txt = readFileSync(path, 'utf8');
} catch (err) {
  console.error(`check-llms-full-contract: FAIL - cannot read ${path} (${err.code ?? err.message})`);
  process.exit(1);
}

const holiday = (txt.match(/holidaySupport/g) ?? []).length;
const twoLetter = (txt.match(/two-letter/gi) ?? []).length;

if (holiday >= 1 && twoLetter >= 1) {
  console.log(`check-llms-full-contract: OK - ${path}: holidaySupport x${holiday}, two-letter x${twoLetter}`);
  process.exit(0);
}

console.error(
  `check-llms-full-contract: FAIL - ${path}: holidaySupport x${holiday} (need >=1), ` +
  `two-letter x${twoLetter} (need >=1) — site/llms-full.txt lags the README contract ` +
  `(H8 class); regenerate or reconcile it`
);
process.exit(1);
