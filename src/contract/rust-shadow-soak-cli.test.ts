import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("rust shadow-soak CLI", () => {
	it("writes progress heartbeat evidence beside the final report", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-shadow-soak-cli-"));
		try {
			const output = join(root, "shadow-soak.json");
			const progressOutput = join(root, "shadow-soak-progress.json");

			execFileSync(
				"pnpm",
				[
					"exec",
					"tsx",
					"scripts/rust-shadow-soak.ts",
					"--iterations",
					"1",
					"--min-seconds",
					"0",
					"--output",
					output,
					"--progress-output",
					progressOutput,
					"--no-build",
					"--quiet",
					"--release-tag",
					"test-release",
				],
				{ encoding: "utf8", stdio: "pipe" },
			);

			const progress = readJson(progressOutput);
			const report = readJson(output);

			expect(isObject(progress)).toBe(true);
			expect(isObject(report)).toBe(true);
			if (!isObject(progress) || !isObject(report)) return;

			expect(progress.status).toBe("complete");
			expect(progress.releaseTag).toBe("test-release");
			expect(progress.iterationsCompleted).toBe(report.meta && isObject(report.meta)
				? report.meta.iterationsCompleted
				: undefined);
			expect(progress.lastIteration).toEqual(
				Array.isArray(report.iterations) ? report.iterations.at(-1) : undefined,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
