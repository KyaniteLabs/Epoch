import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  // Inline date-fns/date-fns-tz: their ESM barrels fan out into hundreds of
  // tiny modules, and resolving each one cost ~700 ms on every CLI/MCP cold
  // start (Node package.json lookups). Bundled + tree-shaken it is a few ms.
  noExternal: ["date-fns", "date-fns-tz"],
  target: "node20",
  clean: true,
  dts: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  loader: { ".json": "copy" },
  publicDir: "src/data",
});
