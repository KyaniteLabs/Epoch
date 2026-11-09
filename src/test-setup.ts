// Vitest setupFile: make every test worker hermetic with respect to the
// operator's real ledger. Without this, `pnpm test` on a developer machine
// appended fixture estimates and tool-call telemetry to the real ~/.epoch
// (observed: 22 estimates + 5 tool-calls per run), and an exported
// EPOCH_DATA_DIR in the shell flipped telemetry tests from pass to fail.
//
// Runs before each test file's imports, so module-level
// `join(homedir(), ".epoch")` constants resolve inside the throwaway HOME.
// Tests that need EPOCH_DATA_DIR still set it themselves (vi.stubEnv / env).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

const isolatedHome = mkdtempSync(join(tmpdir(), "epoch-test-home-"));
process.env["HOME"] = isolatedHome;
process.env["USERPROFILE"] = isolatedHome;
delete process.env["EPOCH_DATA_DIR"];

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});
