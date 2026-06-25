import { describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../dispatcher/index.js";
import { createCliProgram } from "../entries/cli.js";
import { createApiApp } from "../entries/http.js";
import {
	EXPECTED_CLI_COMMAND_PATHS,
	EXPECTED_HTTP_ROUTES,
	EXPECTED_MCP_TOOL_NAMES,
	EXPECTED_WRITE_TOOL_NAMES,
	collectCliCommandPaths,
	collectHttpRoutes,
} from "./public-surface.js";

describe("public surface inventory", () => {
	it("matches the live MCP tool registry", () => {
		expect([...TOOL_REGISTRY.keys()]).toEqual(EXPECTED_MCP_TOOL_NAMES);
		expect(EXPECTED_MCP_TOOL_NAMES).toHaveLength(24);
	});

	it("records the write tools explicitly", () => {
		expect(EXPECTED_WRITE_TOOL_NAMES).toEqual([
			"record_actual",
			"batch_record_actuals",
		]);
	});

	it("matches the live CLI command tree", () => {
		expect(collectCliCommandPaths(createCliProgram())).toEqual(
			EXPECTED_CLI_COMMAND_PATHS,
		);
		expect(EXPECTED_CLI_COMMAND_PATHS).toHaveLength(39);
	});

	it("matches the live HTTP routes", () => {
		expect(collectHttpRoutes(createApiApp())).toEqual(EXPECTED_HTTP_ROUTES);
		expect(EXPECTED_HTTP_ROUTES).toHaveLength(11);
	});
});
