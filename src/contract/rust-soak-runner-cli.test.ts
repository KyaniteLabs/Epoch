import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
});
