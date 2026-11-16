#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — agent-lifecycle telemetry hook
//
// Wires an agent's prompt/stop lifecycle to Epoch's estimate → actual loop:
//   UserPromptSubmit -> `pert-estimate` (records an estimate + feedbackRef)
//   Stop             -> `record-actual` with the elapsed wall-clock hours
//
// Claude Code config (.claude/settings.json), path is the checkout's script:
//   {
//     "hooks": {
//       "UserPromptSubmit": [{ "hooks": [{ "type": "command",
//         "command": "node /path/to/Epoch/scripts/epoch-lifecycle-hook.mjs" }] }],
//       "Stop": [{ "hooks": [{ "type": "command",
//         "command": "node /path/to/Epoch/scripts/epoch-lifecycle-hook.mjs" }] }]
//     }
//   }
//
// CLI resolution order (the first readable dist/index.js wins):
//   1. EPOCH_BIN — explicit override. If it is set but unusable the hook fails
//      loudly instead of silently falling back to another install.
//   2. The checkout that ships this hook (../dist/index.js) — wiring
//      `<checkout>/scripts/epoch-lifecycle-hook.mjs` runs that checkout.
//   3. The same checkout candidates scripts/configure-mac-mini-telemetry.sh
//      probes: ~/workspaces/kyanite-labs/Epoch, ~/workspaces/Epoch, ~/Epoch.
//   4. npm-global layouts (Homebrew Apple Silicon, Intel macOS, `npm root -g`).
//
// A moved checkout used to make every call fail `Cannot find module` while
// only writing estimate_failed JSON lines to ~/.epoch/agent-lifecycle.log.
// Now a resolution failure is one loud stderr line (surfaced in the agent
// transcript) plus a `hook_failed` ledger line naming every path tried.
//
// Flags:
//   --check   resolve the CLI, prove it prints a version, print
//             "<path> <version>" and exit 0. Exits 2 when nothing resolves,
//             3 when the resolved CLI prints no version (the npm-bin symlink
//             entry-check failure).
//
// Env:
//   EPOCH_BIN                          explicit CLI entry (dist/index.js)
//   EPOCH_DATA_DIR                     ledger dir (default ~/.epoch)
//   EPOCH_LIFECYCLE_OPTIMISTIC_HOURS   PERT optimistic hours (default 0.25)
//   EPOCH_LIFECYCLE_MOST_LIKELY_HOURS  PERT most-likely hours (default 1)
//   EPOCH_LIFECYCLE_PESSIMISTIC_HOURS  PERT pessimistic hours (default 3)
//   EPOCH_LIFECYCLE_SESSION_TTL_HOURS  stale session cutoff (default 12)
// ---------------------------------------------------------------------------

