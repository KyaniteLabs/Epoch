import { Transform } from "node:stream";

/**
 * Line-wise JSON-RPC 2.0 hygiene guard for the stdio MCP transport.
 *
 * The MCP SDK's {@link StdioServerTransport} validates each line with a zod
 * schema and swallows validation failures through `onerror` — the line is
 * dropped with no JSON-RPC response on stdout. The adversarial battery
 * (2026-09-19, CGO lane) proved three such silent drops on the published
 * server, plus permissive pre-initialize answering:
 *
 * 1. `params: null` on a request → the request is orphaned: a blocking client
 *    waiting on that id hangs forever (battery probe A8, defect class CGO-12).
 * 2. A non-JSON (or BOM-mangled) line → dropped with no `-32700 Parse error`.
 * 3. A JSON array (batch) line → dropped with no `-32600`; MCP 2025-06-18
 *    removed batching, so the correct answer is a single Invalid Request error.
 * 4. Requests sent before `initialize` → answered normally instead of being
 *    rejected with `-32002 ServerNotInitialized`.
 *
 * This guard sits between `process.stdin` and the SDK transport (the achiote
 * cure pattern): every complete line is inspected; malformed lines are
 * answered directly on stdout per JSON-RPC 2.0 §5.1 and removed from the
 * stream; well-formed lines are forwarded byte-identically for the SDK to
 * handle. Blank lines are dropped without a response — they are not messages,
 * and answering padding sent by hand-testing terminals would be noise.
 */

/** A complete JSON-RPC 2.0 error response object. */
export interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	error: { code: number; message: string };
}

/** What the guard decided to do with one complete stdin line. */
export interface StdioGuardDecision {
	/** `true` when the line should reach the SDK transport untouched. */
	forward: boolean;
	/** When set, this error response is written to stdout for the line. */
	response?: JsonRpcErrorResponse;
}

/** Mutable connection state the guard tracks across lines. */
export interface StdioGuardState {
	/** Whether an `initialize` request has been seen on this connection. */
	sawInitializeRequest: boolean;
}

export function createStdioGuardState(): StdioGuardState {
	return { sawInitializeRequest: false };
}

const BOM = "\uFEFF";

function errorResponse(
	id: string | number | null,
	code: number,
	message: string,
): StdioGuardDecision {
	return {
		forward: false,
		response: { jsonrpc: "2.0", id, error: { code, message } },
	};
}

function passThrough(): StdioGuardDecision {
	return { forward: true };
}

function drop(): StdioGuardDecision {
	return { forward: false };
}

/** A request/notification id we can legally echo back: string, number, or null. */
function echoableId(id: unknown): string | number | null {
	if (id === null || typeof id === "string" || typeof id === "number") {
		return id;
	}
	return null;
}

/**
 * JSON-RPC params must be an object when present. `null`, arrays, and scalars
 * all fail the SDK's zod validation — which is exactly the silent-drop class
 * this guard exists to cure.
 */
function paramsViolationKind(params: unknown): string | null {
	if (params === undefined) return null;
	if (params === null) return "null";
	if (Array.isArray(params)) return "an array";
	if (typeof params !== "object") return `of type ${typeof params}`;
	return null;
}

/**
 * Inspect one complete stdin line and decide what to do with it.
 *
 * @param line  the raw line (no trailing newline), exactly as read from stdin.
 * @param state the connection's guard state; mutated when `initialize` passes.
 */
