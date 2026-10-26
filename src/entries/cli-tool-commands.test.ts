import { describe, expect, it } from "vitest";
import { listTools } from "../dispatcher/index.js";
import { TOOL_COMMANDS } from "./cli-tool-commands.js";

describe("CLI tool command spec", () => {
	it("names only tools the dispatcher registry knows", () => {
		const registered = new Set(listTools().map((tool) => tool.name));
		const unknown = TOOL_COMMANDS.map((spec) => spec.tool).filter((tool) => !registered.has(tool));
		expect(unknown).toEqual([]);
	});

	it("has unique command names, tools and option keys", () => {
		const names = TOOL_COMMANDS.map((spec) => spec.name);
		expect(new Set(names).size).toBe(names.length);
		for (const spec of TOOL_COMMANDS) {
			const keys = spec.options.map((option) => `${option.into ?? ""}.${option.key}`);
			expect(new Set(keys).size, spec.name).toBe(keys.length);
		}
	});

	it("never combines a required flag with a truthy-only include", () => {
		for (const spec of TOOL_COMMANDS) {
			for (const option of spec.options) {
				expect(option.required && option.include === "truthy", `${spec.name} ${option.flags}`).toBeFalsy();
			}
		}
	});
});
