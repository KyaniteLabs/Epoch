import { describe, expect, it } from "vitest";
import {
	createStdioGuardState,
	createStdioGuardTransform,
	inspectStdioLine,
	type JsonRpcErrorResponse,
} from "./jsonrpc-stdio-guard.js";

/**
 * Regression pins for the 2026-09-19 adversarial battery defect class
 * (CGO-12): the SDK transport silently drops malformed JSON-RPC lines.
 * Each test pins one clause of the cure.
 */
describe("inspectStdioLine", () => {
	it("answers params:null requests with -32602 and the echoed id (CGO-12)", () => {
		const state = createStdioGuardState();
		state.sawInitializeRequest = true;
		const decision = inspectStdioLine(
			'{"jsonrpc":"2.0","id":13,"method":"tools/call","params":null}',
			state,
		);
		expect(decision.forward).toBe(false);
		expect(decision.response).toEqual({
			jsonrpc: "2.0",
			id: 13,
			error: {
				code: -32602,
				message: "Invalid params: params must be an object, not null",
			},
		});
	});

	it("answers non-object params (array, string, number) with -32602", () => {
		const state = createStdioGuardState();
		state.sawInitializeRequest = true;
		for (const [params, kind] of [
			["[]", "an array"],
			['"tools"', "of type string"],
			["42", "of type number"],
		] as const) {
			const decision = inspectStdioLine(
				`{"jsonrpc":"2.0","id":7,"method":"tools/list","params":${params}}`,
				state,
			);
			expect(decision.forward).toBe(false);
			expect(decision.response?.error.code).toBe(-32602);
			expect(decision.response?.error.message).toContain(kind);
		}
	});

	it("drops notifications with params:null silently (no id to answer)", () => {
		const state = createStdioGuardState();
		state.sawInitializeRequest = true;
		const decision = inspectStdioLine(
			'{"jsonrpc":"2.0","method":"notifications/cancelled","params":null}',
			state,
		);
		expect(decision.forward).toBe(false);
		expect(decision.response).toBeUndefined();
	});

	it("answers non-JSON garbage lines with -32700 and id null", () => {
		const state = createStdioGuardState();
		const decision = inspectStdioLine("%%%not json%%%", state);
		expect(decision.forward).toBe(false);
		expect(decision.response).toEqual({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "Parse error: line is not valid JSON" },
		});
	});

	it("answers batch (JSON array) lines with -32600 batch-not-supported", () => {
		const state = createStdioGuardState();
		const decision = inspectStdioLine(
			'[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]',
			state,
		);
		expect(decision.forward).toBe(false);
		expect(decision.response?.id).toBeNull();
		expect(decision.response?.error.code).toBe(-32600);
		expect(decision.response?.error.message).toContain(
			"batch requests are not supported",
		);
	});

	it("answers non-object JSON scalars with -32600", () => {
		const state = createStdioGuardState();
		const decision = inspectStdioLine("42", state);
		expect(decision.forward).toBe(false);
		expect(decision.response?.error.code).toBe(-32600);
		expect(decision.response?.id).toBeNull();
	});

	it("rejects requests before initialize with -32002 and the echoed id", () => {
		const state = createStdioGuardState();
		const decision = inspectStdioLine(
			'{"jsonrpc":"2.0","id":21,"method":"tools/list","params":{}}',
			state,
		);
		expect(decision.forward).toBe(false);
		expect(decision.response).toEqual({
			jsonrpc: "2.0",
			id: 21,
			error: {
				code: -32002,
				message:
					"Server not initialized: tools/list was sent before the initialize request",
			},
		});
	});

	it("forwards initialize, flips state, then forwards later requests", () => {
		const state = createStdioGuardState();
		const init = inspectStdioLine(
			'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
			state,
		);
		expect(init.forward).toBe(true);
		expect(init.response).toBeUndefined();
		expect(state.sawInitializeRequest).toBe(true);

		const after = inspectStdioLine(
			'{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
			state,
		);
		expect(after.forward).toBe(true);
	});

	it("answers initialize with params:null with -32602 and does NOT flip state", () => {
		const state = createStdioGuardState();
		const decision = inspectStdioLine(
			'{"jsonrpc":"2.0","id":1,"method":"initialize","params":null}',
			state,
		);
		expect(decision.response?.error.code).toBe(-32602);
		expect(state.sawInitializeRequest).toBe(false);
	});

	it("answers requests missing jsonrpc with -32600; drops such notifications", () => {
		const state = createStdioGuardState();
		state.sawInitializeRequest = true;
		const request = inspectStdioLine('{"id":5,"method":"tools/list"}', state);
		expect(request.forward).toBe(false);
		expect(request.response?.id).toBe(5);
		expect(request.response?.error.code).toBe(-32600);
		expect(request.response?.error.message).toContain("jsonrpc");

		const notification = inspectStdioLine(
			'{"method":"notifications/initialized"}',
			state,
		);
		expect(notification.forward).toBe(false);
		expect(notification.response).toBeUndefined();
	});

	it("answers objects that are not JSON-RPC messages with -32600", () => {
		const state = createStdioGuardState();
		const decision = inspectStdioLine('{"jsonrpc":"2.0","id":9,"hello":"world"}', state);
		expect(decision.forward).toBe(false);
		expect(decision.response?.id).toBe(9);
		expect(decision.response?.error.code).toBe(-32600);
	});

	it("forwards well-formed requests, notifications, and client responses untouched", () => {
		const state = createStdioGuardState();
		state.sawInitializeRequest = true;
		expect(
			inspectStdioLine(
				'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"pert_estimate","arguments":{}}}',
				state,
			).forward,
		).toBe(true);
		expect(
			inspectStdioLine(
				'{"jsonrpc":"2.0","method":"notifications/initialized"}',
				state,
			).forward,
		).toBe(true);
		expect(
			inspectStdioLine('{"jsonrpc":"2.0","id":4,"result":{}}', state).forward,
		).toBe(true);
		expect(
			inspectStdioLine('{"jsonrpc":"2.0","id":4,"error":{"code":-1,"message":"x"}}', state)
				.forward,
		).toBe(true);
	});

	it("strips a UTF-8 BOM before inspecting (BOM lines are no longer a silent drop)", () => {
		const state = createStdioGuardState();
		const valid = inspectStdioLine(
			'﻿{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
			state,
		);
		expect(valid.response?.error.code).toBe(-32002); // parsed fine; rejected for pre-init instead of vanishing

		const state2 = createStdioGuardState();
		const garbage = inspectStdioLine("%%%not json%%%", state2);
		expect(garbage.response?.error.code).toBe(-32700);
	});

	it("drops blank and whitespace-only lines without answering", () => {
		const state = createStdioGuardState();
		for (const line of ["", "   ", "\t"]) {
			const decision = inspectStdioLine(line, state);
			expect(decision.forward).toBe(false);
			expect(decision.response).toBeUndefined();
		}
	});
});

