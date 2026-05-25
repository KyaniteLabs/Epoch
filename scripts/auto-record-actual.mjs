#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Auto-Record Actual Time
// Records actual hours for a completed task into the Epoch feedback pipeline.
//
// Usage:
//   # Start tracking (writes start time to .epoch-session)
//   node auto-record-actual.mjs start --task "Fix auth bug" --estimate-id abc123
//
//   # End tracking (computes elapsed, records actual)
//   node auto-record-actual.mjs end --notes "Took longer than expected"
//
//   # Quick record (just record N hours against an estimate)
//   node auto-record-actual.mjs record --estimate-id abc123 --hours 2.5
//
//   # Record from git (compute hours from commit timestamps)
//   node auto-record-actual.mjs git --estimate-id abc123 --from HEAD~5 --to HEAD
//
// Can also be used as a Claude Code hook in .claude/settings.json:
//   { "hooks": { "Stop": [{ "command": "node /path/to/auto-record-actual.mjs end" }] } }
// ---------------------------------------------------------------------------

import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const DATA_DIR = process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
const SESSION_FILE = join(DATA_DIR, ".active-session.json");
const FEEDBACK_FILE = join(DATA_DIR, "feedback.jsonl");
const MIN_HOURS = 0.01;

function parseArgs() {
	const args = process.argv.slice(2);
	const command = args[0];
	const opts = {};
	for (let i = 1; i < args.length; i++) {
		if (args[i].startsWith("--")) {
			const key = args[i]
				.slice(2)
				.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			opts[key] = args[i + 1];
			i++;
		}
	}
	return { command, ...opts };
}

function ensureDataDir() {
	mkdirSync(DATA_DIR, { recursive: true });
}

function appendFeedback(record) {
	ensureDataDir();
	// Check for duplicate
	if (existsSync(FEEDBACK_FILE)) {
		const lines = readFileSync(FEEDBACK_FILE, "utf-8")
			.split("\n")
			.filter(Boolean);
		for (const line of lines) {
			try {
				const existing = JSON.parse(line);
				if (existing.estimateId === record.estimateId) {
					console.log(`DUPLICATE: ${record.estimateId} already recorded`);
					return false;
				}
			} catch {
				/* skip malformed lines */
			}
		}
	}

	const line = JSON.stringify(record) + "\n";
	writeFileSync(FEEDBACK_FILE, line, { flag: "a" });
	return true;
}

function cmdStart(opts) {
	ensureDataDir();
	const session = {
		startedAt: new Date().toISOString(),
		task: opts.task || "",
		estimateId: opts.estimateId || "",
	};
	writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
	console.log(`STARTED: session at ${session.startedAt}`);
	if (session.estimateId) console.log(`  Estimate: ${session.estimateId}`);
	if (session.task) console.log(`  Task: ${session.task}`);
}

function cmdEnd(opts) {
	if (!existsSync(SESSION_FILE)) {
		console.log("NO_SESSION: no active session found. Use 'start' first.");
		process.exit(1);
	}

	const session = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
	const estimateId = opts.estimateId || session.estimateId;
	if (!estimateId) {
		console.log("ERROR: no estimate-id provided and none in session");
		process.exit(1);
	}

	const startedAt = new Date(session.startedAt);
	const endedAt = new Date();
	const elapsedHours = (endedAt - startedAt) / (1000 * 60 * 60);

	if (elapsedHours < MIN_HOURS) {
		console.log(
			`SKIP: ${elapsedHours.toFixed(2)}h is below minimum (${MIN_HOURS}h)`,
		);
		unlinkSync(SESSION_FILE);
		return;
	}

	const record = {
		estimateId,
		actualHours: Math.round(elapsedHours * 100) / 100,
		notes: opts.notes || session.task || "",
		reportedAt: endedAt.toISOString(),
	};

	if (appendFeedback(record)) {
		console.log(`RECORDED: ${record.actualHours}h against ${estimateId}`);
		console.log(
			`  Elapsed: ${elapsedHours.toFixed(2)}h (${startedAt.toISOString()} → ${endedAt.toISOString()})`,
		);
	}

	unlinkSync(SESSION_FILE);
}

function cmdRecord(opts) {
	const estimateId = opts.estimateId;
	const hours = parseFloat(opts.hours);

	if (!estimateId || isNaN(hours) || hours < MIN_HOURS) {
		console.log("USAGE: record --estimate-id <id> --hours <n>");
		process.exit(1);
	}

	const record = {
		estimateId,
		actualHours: Math.round(hours * 100) / 100,
		notes: opts.notes || "",
		reportedAt: new Date().toISOString(),
	};

	if (appendFeedback(record)) {
		console.log(`RECORDED: ${record.actualHours}h against ${estimateId}`);
	}
}

function cmdGit(opts) {
	const estimateId = opts.estimateId;
	if (!estimateId) {
		console.log("USAGE: git --estimate-id <id> --from HEAD~5 [--to HEAD]");
		process.exit(1);
	}

	const fromRef = opts.from || "HEAD~1";
	const toRef = opts.to || "HEAD";

	try {
		// Get timestamps of first and last commits in range
		const firstTs = execSync(`git log --format=%ci -1 ${fromRef}`, {
			encoding: "utf-8",
		}).trim();
		const lastTs = execSync(`git log --format=%ci -1 ${toRef}`, {
			encoding: "utf-8",
		}).trim();

		const start = new Date(firstTs);
		const end = new Date(lastTs);
		const hours = Math.abs(end - start) / (1000 * 60 * 60);

		// Preserve fast commits instead of inflating them to the old 15-minute floor.
		const actualHours = Math.max(hours, 0.01);

		const commitMsgs = execSync(`git log --format=%s ${fromRef}..${toRef}`, {
			encoding: "utf-8",
		}).trim();
		const summary = commitMsgs.split("\n").slice(0, 3).join("; ");

		const record = {
			estimateId,
			actualHours: Math.round(actualHours * 100) / 100,
			notes: `git: ${fromRef}..${toRef} — ${summary}`,
			reportedAt: new Date().toISOString(),
		};

		if (appendFeedback(record)) {
			console.log(
				`RECORDED: ${record.actualHours}h from git (${fromRef}..${toRef})`,
			);
			console.log(`  ${summary}`);
		}
	} catch (err) {
		console.log(`ERROR: ${err.message}`);
		process.exit(1);
	}
}

// ---- Main ----
const opts = parseArgs();
switch (opts.command) {
	case "start":
		cmdStart(opts);
		break;
	case "end":
		cmdEnd(opts);
		break;
	case "record":
		cmdRecord(opts);
		break;
	case "git":
		cmdGit(opts);
		break;
	default:
		console.log(
			"USAGE: auto-record-actual.mjs <start|end|record|git> [options]",
		);
		console.log("");
		console.log("  start   --task <desc> --estimate-id <id>  Begin tracking");
		console.log(
			"  end     [--estimate-id <id>] [--notes ...] End tracking, record actual",
		);
		console.log(
			"  record  --estimate-id <id> --hours <n>     Quick record N hours",
		);
		console.log(
			"  git     --estimate-id <id> --from HEAD~5   Record from git timestamps",
		);
}