export function inspectStdioLine(
	line: string,
	state: StdioGuardState,
): StdioGuardDecision {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return drop();
	}
	// A UTF-8 BOM prefix would make JSON.parse throw (silent-drop class);
	// strip it so the line gets a fair inspection.
	const withoutBom = trimmed.startsWith(BOM) ? trimmed.slice(BOM.length) : trimmed;
	if (withoutBom.length === 0) {
		return drop();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(withoutBom);
	} catch {
		return errorResponse(null, -32700, "Parse error: line is not valid JSON");
	}

	if (Array.isArray(parsed)) {
		// JSON-RPC 2.0 batches were removed by MCP 2025-06-18; a single
		// Invalid Request error is the spec-compliant refusal.
		return errorResponse(
			null,
			-32600,
			"Invalid Request: batch requests are not supported",
		);
	}
	if (typeof parsed !== "object" || parsed === null) {
		return errorResponse(
			null,
			-32600,
			`Invalid Request: expected a JSON-RPC message object, got ${typeof parsed}`,
		);
	}

	const message = parsed as Record<string, unknown>;
	const hasMethod = typeof message.method === "string";
	const isNotification = hasMethod && message.id === undefined;
	const id = echoableId(message.id);

	if (message.jsonrpc !== "2.0") {
		// The SDK schema requires the literal "2.0"; anything else would be
		// dropped silently. Notifications cannot be answered (no id).
		if (isNotification) {
			return drop();
		}
		return errorResponse(
			id,
			-32600,
			'Invalid Request: missing or invalid "jsonrpc" field (expected "2.0")',
		);
	}

	const paramsKind = paramsViolationKind(message.params);
	if (paramsKind !== null) {
		if (isNotification) {
			// No id means no legal response; drop rather than feed the SDK a
			// line its schema is guaranteed to reject.
			return drop();
		}
		return errorResponse(
			id,
			-32602,
			`Invalid params: params must be an object, not ${paramsKind}`,
		);
	}

	if (hasMethod && !isNotification && !state.sawInitializeRequest && message.method !== "initialize") {
		// MCP requires the client's first request to be `initialize`; until
		// then every other request is refused with ServerNotInitialized.
		return errorResponse(
			id,
			-32002,
			`Server not initialized: ${message.method} was sent before the initialize request`,
		);
	}

	if (hasMethod) {
		if (message.method === "initialize") {
			state.sawInitializeRequest = true;
		}
		return passThrough();
	}

	// No method: either a response to a server-initiated request (forward;
	// the SDK routes it) or an object that is not a JSON-RPC message at all.
	if (message.result !== undefined || message.error !== undefined) {
		return passThrough();
	}
	return errorResponse(
		id,
		-32600,
		"Invalid Request: not a JSON-RPC message (no method, result, or error)",
	);
}

/**
 * Build the stdin-side Transform. Pipe `process.stdin` into it and hand it to
 * `new StdioServerTransport(transform)` — the transport then reads guarded
 * lines while the guard writes direct error responses to stdout.
 *
 * `writeResponse` is injectable so tests can capture guard responses without
 * touching the real stdout.
 */
export function createStdioGuardTransform(options?: {
	state?: StdioGuardState;
	writeResponse?: (response: JsonRpcErrorResponse) => void;
}): Transform {
	const state = options?.state ?? createStdioGuardState();
	const writeResponse =
		options?.writeResponse ??
		((response: JsonRpcErrorResponse) => {
			process.stdout.write(JSON.stringify(response) + "\n");
		});
	let partialLine = "";

	const handleLine = (line: string): string | null => {
		const decision = inspectStdioLine(line, state);
		if (decision.response) {
			writeResponse(decision.response);
		}
		return decision.forward ? line : null;
	};

	return new Transform({
		transform(
			chunk: Buffer,
			_encoding: BufferEncoding,
			callback: (error: Error | null, data: Buffer | string | null) => void,
		): void {
			partialLine += chunk.toString("utf8");
			const lines = partialLine.split("\n");
			partialLine = lines.pop() ?? "";
			const forwarded = lines
				.map(handleLine)
				.filter((line): line is string => line !== null);
			callback(
				null,
				forwarded.length > 0 ? forwarded.join("\n") + "\n" : null,
			);
		},
		flush(
			callback: (error: Error | null, data: Buffer | string | null) => void,
		): void {
			if (partialLine.length === 0) {
				callback(null, null);
				return;
			}
			const line = partialLine;
			partialLine = "";
			const forwarded = handleLine(line);
			callback(null, forwarded !== null ? forwarded + "\n" : null);
		},
	});
}
