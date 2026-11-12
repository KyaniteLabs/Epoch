import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Integration coverage for scripts/epoch-lifecycle-hook.mjs — the supported
// agent-lifecycle hook. The hook must keep producing estimate/actual pairs
// after the Epoch checkout moves (the 2026-05 regression: the old hook
// hardcoded ~/workspaces/kyanite-labs/Epoch/dist/index.js and every call
// failed `Cannot find module` while only estimate_failed JSON lines were
// logged), and it must fail loudly when a configured CLI path is wrong.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOK_SOURCE = join(REPO_ROOT, "scripts", "epoch-lifecycle-hook.mjs");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");
const PACKAGE_VERSION = (
	JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		version: string;
	}
).version;

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function hookEnv(home: string, dataDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
	env["EPOCH_DATA_DIR"] = dataDir;
	delete env["EPOCH_BIN"];
	delete env["EPOCH_LIFECYCLE_OPTIMISTIC_HOURS"];
	delete env["EPOCH_LIFECYCLE_MOST_LIKELY_HOURS"];
	delete env["EPOCH_LIFECYCLE_PESSIMISTIC_HOURS"];
	delete env["EPOCH_LIFECYCLE_SESSION_TTL_HOURS"];
	return env;
}

function runHook(
	hookPath: string,
	env: NodeJS.ProcessEnv,
	payload: Record<string, unknown>,
	args: string[] = [],
) {
	return spawnSync(process.execPath, [hookPath, ...args], {
		input: JSON.stringify(payload),
		env,
		encoding: "utf8",
		timeout: 120_000,
	});
}

function readJsonl(path: string): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Simulate the checkout move: the old hardcoded path
 * (~/workspaces/kyanite-labs/Epoch) does not exist, the checkout is at
 * ~/workspaces/Epoch, and the hook script itself lives outside the repo so
 * its own `../dist` candidate cannot mask discovery.
 */
function makeMovedCheckoutHome(): {
	home: string;
	hookPath: string;
	dataDir: string;
} {
	const home = tempRoot("epoch-hook-home-");
	const movedDist = join(home, "workspaces", "Epoch", "dist");
	mkdirSync(movedDist, { recursive: true });
	symlinkSync(DIST_ENTRY, join(movedDist, "index.js"));

	const hookDir = join(home, "hook");
	mkdirSync(hookDir, { recursive: true });
	const hookPath = join(hookDir, "epoch-lifecycle-hook.mjs");
	copyFileSync(HOOK_SOURCE, hookPath);

	return { home, hookPath, dataDir: join(home, ".epoch") };
}

beforeAll(() => {
	// `pnpm test` runs before the build in CI; build once so the hook drives
	// the real CLI rather than a stub.
	if (!existsSync(DIST_ENTRY)) {
		execFileSync(
			process.execPath,
			[join(REPO_ROOT, "node_modules", "tsup", "dist", "cli-default.js")],
			{ cwd: REPO_ROOT, stdio: "pipe", timeout: 180_000 },
		);
	}
	expect(existsSync(DIST_ENTRY)).toBe(true);
}, 200_000);

afterAll(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("epoch lifecycle hook", () => {
	it(
		"resolves a moved checkout and completes an estimate→actual round trip",
		() => {
			const { home, hookPath, dataDir } = makeMovedCheckoutHome();
			const env = hookEnv(home, dataDir);

			const start = runHook(hookPath, env, {
				hook_event_name: "UserPromptSubmit",
				session_id: "round-trip-session",
				cwd: home,
			});
			expect(start.status, start.stderr).toBe(0);

			const estimates = readJsonl(join(dataDir, "estimates.jsonl"));
			expect(estimates).toHaveLength(1);
			const estimateId = String(estimates[0]?.["id"]);
			expect(estimateId).toMatch(/[0-9a-f-]{36}/);

			const sessionPath = join(
				dataDir,
				"agent-lifecycle",
				"active-round-trip-session.json",
			);
			expect(existsSync(sessionPath)).toBe(true);

			// Make the run look 30 minutes long, then fire Stop.
			const session = JSON.parse(readFileSync(sessionPath, "utf8")) as {
				startedAt: string;
			};
			session.startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
			writeFileSync(sessionPath, JSON.stringify(session), "utf8");

			const stop = runHook(hookPath, env, {
				hook_event_name: "Stop",
				session_id: "round-trip-session",
			});
			expect(stop.status, stop.stderr).toBe(0);

			const feedback = readJsonl(join(dataDir, "feedback.jsonl"));
			expect(feedback).toHaveLength(1);
			expect(feedback[0]?.["estimateId"]).toBe(estimateId);
			expect(Number(feedback[0]?.["actualHours"])).toBeCloseTo(0.5, 2);

			const events = readJsonl(join(dataDir, "agent-lifecycle.log"));
			expect(events.map((event) => event["event"])).toEqual(
				expect.arrayContaining(["session_started", "session_recorded"]),
			);
		},
		120_000,
	);

	it(
		"fails loudly, and keeps one hook_failed line, when EPOCH_BIN does not resolve",
		() => {
			const home = tempRoot("epoch-hook-missing-");
			const hookDir = join(home, "hook");
			mkdirSync(hookDir, { recursive: true });
			const hookPath = join(hookDir, "epoch-lifecycle-hook.mjs");
			copyFileSync(HOOK_SOURCE, hookPath);
			const dataDir = join(home, ".epoch");
			const missingCli = join(home, "no-such-checkout", "dist", "index.js");

			const env = hookEnv(home, dataDir);
			env["EPOCH_BIN"] = missingCli;

			const result = runHook(hookPath, env, {
				hook_event_name: "UserPromptSubmit",
				session_id: "missing-cli",
			});

			// A hook must not break the agent session — but it must say so.
			expect(result.status).toBe(0);
			expect(result.stderr).toContain("epoch-lifecycle-hook: ERROR");
			expect(result.stderr).toContain("EPOCH_BIN");
			expect(result.stderr).toContain(missingCli);

			const events = readJsonl(join(dataDir, "agent-lifecycle.log"));
			expect(events).toHaveLength(1);
			expect(events[0]?.["event"]).toBe("hook_failed");
			expect(events[0]?.["reason"]).toBe("epoch_bin_invalid");
			expect(existsSync(join(dataDir, "estimates.jsonl"))).toBe(false);
		},
		120_000,
	);

	it(
		"--check prints the resolved CLI and its version from a moved checkout",
		() => {
			const { home, hookPath, dataDir } = makeMovedCheckoutHome();
			const result = runHook(hookPath, hookEnv(home, dataDir), {}, ["--check"]);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain(
				join(home, "workspaces", "Epoch", "dist", "index.js"),
			);
			expect(result.stdout.trim().endsWith(PACKAGE_VERSION)).toBe(true);
		},
		120_000,
	);
});
