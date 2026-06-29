import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("rust-soak-runner CLI", () => {
	it("requires an explicit target for release-tagged until-target runs", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-soak-runner-cli-"));
		let stderr = "";

		try {
			execFileSync(
				"pnpm",
				[
					"exec",
					"tsx",
					"scripts/rust-soak-runner.ts",
					"--",
					"--release-tag",
					"candidate-1",
					"--until-target",
					"--packet-dir",
					join(root, "packet"),
					"--ledger",
					join(root, "ledger.json"),
				],
				{ cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" },
			);
		} catch (error) {
			stderr =
				error instanceof Error && "stderr" in error
					? String(error.stderr)
					: String(error);
		}

		expect(stderr).toContain("--target must be explicit");
	}, 15_000);

	it("refuses to start release soak credit from a dirty worktree", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-soak-runner-cli-"));
		const packetDir = join(root, "packet");
		const ledgerPath = join(root, "ledger.json");
		const dirtyPath = join(REPO_ROOT, `.soak-runner-dirty-test-${process.pid}`);
		let stderr = "";

		try {
			writeFileSync(dirtyPath, "uncommitted\n");
			execFileSync(
				"pnpm",
				[
					"exec",
					"tsx",
					"scripts/rust-soak-runner.ts",
					"--",
					"--target",
					"replace",
					"--release-tag",
					"candidate-1",
					"--until-target",
					"--packet-dir",
					packetDir,
					"--ledger",
					ledgerPath,
				],
				{ cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" },
			);
		} catch (error) {
			stderr =
				error instanceof Error && "stderr" in error
					? String(error.stderr)
					: String(error);
		} finally {
			rmSync(dirtyPath, { force: true });
		}

		expect(stderr).toContain("dirty worktree");
	}, 15_000);
});
