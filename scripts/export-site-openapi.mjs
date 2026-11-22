#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Export the static site's openapi.json (Forgejo #114)
//
// site/.well-known/ai-plugin.json points agents at
// https://kyanitelabs.github.io/Epoch/openapi.json, so that file must exist
// and must describe the API the HTTP entry actually serves. This script
// generates it from the same createApiApp() the server mounts, by requesting
// /openapi.json from an in-process app instance — the published spec cannot
// drift from the implementation because it IS the implementation's spec.
//
// Usage: pnpm run site:openapi   (writes site/openapi.json)
// CI re-runs it and fails on `git diff --exit-code site/openapi.json`, so a
// spec-changing PR that forgets to regenerate breaks the build.
// ---------------------------------------------------------------------------
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiApp } from "../src/entries/http.ts";

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..", "site");

const app = createApiApp();
const res = await app.request("/openapi.json");
if (!res.ok) {
  console.error(`export-site-openapi: FAIL - /openapi.json returned ${res.status}`);
  process.exit(1);
}
const spec = await res.json();
const out = join(siteDir, "openapi.json");
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
console.log(
  `export-site-openapi: wrote ${out} (openapi ${spec.openapi}, ${Object.keys(spec.paths ?? {}).length} paths, version ${spec.info?.version})`,
);
