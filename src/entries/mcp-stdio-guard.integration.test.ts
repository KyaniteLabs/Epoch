// ---------------------------------------------------------------------------
// stdio protocol-hygiene integration pins (2026-09-19 adversarial battery)
// ---------------------------------------------------------------------------
//
// Spawns the REAL stdio MCP server (tsx src/index.ts, no mocks) and drives one
// scripted hostile session, pinning each cure end to end:
//
//   1. garbage non-JSON line          -> -32700 parse error, id null
//   2. request before initialize      -> -32002 server-not-initialized
//   3. params:null before initialize  -> -32602 (parse-level check precedes state)
//   4. batch (JSON array) line        -> -32600 batch-not-supported
//   5. initialize                     -> real SDK result (guard is transparent)
//   6. params:null AFTER initialize    -> -32602 with echoed id (CGO-12 pin)
//   7. tools/list after all the abuse -> server still healthy, 26 tools
//   8. stdin EOF                      -> process exits 0 (no hang)
//
// Mirrors the spawn pattern of ledger-concurrency.test.ts (repo tsx binary).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const hasTsx = existsSync(TSX_BIN);

interface Line {
	jsonrpc: string;
	id?: string | number | null;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

class StdioSession {
	private buffer = "";
	private readonly lines: Line[] = [];
	public stderr = "";
	public exited: Promise<{ code: number | null; signal: string | null }>;

	constructor() {
		const child = spawn(TSX_BIN, [join(REPO_ROOT, "src", "index.ts")], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				EPOCH_DATA_DIR: join(DATA_DIR, "epoch-data"),
				EPOCH_TELEMETRY: "0",
				NO_COLOR: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
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

	private child: ReturnType<typeof spawn>;
	private readonly stdin: NodeJS.WritableStream;

	sendRaw(payload: string): void {
		this.stdin.write(payload + "\n");
	}

	send(message: unknown): void {
		this.sendRaw(JSON.stringify(message));
	}

	async waitForId(id: string | number | null, timeoutMs = 15_000): Promise<Line> {
		return this.waitFor((line) => line.id === id, `id ${String(id)}`, timeoutMs);
	}

	/**
	 * Cursor-based wait: scans only lines that arrived after the previous
	 * wait resolved, so two id-null responses (e.g. -32700 then -32600)
	 * are consumed in order.
	 */
	async waitFor(
		predicate: (line: Line) => boolean,
		label: string,
		timeoutMs = 15_000,
	): Promise<Line> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.lines.slice(this.cursor).find(predicate);
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
					`server exited (code ${exit.code}) while waiting for ${label}: ${this.stderr.slice(0, 400)}`,
				);
			}
		}
		throw new Error(
			`timeout waiting for ${label}; got ${this.lines.length} lines, stderr: ${this.stderr.slice(0, 400)}`,
		);
	}

	private cursor = 0;

	async allLines(): Promise<Line[]> {
		await new Promise((resolve) => setTimeout(resolve, 300));
		return [...this.lines];
	}

	closeStdin(): void {
		this.stdin.end();
	}

	kill(): void {
		this.child.kill("SIGKILL");
	}
}

const DATA_DIR = hasTsx ? mkdtempSync(join(tmpdir(), "epoch-guard-int-")) : "";

const suite = hasTsx ? describe : describe.skip;

suite("stdio JSON-RPC guard (integration, real server)", () => {
	let session: StdioSession;

	beforeAll(() => {
		session = new StdioSession();
	});

	afterAll(() => {
		session.kill();
		rmSync(DATA_DIR, { recursive: true, force: true });
	});

	it(
		"answers garbage with -32700, pre-init requests with -32002, params:null with -32602, batches with -32600 — then serves a clean session and exits 0",
		async () => {
			// 1. garbage non-JSON line -> -32700, id null
			session.sendRaw("%%%not json%%%");
			const parseError = await session.waitForId(null);
			expect(parseError.error?.code).toBe(-32700);
			expect(parseError.id).toBeNull();

			// 2. request before initialize -> -32002 with echoed id
			session.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
			const preInit = await session.waitForId(1);
			expect(preInit.error?.code).toBe(-32002);
			expect(preInit.error?.message).toContain("initialize");

			// 3. params:null pre-init -> parse-level -32602 wins
			session.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: null });
			const nullParamsPre = await session.waitForId(2);
			expect(nullParamsPre.error?.code).toBe(-32602);

			// 4. batch line -> -32600 batch-not-supported
			session.sendRaw('[{"jsonrpc":"2.0","id":3,"method":"tools/list"}]');
			const batch = await session.waitForId(null);
			expect(batch.error?.code).toBe(-32600);
			expect(batch.error?.message).toContain("batch");

			// 5. real initialize passes through the guard untouched
			session.send({
				jsonrpc: "2.0",
				id: 10,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "guard-integration-test", version: "1.0.0" },
				},
			});
			const init = await session.waitForId(10);
			expect(init.error).toBeUndefined();
			expect((init.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe("epoch");
			session.send({ jsonrpc: "2.0", method: "notifications/initialized" });

			// 6. params:null AFTER initialize -> -32602, echoed id (the CGO-12 pin)
			session.send({ jsonrpc: "2.0", id: 11, method: "tools/call", params: null });
			const nullParams = await session.waitForId(11);
			expect(nullParams.error).toEqual({
				code: -32602,
				message: "Invalid params: params must be an object, not null",
			});

			// 7. the server is still healthy: tools/list answers with the full registry
			session.send({ jsonrpc: "2.0", id: 12, method: "tools/list" });
			const tools = await session.waitForId(12);
			expect(tools.error).toBeUndefined();
			const toolNames = (
				tools.result as { tools?: Array<{ name: string }> }
			)?.tools?.map((t) => t.name);
			expect(toolNames).toContain("pert_estimate");
			expect(toolNames?.length).toBeGreaterThanOrEqual(26);

			// exactly one response per hostile probe id — nothing doubled, nothing orphaned
			const all = await session.allLines();
			for (const id of [1, 2, 10, 11, 12]) {
				expect(all.filter((line) => line.id === id)).toHaveLength(1);
			}
			const idNull = all.filter((line) => line.id === null && line.error);
			expect(idNull.map((l) => l.error?.code).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
				-32700,
				-32600,
			]);

			// 8. EOF -> clean exit 0, no hang, no stderr storm
			session.closeStdin();
			const exit = await Promise.race([
				session.exited,
				new Promise<{ code: number | null; signal: string | null }>((resolve) =>
					setTimeout(() => resolve({ code: -999, signal: "HANG" }), 10_000),
				),
			]);
			expect(exit.code).toBe(0);
			expect(session.stderr).toBe("");
		},
		60_000,
	);
});
