use epoch_contract::ToolError;
use epoch_mcp::RustToolDispatcher;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub use epoch_contract::{HTTP_ROUTES, PublicSurfaceContract, ToolMetadata, tool_registry};

pub fn http_routes() -> &'static [&'static str] {
    HTTP_ROUTES
}

pub fn direct_feedback_routes() -> Vec<&'static str> {
    tool_registry()
        .iter()
        .filter_map(|tool| tool.direct_http_route)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustHttpResponse {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Clone, Default)]
pub struct RustHttpRouter {
    dispatcher: RustToolDispatcher,
    telemetry_events: Vec<Value>,
}

impl RustHttpRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_dispatcher(dispatcher: RustToolDispatcher) -> Self {
        Self {
            dispatcher,
            telemetry_events: Vec::new(),
        }
    }

    pub fn dispatcher(&self) -> &RustToolDispatcher {
        &self.dispatcher
    }

    pub fn telemetry_events(&self) -> &[Value] {
        &self.telemetry_events
    }

    pub fn route(&mut self, method: HttpMethod, path: &str, body: Value) -> RustHttpResponse {
        match (method, path) {
            (HttpMethod::Get, "/health") => ok(json!({
                "ok": true,
                "service": "epoch-rust",
                "tools": tool_registry().len(),
            })),
            (HttpMethod::Get, "/v1/tools") => ok(tools_body()),
            (HttpMethod::Post, "/v1/telemetry") => self.record_telemetry(body),
            (HttpMethod::Get, "/.well-known/ai-plugin.json") => ok(plugin_manifest()),
            (HttpMethod::Get, "/llms.txt") => ok(Value::String(llms_txt())),
            (HttpMethod::Get, "/openapi.json") => ok(openapi_body()),
            (HttpMethod::Post, "/v1/feedback/record-actual") => {
                self.tool_response("record_actual", body)
            }
            (HttpMethod::Get, "/v1/feedback/pending") => {
                self.tool_response("get_pending_estimates", json!({}))
            }
            (HttpMethod::Post, "/v1/feedback/batch-record-actuals") => {
                self.tool_response("batch_record_actuals", body)
            }
            (HttpMethod::Get, "/v1/feedback/health") => {
                self.tool_response("feedback_health", json!({}))
            }
            (HttpMethod::Post, path) if path.starts_with("/v1/tools/") => {
                let tool_name = path.trim_start_matches("/v1/tools/");
                self.tool_response(tool_name, body)
            }
            _ => error_response(
                404,
                ToolError::new(
                    format!("Unknown route: {path}."),
                    "Use GET /v1/tools or POST /v1/tools/:toolName.",
                ),
            ),
        }
    }

    fn tool_response(&mut self, tool_name: &str, body: Value) -> RustHttpResponse {
        match self.dispatcher.dispatch(tool_name, body) {
            Ok(data) => ok(data),
            Err(error) if error.message.contains("Unknown tool") => error_response(404, error),
            Err(error) => error_response(422, error),
        }
    }

    fn record_telemetry(&mut self, body: Value) -> RustHttpResponse {
        self.telemetry_events.push(body);
        RustHttpResponse {
            status: 202,
            body: json!({
                "accepted": true,
                "storedEvents": self.telemetry_events.len(),
                "mode": "local-rust-runtime",
            }),
        }
    }
}

pub fn crate_label() -> &'static str {
    "epoch-http"
}

fn ok(body: Value) -> RustHttpResponse {
    RustHttpResponse { status: 200, body }
}

fn error_response(status: u16, error: ToolError) -> RustHttpResponse {
    RustHttpResponse {
        status,
        body: json!({ "error": error }),
    }
}

fn tools_body() -> Value {
    json!({
        "count": tool_registry().len(),
        "tools": tool_registry()
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "category": tool.category,
                "inputSchema": tool.input_schema,
                "outputSchema": tool.output_schema,
                "cliCommand": tool.cli_command,
                "directHttpRoute": tool.direct_http_route,
                "annotations": tool.annotations,
            }))
            .collect::<Vec<_>>(),
    })
}

fn plugin_manifest() -> Value {
    json!({
        "schema_version": "v1",
        "name_for_human": "Epoch",
        "name_for_model": "epoch",
        "description_for_model": "Structured time, estimation, cost, risk, and feedback tools.",
        "api": { "type": "openapi", "url": "/openapi.json" },
    })
}

