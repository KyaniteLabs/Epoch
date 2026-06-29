import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const node = process.execPath;
const stageScript = resolve(repoRoot, "scripts/stage-rust-prebuilds.mjs");
const verifyScript = resolve(repoRoot, "scripts/verify-rust-prebuilds.mjs");
const platform = `${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;
const suffix = process.platform === "win32" ? ".exe" : "";
const binaries = ["epoch-cli", "epoch-mcp", "epoch-http"];

function sha256(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function fixtureRoot(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "epoch-prebuilds-"));
	const releaseDir = join(root, "rust", "target", "release");
	await mkdir(releaseDir, { recursive: true });
	for (const binary of binaries) {
		const path = join(releaseDir, `${binary}${suffix}`);
		writeFileSync(path, `${binary}:fixture`);
		chmodSync(path, 0o755);
	}
	return root;
}

function runScript(script: string, root: string): string {
	return execFileSync(node, [script, "--root", root], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function runScriptResult(script: string, root: string) {
	return spawnSync(node, [script, "--root", root], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

describe("Rust prebuild packaging scripts", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stages a checksum manifest that the verifier accepts", async () => {
		const root = await fixtureRoot();
		roots.push(root);

		expect(runScript(stageScript, root)).toContain(
			`Staged Rust prebuilds: prebuilds/${platform}`,
		);
		expect(runScript(verifyScript, root)).toContain(
			`Verified Rust prebuilds: ${platform}`,
		);

		const manifest = JSON.parse(
			readFileSync(join(root, "prebuilds", platform, "manifest.json"), "utf8"),
		);
		expect(manifest.checksums).toEqual({
			[`epoch-cli${suffix}`]: sha256("epoch-cli:fixture"),
			[`epoch-mcp${suffix}`]: sha256("epoch-mcp:fixture"),
			[`epoch-http${suffix}`]: sha256("epoch-http:fixture"),
		});
	});

	it("rejects checksum tampering and unexpected package files", async () => {
		const root = await fixtureRoot();
		roots.push(root);
		runScript(stageScript, root);

		const manifestPath = join(root, "prebuilds", platform, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.checksums[`epoch-cli${suffix}`] = "0".repeat(64);
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const tampered = runScriptResult(verifyScript, root);
		expect(tampered.status).toBe(1);
		expect(tampered.stderr).toContain("sha256 is");

		runScript(stageScript, root);
		writeFileSync(join(root, "prebuilds", platform, "unexpected.txt"), "nope");

		const extraFile = runScriptResult(verifyScript, root);
		expect(extraFile.status).toBe(1);
		expect(extraFile.stderr).toContain("is not an expected prebuild file");
	});

	it("rejects unexpected platform directories", async () => {
		const root = await fixtureRoot();
		roots.push(root);
		runScript(stageScript, root);

		const unexpectedDir = join(root, "prebuilds", "unexpected-platform");
		mkdirSync(unexpectedDir, { recursive: true });
		writeFileSync(join(unexpectedDir, "unexpected.txt"), "nope");

		const extraPlatform = runScriptResult(verifyScript, root);
		expect(extraPlatform.status).toBe(1);
		expect(extraPlatform.stderr).toContain("is not an expected prebuild platform");
	});
});
