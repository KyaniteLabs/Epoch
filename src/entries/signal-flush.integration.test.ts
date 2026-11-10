// ---------------------------------------------------------------------------
// Signal-flush integration tests (real spawned entries, no mocks)
// ---------------------------------------------------------------------------
// Pins the production bug end to end: tool-call telemetry is buffered in
// TelemetryStore (10 s flush interval) and Node's default SIGTERM/SIGINT/
// SIGHUP death never fires 'exit', so buffered records used to vanish when
// an MCP host stopped the server. The MCP entry must now flush every
// buffered store on those signals and exit with the conventional 128+n code
// — without swallowing a second signal. The `epoch serve` case pins that the
// CLI's immediate-exit handlers step aside for the HTTP entry's own graceful
// shutdown (exit 0, not 143).
//
// The entry is spawned as `node --import tsx src/index.ts` rather than
// through the node_modules/.bin/tsx CLI shim: the shim is a relay that
// spawns the real entry as its child and, on a repeated signal, SIGKILLs
// that child after ~30 ms. Sending the two test signals to the shim
// therefore kills the telemetry writer before its own shutdown path can
// finish, which reproduces as ENOENT (or an empty) telemetry.jsonl even
// when the entry logic is correct (measured 3/300 on main). `--import tsx`
// loads the TypeScript entry in the target process itself, so the signals
// land on the entry exactly as `node dist/index.js` receives them in
// production while staying a real process.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_PACKAGE = join(REPO_ROOT, "node_modules", "tsx", "package.json");
const hasTsx = existsSync(TSX_PACKAGE);

interface Line {
	jsonrpc: string;
	id?: string | number | null;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

interface ExitResult {
	code: number | null;
	signal: string | null;
}

/** Minimal JSON-RPC stdio driver for one spawned entry process. */
class StdioSession {
	private buffer = "";
	private readonly lines: Line[] = [];
	private cursor = 0;
	public stderr = "";
	public exited: Promise<ExitResult>;
	private readonly child: ChildProcess;
	private readonly stdin: NodeJS.WritableStream;

	constructor(args: string[], env: NodeJS.ProcessEnv) {
		const child = spawn(
			process.execPath,
			["--import", "tsx", join(REPO_ROOT, "src", "index.ts"), ...args],
			{
				cwd: REPO_ROOT,
				env: { ...process.env, NO_COLOR: "1", ...env },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.child = child;
		this.stdin = child.stdin;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.buffer += chunk;
			const segments = this.buffer.split("\n");
			this.buffer = segments.pop() ?? "";
			for (const segment of segments) {
				try {
					this.lines.push(JSON.parse(segment) as Line);
				} catch {
					// non-JSON output line — ignore
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
		this.exited = new Promise((resolve) => {
			child.on("exit", (code, signal) => resolve({ code, signal }));
		});
	}

	send(message: unknown): void {
		this.stdin.write(JSON.stringify(message) + "\n");
	}

	async waitForId(id: string | number, timeoutMs = 20_000): Promise<Line> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.lines.slice(this.cursor).find((line) => line.id === id);
			if (found) {
				this.cursor = this.lines.indexOf(found, this.cursor) + 1;
				return found;
			}
			const exit = await Promise.race([
				this.exited.then((e) => e),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
			]);
			if (exit) {
				throw new Error(
					`server exited (code ${exit.code}) while waiting for id ${id}: ${this.stderr.slice(0, 400)}`,
				);
			}
		}
		throw new Error(
			`timeout waiting for id ${id}; got ${this.lines.length} lines, stderr: ${this.stderr.slice(0, 400)}`,
		);
	}

	async waitForStderrContains(text: string, timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.stderr.includes(text)) return;
			const exit = await Promise.race([
				this.exited.then((e) => e),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
			]);
			if (exit) {
				throw new Error(`server exited (code ${exit.code}) before stderr contained "${text}": ${this.stderr.slice(0, 400)}`);
			}
		}
		throw new Error(`timeout waiting for stderr to contain "${text}": ${this.stderr.slice(0, 400)}`);
	}

	kill(signal: NodeJS.Signals = "SIGKILL"): void {
		this.child.kill(signal);
	}
}

/** Drive one initialized MCP session through a single tools/call. */
async function callOneTool(session: StdioSession): Promise<void> {
	session.send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "sigterm-flush-test", version: "1.0.0" },
		},
	});
	const init = await session.waitForId(1);
	expect(init.error).toBeUndefined();
	session.send({ jsonrpc: "2.0", method: "notifications/initialized" });

	session.send({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: {
			name: "pert_estimate",
			arguments: { optimistic: 2, most_likely: 5, pessimistic: 20, unit: "hours" },
		},
	});
	const call = await session.waitForId(2);
	expect(call.error).toBeUndefined();
	expect((call.result as { isError?: boolean } | undefined)?.isError).toBeFalsy();
}

