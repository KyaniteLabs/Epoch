import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/lib/**/*.ts",
        "src/tools/**/*.ts",
        "src/dispatcher/**/*.ts",
        "src/entries/**/*.ts",
      ],
      // Per-glob thresholds: each key is checked as its own pool. No
      // root-level numbers, so the four groups below are the only gates.
      thresholds: {
        // Long-gated seams keep their original 80% floor (unchanged).
        "src/lib/**": {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        "src/tools/**": {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        // Newly gated seams, measured 2026-08-14 (scoped suite runs):
        //   dispatcher: 69.7 stmts / 61.5 branch / 64.6 funcs / 70.6 lines
        //   entries:    51.8 stmts / 47.9 branch / 50.6 funcs / 53.3 lines
        // entries is below the 80% bar (entries/mcp.ts has no dedicated
        // tests yet); 45 leaves headroom under the lowest measured metric
        // while still gating regressions. Raise as coverage catches up.
        "src/dispatcher/**": {
          statements: 60,
          branches: 60,
          functions: 60,
          lines: 60,
        },
        "src/entries/**": {
          statements: 45,
          branches: 45,
          functions: 45,
          lines: 45,
        },
      },
    },
  },
});
