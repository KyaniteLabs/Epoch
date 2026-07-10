import type { Command } from "commander";
import type { Hono } from "hono";

export const EXPECTED_MCP_TOOL_NAMES = [
	"get_current_time",
	"convert_timezone",
	"parse_duration",
	"time_math",
	"add_business_days",
	"count_business_days",
	"pert_estimate",
	"cocomo_estimate",
	"sprint_forecast",
	"critical_path",
	"monte_carlo_schedule",
	"reference_class_estimate",
	"calibrate_estimates",
	"token_time_bridge",
	"token_cost_estimate",
	"compare_models",
	"accuracy_trend",
	"schedule_risk",
	"cocomo_validate",
	"cocomo_ground_truth",
	"record_actual",
	"get_pending_estimates",
	"batch_record_actuals",
	"feedback_health",
	"estimate_from_context",
] as const;

export const EXPECTED_WRITE_TOOL_NAMES = [
	"record_actual",
	"batch_record_actuals",
] as const;

export const EXPECTED_HTTP_ROUTES = [
	"GET /health",
	"GET /v1/tools",
	"POST /v1/tools/:toolName",
	"POST /v1/telemetry",
	"GET /.well-known/ai-plugin.json",
	"GET /llms.txt",
	"GET /openapi.json",
	"POST /v1/feedback/record-actual",
	"GET /v1/feedback/pending",
	"POST /v1/feedback/batch-record-actuals",
	"GET /v1/feedback/health",
] as const;

export const EXPECTED_CLI_COMMAND_PATHS = [
	"get-current-time",
	"convert-timezone",
	"parse-duration",
	"time-math",
	"add-business-days",
	"count-business-days",
	"pert-estimate",
	"cocomo-estimate",
	"sprint-forecast",
	"critical-path",
	"monte-carlo-schedule",
	"reference-class-estimate",
	"calibrate-estimates",
	"token-time-bridge",
	"token-cost-estimate",
	"compare-models",
	"accuracy-trend",
	"schedule-risk",
	"cocomo-validate",
	"record-actual",
	"get-pending-estimates",
	"batch-record-actuals",
	"feedback-health",
	"cocomo-ground-truth",
	"estimate-from-context",
	"self-improve",
	"telemetry",
	"telemetry status",
	"telemetry preview",
	"telemetry export",
	"telemetry enable",
	"telemetry set-endpoint",
	"telemetry submit",
	"telemetry disable",
	"telemetry delete-data",
	"share-data",
	"data",
	"data where",
	"data status",
	"list-tools",
] as const;

export const PUBLIC_SURFACE = {
	package_name: "@kyanitelabs/epoch",
	mcp_tool_names: EXPECTED_MCP_TOOL_NAMES,
	write_tool_names: EXPECTED_WRITE_TOOL_NAMES,
	http_routes: EXPECTED_HTTP_ROUTES,
	cli_command_paths: EXPECTED_CLI_COMMAND_PATHS,
} as const;

export type PublicSurface = typeof PUBLIC_SURFACE;

export function collectCliCommandPaths(program: Command): string[] {
	const paths: string[] = [];

	function visit(command: Command, prefix: string[]): void {
		for (const child of command.commands) {
			const next = [...prefix, child.name()];
			paths.push(next.join(" "));
			visit(child, next);
		}
	}

	visit(program, []);
	return paths;
}

type HonoRoute = {
	method?: string;
	path?: string;
};

export function collectHttpRoutes(app: Hono): string[] {
	const routes = ((app as unknown as { routes?: HonoRoute[] }).routes ?? [])
		.map((route) => {
			const method = route.method?.toUpperCase();
			const path = route.path;
			return method && path ? `${method} ${path}` : undefined;
		})
		.filter((route): route is string => route !== undefined)
		.filter((route) => EXPECTED_HTTP_ROUTES.includes(route as never));

	return routes;
}