fn llms_txt() -> String {
    let tools = tool_registry()
        .iter()
        .map(|tool| format!("- {}: {}", tool.name, tool.description))
        .collect::<Vec<_>>()
        .join("\n");
    format!("# Epoch\n\nStructured time estimation tools for LLMs.\n\n{tools}")
}

fn openapi_body() -> Value {
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Epoch Rust Adapter",
            "version": "0.1.0",
        },
        "paths": HTTP_ROUTES
            .iter()
            .map(|route| {
                let mut parts = route.splitn(2, ' ');
                let method = parts.next().unwrap_or("GET").to_lowercase();
                let path = parts.next().unwrap_or("/");
                (path.to_string(), json!({
                    method: {
                        "responses": {
                            "200": { "description": "OK" }
                        }
                    }
                }))
            })
            .collect::<serde_json::Map<String, Value>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::{HttpMethod, RustHttpRouter, crate_label, direct_feedback_routes, http_routes};
    use serde_json::json;

    #[test]
    fn reports_crate_label() {
        assert_eq!(crate_label(), "epoch-http");
    }

    #[test]
    fn exposes_full_http_public_surface() {
        let routes = http_routes();
        assert_eq!(routes.len(), 11);
        assert!(routes.contains(&"POST /v1/tools/:toolName"));
        assert!(routes.contains(&"GET /openapi.json"));
    }

    #[test]
    fn maps_feedback_tools_to_direct_routes() {
        assert_eq!(
            direct_feedback_routes(),
            vec![
                "POST /v1/feedback/record-actual",
                "GET /v1/feedback/pending",
                "POST /v1/feedback/batch-record-actuals",
                "GET /v1/feedback/health",
            ]
        );
    }

    #[test]
    fn routes_health_tools_and_openapi() {
        let mut router = RustHttpRouter::new();

        let health = router.route(HttpMethod::Get, "/health", json!({}));
        assert_eq!(health.status, 200);
        assert_eq!(health.body["tools"], 24);

        let tools = router.route(HttpMethod::Get, "/v1/tools", json!({}));
        assert_eq!(tools.status, 200);
        assert_eq!(tools.body["count"], 24);

        let openapi = router.route(HttpMethod::Get, "/openapi.json", json!({}));
        assert_eq!(openapi.status, 200);
        assert_eq!(openapi.body["openapi"], "3.1.0");
    }

    #[test]
    fn records_telemetry_payloads_locally() {
        let mut router = RustHttpRouter::new();

        let response = router.route(
            HttpMethod::Post,
            "/v1/telemetry",
            json!({ "event": "tool-call", "tool": "pert_estimate" }),
        );

        assert_eq!(response.status, 202);
        assert_eq!(response.body["accepted"], true);
        assert_eq!(response.body["storedEvents"], 1);
        assert_eq!(router.telemetry_events().len(), 1);
        assert_eq!(router.telemetry_events()[0]["tool"], "pert_estimate");
    }

    #[test]
    fn routes_tool_execution_and_feedback_state() {
        let mut router = RustHttpRouter::new();

        let estimate = router.route(
            HttpMethod::Post,
            "/v1/tools/pert_estimate",
            json!({ "optimistic": 1, "most_likely": 2, "pessimistic": 4 }),
        );
        assert_eq!(estimate.status, 200);
        assert_eq!(estimate.body["feedbackRef"], "rust-estimate-1");

        let pending = router.route(HttpMethod::Get, "/v1/feedback/pending", json!({}));
        assert_eq!(pending.status, 200);
        assert_eq!(pending.body["count"], 1);

        let actual = router.route(
            HttpMethod::Post,
            "/v1/feedback/record-actual",
            json!({ "estimate_id": "rust-estimate-1", "actual_hours": 2.5 }),
        );
        assert_eq!(actual.status, 200);
        assert_eq!(actual.body["recorded"], true);

        let health = router.route(HttpMethod::Get, "/v1/feedback/health", json!({}));
        assert_eq!(health.body["totalActuals"], 1);
    }

    #[test]
    fn reports_route_and_tool_errors_with_status_codes() {
        let mut router = RustHttpRouter::new();

        let missing = router.route(HttpMethod::Get, "/missing", json!({}));
        assert_eq!(missing.status, 404);

        let unknown_tool = router.route(HttpMethod::Post, "/v1/tools/nope", json!({}));
        assert_eq!(unknown_tool.status, 404);

        let invalid_input = router.route(
            HttpMethod::Post,
            "/v1/tools/pert_estimate",
            json!({ "optimistic": 10, "most_likely": 2, "pessimistic": 4 }),
        );
        assert_eq!(invalid_input.status, 422);
    }
}