describe("createStdioGuardTransform", () => {
	function harness() {
		const responses: JsonRpcErrorResponse[] = [];
		const forwarded: string[] = [];
		const state = createStdioGuardState();
		// Transform-level tests model an already-initialized connection (the
		// pre-init -32002 rule is pinned at the inspector level above).
		state.sawInitializeRequest = true;
		const transform = createStdioGuardTransform({
			state,
			writeResponse: (r) => responses.push(r),
		});
		transform.on("data", (chunk: Buffer) => forwarded.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
		return { transform, responses, forwarded, state };
	}

	function write(transform: { write: (s: string, cb?: (e?: Error | null) => void) => boolean }, s: string): Promise<void> {
		return new Promise((resolve) => transform.write(s, () => resolve()));
	}

	function settle(): Promise<void> {
		return new Promise((resolve) => setImmediate(resolve));
	}

	it("answers garbage and forwards valid lines from one chunk", async () => {
		const h = harness();
		await write(
			h.transform,
			'%%%garbage%%%\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
		);
		await settle();
		expect(h.responses.map((r) => r.error.code)).toEqual([-32700]);
		expect(h.forwarded).toEqual([
			'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
		]);
	});

	it("reassembles lines split across chunk boundaries", async () => {
		const h = harness();
		await write(h.transform, '{"jsonrpc":"2.0","id":1,"met');
		await settle();
		expect(h.forwarded).toEqual([]);
		await write(h.transform, 'hod":"tools/list"}\n');
		await settle();
		expect(h.forwarded).toEqual([
			'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
		]);
	});

	it("emits nothing for chunks whose lines were all answered", async () => {
		const h = harness();
		await write(h.transform, "not-json\n[1,2]\n\n");
		await settle();
		expect(h.responses.map((r) => r.error.code)).toEqual([-32700, -32600]);
		expect(h.forwarded).toEqual([]);
	});

	it("flushes a trailing line without a newline (answered or forwarded)", async () => {
		const answered = harness();
		answered.transform.end('{"jsonrpc":"2.0","id":6,"method":"tools/call","params":null}');
		await new Promise<void>((resolve) => answered.transform.on("end", () => resolve()));
		expect(answered.responses.map((r) => [r.id, r.error.code])).toEqual([[6, -32602]]);
		expect(answered.forwarded).toEqual([]);

		const forwarded = harness();
		forwarded.state.sawInitializeRequest = true;
		forwarded.transform.end('{"jsonrpc":"2.0","id":6,"method":"tools/list"}');
		await new Promise<void>((resolve) => forwarded.transform.on("end", () => resolve()));
		expect(forwarded.forwarded).toEqual(['{"jsonrpc":"2.0","id":6,"method":"tools/list"}']);
	});

	it("flushes cleanly when the stream ends exactly on a newline", async () => {
		const h = harness();
		h.transform.end("%%%\n");
		await new Promise<void>((resolve) => h.transform.on("end", () => resolve()));
		expect(h.responses.map((r) => r.error.code)).toEqual([-32700]);
		expect(h.forwarded).toEqual([]);
	});

	it("default writeResponse goes to the real stdout (kept on the covered path)", async () => {
		const chunks: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((s: string | Buffer) => {
			chunks.push(String(s));
			return true;
		}) as typeof process.stdout.write;
		try {
			const transform = createStdioGuardTransform();
			transform.on("data", () => {});
			await write(transform, "%%%garbage%%%\n");
			await settle();
		} finally {
			process.stdout.write = originalWrite;
		}
		expect(chunks).toHaveLength(1);
		const parsed = JSON.parse(chunks[0] ?? "") as { error?: { code?: number } };
		expect(parsed.error?.code).toBe(-32700);
	});
});