/** Parsed telemetry records from <dataDir>/telemetry.jsonl. */
function readTelemetry(dataDir: string): Array<Record<string, unknown>> {
	const content = readFileSync(join(dataDir, "telemetry.jsonl"), "utf-8");
	return content
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const DATA_DIR = hasTsx ? mkdtempSync(join(tmpdir(), "epoch-sigterm-int-")) : "";
const suite = hasTsx ? describe : describe.skip;

afterAll(() => {
	if (DATA_DIR) rmSync(DATA_DIR, { recursive: true, force: true });
});

suite("entry signal shutdown (integration, real processes)", () => {
	it(
		"MCP: SIGTERM within the flush interval flushes the buffered record to telemetry.jsonl and exits 143",
		async () => {
			const dataDir = join(DATA_DIR, "t-sigterm");
			const session = new StdioSession([], { EPOCH_DATA_DIR: dataDir });

			await callOneTool(session);

			// The record is still ONLY in memory here: this check runs within
			// milliseconds of the tools/call response, deep inside the 10 s
			// flush interval, so a pass proves the on-disk record below was
			// written by the signal handler — not by the interval timer.
			expect(existsSync(join(dataDir, "telemetry.jsonl"))).toBe(false);

			session.kill("SIGTERM");
			const exit = await Promise.race([
				session.exited,
				new Promise<ExitResult>((resolve) => setTimeout(() => resolve({ code: -999, signal: "HANG" }), 10_000)),
			]);
			expect(exit.code).toBe(143); // 128 + 15
			expect(exit.signal).toBeNull();

			const records = readTelemetry(dataDir).filter((r) => r.tool === "pert_estimate");
			expect(records).toHaveLength(1);
			expect(records[0]?.outputOk).toBe(true);
		},
		60_000,
	);

	it(
		"MCP: a second signal is never swallowed — the process terminates promptly and the record still lands",
		async () => {
			const dataDir = join(DATA_DIR, "t-double");
			const session = new StdioSession([], { EPOCH_DATA_DIR: dataDir });

			await callOneTool(session);
			expect(existsSync(join(dataDir, "telemetry.jsonl"))).toBe(false);

			// Two immediate SIGTERMs: the handler flushes synchronously first,
			// so the second coalesces into the same exit (143). SIGTERM death
			// stays accepted for runner wrappers that relay signals. Either
			// way the signal was honored — never absorbed — and the record
			// must land.
			session.kill("SIGTERM");
			session.kill("SIGTERM");
			const exit = await Promise.race([
				session.exited,
				new Promise<ExitResult>((resolve) => setTimeout(() => resolve({ code: -999, signal: "HANG" }), 10_000)),
			]);
			expect(
				exit.code === 143 || (exit.code === null && exit.signal === "SIGTERM"),
				`expected exit(143) or SIGTERM death, got ${JSON.stringify(exit)}`,
			).toBe(true);

			const records = readTelemetry(dataDir).filter((r) => r.tool === "pert_estimate");
			expect(records).toHaveLength(1);
		},
		60_000,
	);

	it(
		"CLI serve: SIGTERM keeps the HTTP entry's graceful shutdown (exit 0, not the CLI's 143)",
		async () => {
			// EPOCH_PORT=0 -> bind an ephemeral free port: zero collision
			// risk with anything else running on this host (startHttpServer
			// resolves the env var; only the --port flag forbids 0).
			const session = new StdioSession(["serve"], {
				EPOCH_DATA_DIR: join(DATA_DIR, "t-serve"),
				EPOCH_PORT: "0",
			});

			await session.waitForStderrContains("listening");

			session.kill("SIGTERM");
			const exit = await Promise.race([
				session.exited,
				new Promise<ExitResult>((resolve) => setTimeout(() => resolve({ code: -999, signal: "HANG" }), 10_000)),
			]);
			// The HTTP entry's own handler owns this shutdown: flush, close,
			// exit 0. If the CLI's immediate 128+n handler had stayed
			// installed, this would be 143 instead.
			expect(exit.code).toBe(0);
			expect(exit.signal).toBeNull();
		},
		60_000,
	);
});
