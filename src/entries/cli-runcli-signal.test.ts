// ---------------------------------------------------------------------------
// runCli() signal wiring — unit test
// ---------------------------------------------------------------------------
// The CLI entry must install the shared flush-on-signal handler (SIGTERM/
// SIGINT/SIGHUP -> flush buffered telemetry, exit 128+n) as its first act,
// before Commander parses anything, so a signal can never land in a window
// where buffered records are unprotected. The end-to-end flush behavior is
// pinned by signal-flush.integration.test.ts; this pins the CLI wiring.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import {
	FLUSH_SIGNALS,
	installSignalFlushShutdown,
	uninstallSignalFlushShutdown,
} from "../lib/signal-shutdown.js";

// Sentinel thrown by the mocked process.exit (same pattern as cli.test.ts) —
// halts Commander without killing the test worker. --help makes Commander
// exit SYNCHRONOUSLY inside parse(), so the sentinel never escapes into a
// detached async action (no unhandled rejection).
class ExitCalled extends Error {
	readonly exitCode: number;
	constructor(code: number) {
		super(`process.exit(${code})`);
		this.exitCode = code;
	}
}

const TEST_DIR = mkdtempSync(join(tmpdir(), "epoch-cli-signal-"));

describe("runCli() installs the flush-on-signal handler", () => {
	let origArgv: string[];
	let origExit: typeof process.exit;
	let stdoutWrite: ReturnType<typeof vi.spyOn>;
	let stderrWrite: ReturnType<typeof vi.spyOn>;

	beforeAll(() => {
		origArgv = process.argv;
		origExit = process.exit;
		process.env["EPOCH_DATA_DIR"] = TEST_DIR;
		stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterAll(() => {
		process.argv = origArgv;
		process.exit = origExit;
		delete process.env["EPOCH_DATA_DIR"];
		stdoutWrite.mockRestore();
		stderrWrite.mockRestore();
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	afterEach(() => {
		uninstallSignalFlushShutdown();
	});

	it("registers the shared handler before Commander runs", () => {
		// Relative listener counts: vitest may keep its own signal handlers in
		// this worker, so assert the delta runCli() adds, not absolute zero.
		const before = FLUSH_SIGNALS.map((s) => process.listeners(s).length);

		process.exit = ((code?: number) => {
			throw new ExitCalled(code ?? 0);
		}) as typeof process.exit;
		process.argv = [origArgv[0] ?? "node", "--quiet", "--help"];

		// parse() runs to the synchronous --help exit; the sentinel proves it.
		expect(() => runCli()).toThrow(ExitCalled);

		const after = FLUSH_SIGNALS.map((s) => process.listeners(s).length);
		expect(after).toEqual(before.map((n) => n + 1));

		// It is the shared install (idempotent identity), not some CLI-local
		// listener: installSignalFlushShutdown returns the already-active one.
		const handler = process.listeners("SIGTERM").at(-1);
		expect(handler).toBeTypeOf("function");
		expect(installSignalFlushShutdown()).toBe(handler);
	});
});
