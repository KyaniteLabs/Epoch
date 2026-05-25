#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Cross-Project Data Ingestion
// Reads session data from ~/.epoch/ and converts to estimate/actual pairs
// that the self-improvement engine can use for calibration.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const DATA_DIR = process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
mkdirSync(DATA_DIR, { recursive: true });

const ESTIMATES_FILE = join(DATA_DIR, "estimates.jsonl");
const FEEDBACK_FILE = join(DATA_DIR, "feedback.jsonl");

// Session data files with (hours, category) -> actual hours
const SESSION_FILES = [
	{
		file: "combined-real-tasks.json",
		source: "combined",
		hoursKey: "actual_hours",
	},
	{
		file: "dev-archaeology-real-sessions.json",
		source: "dev-archaeology",
		hoursKey: "hours",
	},
	{ file: "epoch-real-sessions.json", source: "epoch", hoursKey: "hours" },
	{
		file: "github_pipeline-real-sessions.json",
		source: "github_pipeline",
		hoursKey: "hours",
	},
	{ file: "liminal-real-sessions.json", source: "liminal", hoursKey: "hours" },
	{ file: "real-sessions.json", source: "sessions", hoursKey: "hours" },
];

// Category to Epoch task type mapping
const CATEGORY_MAP = {
	feature: "feature",
	bugfix: "bugfix",
	bug: "bugfix",
	fix: "bugfix",
	refactor: "refactor",
	refactoring: "refactor",
	migration: "migration",
	migrate: "migration",
	infrastructure: "infrastructure",
	infra: "infrastructure",
	devops: "infrastructure",
	ci: "infrastructure",
	documentation: "documentation",
	docs: "documentation",
	testing: "testing",
	test: "testing",
	design: "design",
	ui: "design",
	chore: "infrastructure",
};

function inferComplexity(hours, loc, files) {
	if (hours > 8 || (loc && loc > 500) || (files && files > 20)) return 5;
	if (hours > 4 || (loc && loc > 200) || (files && files > 10)) return 4;
	if (hours > 2 || (loc && loc > 50) || (files && files > 5)) return 3;
	if (hours > 1 || (loc && loc > 10) || (files && files > 2)) return 2;
	return 1;
}

function inferTaskType(category) {
	const lower = (category ?? "").toLowerCase();
	return CATEGORY_MAP[lower] ?? "feature";
}

// Deduplicate by (hours, category, loc, files) tuple
const seen = new Set();
const pairs = [];

for (const { file, source, hoursKey } of SESSION_FILES) {
	const filePath = join(DATA_DIR, file);
	if (!existsSync(filePath)) {
		console.log(`  SKIP ${file} (not found)`);
		continue;
	}

	const records = JSON.parse(readFileSync(filePath, "utf-8"));
	console.log(`  READ ${file}: ${records.length} records`);

	for (const rec of records) {
		const hours = rec[hoursKey];
		if (!hours || hours < 0.1) continue;

		const category = rec.category ?? "feature";
		const loc = rec.loc ?? 0;
		const files = rec.files ?? 0;
		const sessionId =
			rec.id ??
			rec.session_id ??
			rec.sessionId ??
			rec.start ??
			rec.timestamp ??
			"";
		const dedupKey = `${source}:${sessionId}:${hours}:${category}:${loc}:${files}`;

		if (seen.has(dedupKey)) continue;
		seen.add(dedupKey);

		const taskType = inferTaskType(category);
		const complexity = inferComplexity(hours, loc, files);
		const estimateId = randomUUID();
		const timestamp = rec.start ?? rec.timestamp ?? new Date().toISOString();

		// Create a synthetic PERT estimate that would have produced this actual
		// Use actual as the "expected" value, then back-compute O/M/P
		const expected = hours;
		const optimistic = Math.round(hours * 0.6 * 100) / 100;
		const pessimistic = Math.round(hours * 1.8 * 100) / 100;
		const mostLikely = Math.round(hours * 0.9 * 100) / 100;

		pairs.push({
			estimate: {
				id: estimateId,
				tool: "pert_estimate",
				inputs: {
					task_type: taskType,
					complexity,
					calibration_provenance: "backfilled_real_session",
					calibration_usage: "baseline",
					optimistic,
					most_likely: mostLikely,
					pessimistic,
				},
				outputs: {
					expected,
					optimistic,
					mostLikely,
					pessimistic,
					variance:
						Math.round(((pessimistic - optimistic) / 6) ** 2 * 10000) / 10000,
					unit: "hours",
				},
				estimatedAt: timestamp,
				source,
			},
			actual: {
				estimateId,
				actualHours: hours,
				notes: `Ingested from ${source}: ${category}, ${loc} LOC, ${files} files`,
				reportedAt: new Date().toISOString(),
			},
		});
	}
}

console.log(`\nUnique pairs to ingest: ${pairs.length}`);

// Append to estimates.jsonl and feedback.jsonl
const estLines = pairs.map((p) => JSON.stringify(p.estimate)).join("\n") + "\n";
const fbLines = pairs.map((p) => JSON.stringify(p.actual)).join("\n") + "\n";

writeFileSync(ESTIMATES_FILE, estLines, { flag: "a" });
writeFileSync(FEEDBACK_FILE, fbLines, { flag: "a" });

console.log(`Appended ${pairs.length} estimate/actual pairs to pipeline`);
console.log(`  -> ${ESTIMATES_FILE}`);
console.log(`  -> ${FEEDBACK_FILE}`);

// Summary by source
const bySource = {};
for (const p of pairs) {
	const src = p.estimate.source;
	bySource[src] = (bySource[src] ?? 0) + 1;
}
console.log(`\nBy source:`);
for (const [src, count] of Object.entries(bySource).sort(
	(a, b) => b[1] - a[1],
)) {
	console.log(`  ${src}: ${count}`);
}
