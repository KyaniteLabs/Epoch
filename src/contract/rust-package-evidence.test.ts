import { describe, expect, it } from "vitest";

import {
	hasRequiredPackageCommands,
	packageCommandHasExpectedEvidence,
	packageCommandsFromUnknown,
	packagePrebuildTarget,
	type PackageCommandEvidence,
} from "./rust-package-evidence.js";

function command(
	overrides: Partial<PackageCommandEvidence> & Pick<PackageCommandEvidence, "name">,
): PackageCommandEvidence {
	return {
		name: overrides.name,
		target: overrides.target ?? "",
		exitCode: overrides.exitCode ?? 0,
		signal: overrides.signal ?? null,
		stdoutHead: overrides.stdoutHead ?? "",
		stderrHead: overrides.stderrHead ?? "",
		error: overrides.error ?? null,
	};
}

function validCommands(): PackageCommandEvidence[] {
	return [
		command({
			name: "epoch-cli",
			target: "node_modules/.bin/epoch",
			stdoutHead: '{ "ok": true, "data": {',
		}),
		command({
			name: "epoch-mcp",
			target: packagePrebuildTarget("epoch-mcp"),
			stdoutHead: 'Content-Length: 36 {"id":1,"jsonrpc":"2.0","result":{}}',
		}),
		command({
			name: "epoch-http",
			target: packagePrebuildTarget("epoch-http"),
			stdoutHead: 'health {"status":"ok","tools":24,"uptime":0.0}',
			stderrHead: "epoch-http listening on http://127.0.0.1:50277",
		}),
	];
}

describe("rust package evidence", () => {
	it("accepts the installed CLI, MCP, and HTTP package smoke signatures", () => {
		expect(hasRequiredPackageCommands(validCommands())).toBe(true);
	});

	it("rejects HTTP smoke output without live health metadata", () => {
		const commands = validCommands();
		commands[2] = command({
			name: "epoch-http",
			target: packagePrebuildTarget("epoch-http"),
			stdoutHead: "server started",
		});

		expect(hasRequiredPackageCommands(commands)).toBe(false);
		expect(packageCommandHasExpectedEvidence(commands[2])).toBe(false);
	});

	it("rejects prebuild evidence from the wrong platform path", () => {
		const commands = validCommands();
		commands[1] = command({
			name: "epoch-mcp",
			target: "prebuilds/linux-x64/epoch-mcp",
			stdoutHead: 'Content-Length: 36 {"id":1,"jsonrpc":"2.0","result":{}}',
		});

		expect(hasRequiredPackageCommands(commands)).toBe(false);
	});

	it("normalizes unknown raw command arrays conservatively", () => {
		expect(
			packageCommandsFromUnknown([
				{
					name: "epoch-cli",
					target: "node_modules/.bin/epoch",
					exitCode: 0,
					signal: null,
					stdoutHead: '{ "ok": true }',
					stderrHead: "",
					error: null,
				},
				{ name: 42, target: "ignored" },
				"ignored",
			]),
		).toEqual([
			{
				name: "epoch-cli",
				target: "node_modules/.bin/epoch",
				exitCode: 0,
				signal: null,
				stdoutHead: '{ "ok": true }',
				stderrHead: "",
				error: null,
			},
		]);
	});
});
