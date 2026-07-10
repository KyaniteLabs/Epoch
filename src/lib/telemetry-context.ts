// ---------------------------------------------------------------------------
// Telemetry context — process-scoped agent-qualification signal.
//
// Each Epoch entrypoint (mcp.ts, cli.ts, http.ts) dedicates the whole process
// to a single transport, so a module-level setter/getter pair is sufficient:
// no request-scoped state is needed. entries/mcp.ts calls setTransport() at
// startup and setMcpClientInfo() once the MCP `initialize` handshake
// completes (oninitialized), before any tool call can trigger a telemetry
// submission. telemetry-submit.ts reads this context when building the
// SubmissionPayload; it never mutates it.
// ---------------------------------------------------------------------------

export type Transport = "mcp-stdio" | "mcp-http" | "cli" | "rest";
export type RuntimeHint = "agent" | "human" | "unknown";

export interface McpClientInfo {
	name: string | null;
	version: string | null;
}

/**
 * Client names known to be AI-agent coding tools/harnesses. Used only to
 * compute the honest, coarse `runtime_hint` — never for behavioral
 * fingerprinting or anything beyond this one heuristic.
 */
const KNOWN_AGENT_CLIENT_NAMES = new Set([
	"claude-code",
	"claude-desktop",
	"claude-ai",
	"cursor",
	"cursor-agent",
	"windsurf",
	"codex",
	"codex-cli",
	"cline",
	"zed",
	"continue",
	"roo-code",
	"kilocode",
	"amp",
	"cody",
	"aider",
]);

let mcpClientInfo: McpClientInfo = { name: null, version: null };
let currentTransport: Transport | null = null;

/** Called once by entries/mcp.ts after the MCP `initialize` handshake resolves. */
export function setMcpClientInfo(
	info: { name?: string; version?: string } | undefined,
): void {
	mcpClientInfo = {
		name: info?.name?.trim() || null,
		version: info?.version?.trim() || null,
	};
}

export function getMcpClientInfo(): McpClientInfo {
	return mcpClientInfo;
}

/** Called once by each entrypoint (mcp.ts / cli.ts / http.ts) at startup. */
export function setTransport(value: Transport): void {
	currentTransport = value;
}

export function getTransport(): Transport | null {
	return currentTransport;
}

function isInteractiveTty(): boolean {
	return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/**
 * Coarse, honest runtime classification. No behavioral fingerprinting beyond
 * this heuristic: MCP transport from a recognized agent client -> "agent";
 * interactive TTY CLI invocation -> "human"; everything else -> "unknown".
 */
export function computeRuntimeHint(): RuntimeHint {
	const transport = getTransport();
	if (transport === "mcp-stdio" || transport === "mcp-http") {
		const name = mcpClientInfo.name?.toLowerCase();
		if (name && KNOWN_AGENT_CLIENT_NAMES.has(name)) return "agent";
		return "unknown";
	}
	if (transport === "cli" && isInteractiveTty()) return "human";
	return "unknown";
}

/** Test-only: reset module state between test cases. */
export function resetTelemetryContextForTests(): void {
	mcpClientInfo = { name: null, version: null };
	currentTransport = null;
}
