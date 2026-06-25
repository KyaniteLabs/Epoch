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

pub fn crate_label() -> &'static str {
    "epoch-http"
}

#[cfg(test)]
mod tests {
    use super::{crate_label, direct_feedback_routes, http_routes};

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
}
