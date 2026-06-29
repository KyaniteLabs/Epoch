import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "native/epoch-rust-launcher": "src/native/epoch-rust-launcher.ts",
  },
  format: ["esm"],
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