import { execFile, execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const DATA_DIR = process.env["EPOCH_DATA_DIR"] ?? join(HOME, ".epoch");
const LOG_DIR = join(DATA_DIR, "agent-lifecycle");
const LOG_FILE = join(DATA_DIR, "agent-lifecycle.log");
const MIN_ACTUAL_HOURS = 0.01;
const CLI_TIMEOUT_MS = 60_000;

function envNumber(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function firstLine(text) {
	return String(text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean) ?? "";
}

function logEvent(event) {
	// Logging must never break the agent session.
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		appendFileSync(
			LOG_FILE,
			`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
		);
	} catch {
		/* ignore */
	}
}

function loudError(message, tried = []) {
	const suffix = tried.length > 0 ? ` Tried: ${tried.join(", ")}` : "";
	console.error(`epoch-lifecycle-hook: ERROR: ${message}.${suffix}`);
}

/**
 * Candidate CLI entries, in priority order. Returns `fromEnv` so a broken
 * explicit override is reported as such instead of looking like a missing
 * install.
 */
function candidateCliPaths() {
	const explicit = process.env["EPOCH_BIN"];
	if (explicit) {
		return { paths: [explicit], fromEnv: true };
	}

	const paths = [];
	// The checkout that ships this hook. Wired from <checkout>/scripts/, the
	// hook and the CLI are the same checkout even when other installs exist.
	paths.push(join(SCRIPT_DIR, "..", "dist", "index.js"));
	for (const checkout of [
		join(HOME, "workspaces", "kyanite-labs", "Epoch"),
		join(HOME, "workspaces", "Epoch"),
		join(HOME, "Epoch"),
	]) {
		paths.push(join(checkout, "dist", "index.js"));
	}
	// npm-global installs (macOS Homebrew, Intel macOS, other prefixes).
	paths.push("/opt/homebrew/lib/node_modules/@kyanitelabs/epoch/dist/index.js");
	paths.push("/usr/local/lib/node_modules/@kyanitelabs/epoch/dist/index.js");
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], {
			encoding: "utf8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (globalRoot) {
			paths.push(
				join(globalRoot, "@kyanitelabs", "epoch", "dist", "index.js"),
			);
		}
	} catch {
		/* npm not installed; the other candidates still apply */
	}
	return { paths, fromEnv: false };
}

function resolveEpochCli() {
	const { paths, fromEnv } = candidateCliPaths();
	for (const candidate of paths) {
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				return { ok: true, path: candidate, fromEnv };
			}
		} catch {
			/* unreadable candidate: keep looking */
		}
	}
	return { ok: false, fromEnv, tried: paths };
}

function runEpoch(cliPath, args, timeoutMs = CLI_TIMEOUT_MS) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[cliPath, ...args],
			{ timeout: timeoutMs, env: process.env, maxBuffer: 10 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const exitCode =
					error && typeof error.code === "number" ? error.code : error ? 1 : 0;
				resolve({
					exitCode,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
				});
			},
		);
	});
}

async function readStdin() {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function sessionFileFor(sessionId) {
	const safe = String(sessionId || "current")
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 120);
	return join(LOG_DIR, `active-${safe}.json`);
}

async function runCheck(resolved) {
	const result = await runEpoch(resolved.path, ["--version"], 30_000);
	const version = result.stdout.trim();
	if (result.exitCode !== 0 || version === "") {
		const detail =
			version === "" ? "printed nothing" : `printed "${firstLine(version)}"`;
		console.error(
			`epoch-lifecycle-hook: ERROR: resolved ${resolved.path} but \`--version\` ${detail} (exit ${result.exitCode}); this is the npm-bin symlink entry-check failure — the CLI must answer when invoked by its bin path.`,
		);
		logEvent({
			event: "check_failed",
			reason: "version_unavailable",
			cli: resolved.path,
			exitCode: result.exitCode,
			stdout: firstLine(version),
			stderr: firstLine(result.stderr),
		});
		process.exit(3);
	}
	console.log(`${resolved.path} ${version}`);
}

async function handleUserPromptSubmit(resolved, payload, sessionId) {
	const sessionFile = sessionFileFor(sessionId);
	const ttlHours = envNumber("EPOCH_LIFECYCLE_SESSION_TTL_HOURS", 12);

	if (existsSync(sessionFile)) {
		try {
			const previous = JSON.parse(readFileSync(sessionFile, "utf8"));
			const ageMs = Date.now() - Date.parse(previous.startedAt ?? "");
			if (
				Number.isFinite(ageMs) &&
				ageMs >= 0 &&
				ageMs < ttlHours * 3_600_000 &&
				typeof previous.estimateId === "string" &&
				previous.estimateId
			) {
				logEvent({
					event: "skip_existing_session",
					sessionId,
					estimateId: previous.estimateId,
				});
				return;
			}
		} catch {
			/* unreadable session: replace it below */
		}
		logEvent({ event: "stale_session_replaced", sessionId });
	}

	const optimistic = envNumber("EPOCH_LIFECYCLE_OPTIMISTIC_HOURS", 0.25);
	const mostLikely = envNumber("EPOCH_LIFECYCLE_MOST_LIKELY_HOURS", 1);
	const pessimistic = envNumber("EPOCH_LIFECYCLE_PESSIMISTIC_HOURS", 3);

	const result = await runEpoch(resolved.path, [
		"pert-estimate",
		"--optimistic",
		String(optimistic),
		"--most-likely",
		String(mostLikely),
		"--pessimistic",
		String(pessimistic),
		"--format",
		"json",
	]);

	if (result.exitCode !== 0) {
		const detail = firstLine(result.stderr || result.stdout);
		loudError(
			`pert-estimate failed (exit ${result.exitCode}) using ${resolved.path}: ${detail || "no output"}`,
		);
		logEvent({
			event: "estimate_failed",
			sessionId,
			cli: resolved.path,
			exitCode: result.exitCode,
			stderr: detail,
		});
		return;
	}

	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		loudError(
			`pert-estimate returned unparsable output using ${resolved.path}`,
		);
		logEvent({
			event: "estimate_failed",
			sessionId,
			cli: resolved.path,
			reason: "unparsable_output",
			stdout: firstLine(result.stdout),
		});
		return;
	}

	const estimateId =
		parsed?.data?.feedbackRef ?? parsed?.feedbackRef ?? parsed?.data?.estimateId;
	if (typeof estimateId !== "string" || estimateId === "") {
		loudError(
			`pert-estimate returned no feedbackRef using ${resolved.path}; the estimate was not recorded`,
		);
		logEvent({
			event: "estimate_failed",
			sessionId,
			cli: resolved.path,
			reason: "missing_feedback_ref",
		});
		return;
	}

	try {
		mkdirSync(LOG_DIR, { recursive: true });
		writeFileSync(
			sessionFile,
			JSON.stringify(
				{
					startedAt: new Date().toISOString(),
					estimateId,
					sessionId,
					cwd: payload.cwd ?? null,
					cli: resolved.path,
				},
				null,
				2,
			),
		);
	} catch (err) {
		loudError(
			`could not write the session file ${sessionFile}: ${firstLine(String(err))}`,
		);
		return;
	}

	logEvent({
		event: "session_started",
		sessionId,
		estimateId,
		expectedHours: parsed?.data?.expected ?? null,
		cwd: payload.cwd ?? null,
		cli: resolved.path,
	});
}

async function handleStop(resolved, sessionId) {
	const sessionFile = sessionFileFor(sessionId);
	if (!existsSync(sessionFile)) {
		logEvent({ event: "stop_no_session", sessionId });
		return;
	}

	let session;
	try {
		session = JSON.parse(readFileSync(sessionFile, "utf8"));
	} catch {
		logEvent({ event: "session_unreadable", sessionId });
		try {
			unlinkSync(sessionFile);
		} catch {
			/* ignore */
		}
		return;
	}

	const startedMs = Date.parse(session.startedAt ?? "");
	const elapsedHours = Number.isFinite(startedMs)
		? (Date.now() - startedMs) / 3_600_000
		: Number.NaN;

	if (!Number.isFinite(elapsedHours) || elapsedHours < MIN_ACTUAL_HOURS) {
		logEvent({
			event: "session_skipped",
			sessionId,
			reason: "below_minimum_actual",
			elapsedHours: Number.isFinite(elapsedHours)
				? Math.round(elapsedHours * 100) / 100
				: null,
		});
		try {
			unlinkSync(sessionFile);
		} catch {
			/* ignore */
		}
		return;
	}

	const actualHours = Math.round(elapsedHours * 100) / 100;
	const estimateId = String(session.estimateId ?? "");
	if (!estimateId) {
		logEvent({ event: "session_skipped", sessionId, reason: "missing_estimate_id" });
		try {
			unlinkSync(sessionFile);
		} catch {
			/* ignore */
		}
		return;
	}

	const result = await runEpoch(resolved.path, [
		"record-actual",
		"--estimate-id",
		estimateId,
		"--actual-hours",
		String(actualHours),
		"--format",
		"json",
	]);

	if (result.exitCode !== 0) {
		const detail = firstLine(result.stderr || result.stdout);
		loudError(
			`record-actual failed (exit ${result.exitCode}) for ${estimateId} using ${resolved.path}: ${detail || "no output"}`,
		);
		logEvent({
			event: "record_actual_failed",
			sessionId,
			estimateId,
			cli: resolved.path,
			exitCode: result.exitCode,
			stderr: detail,
		});
		// Keep the session file: the next Stop may retry the same pair.
		return;
	}

	logEvent({
		event: "session_recorded",
		sessionId,
		estimateId,
		elapsedHours: actualHours,
	});
	try {
		unlinkSync(sessionFile);
	} catch {
		/* ignore */
	}
}

async function main() {
	const check = process.argv.includes("--check");
	const resolved = resolveEpochCli();

	if (!resolved.ok) {
		const message = resolved.fromEnv
			? `EPOCH_BIN=${process.env["EPOCH_BIN"]} is not a readable file`
			: "cannot find the Epoch CLI; set EPOCH_BIN or install @kyanitelabs/epoch";
		loudError(message, resolved.tried);
		logEvent({
			event: "hook_failed",
			reason: resolved.fromEnv ? "epoch_bin_invalid" : "epoch_binary_not_found",
			tried: resolved.tried,
		});
		if (check) process.exit(2);
		return;
	}

	if (check) {
		await runCheck(resolved);
		return;
	}

	const raw = await readStdin();
	if (raw.trim() === "") {
		logEvent({ event: "hook_skipped", reason: "empty_payload" });
		return;
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		loudError("stdin is not valid JSON");
		logEvent({ event: "hook_failed", reason: "invalid_payload" });
		return;
	}

	const eventName = String(
		payload.hook_event_name ?? payload.hookEventName ?? "",
	);
	const sessionId = String(payload.session_id ?? payload.sessionId ?? "current");

	if (eventName === "UserPromptSubmit") {
		await handleUserPromptSubmit(resolved, payload, sessionId);
		return;
	}
	if (eventName === "Stop") {
		await handleStop(resolved, sessionId);
		return;
	}

	logEvent({ event: "hook_ignored", hookEventName: eventName, sessionId });
}

main().catch((err) => {
	console.error(
		`epoch-lifecycle-hook: ERROR: unexpected failure: ${firstLine(String(err))}`,
	);
	logEvent({ event: "hook_failed", reason: "unexpected_error" });
});
