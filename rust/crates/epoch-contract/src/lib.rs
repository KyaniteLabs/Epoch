use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PublicSurfaceContract {
    pub package_name: String,
    pub mcp_tool_names: Vec<String>,
    pub write_tool_names: Vec<String>,
    pub http_routes: Vec<String>,
    pub cli_command_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolError {
    pub is_error: bool,
    pub message: String,
    pub retry_hint: Option<String>,
}

impl ToolError {
    pub fn new(message: impl Into<String>, retry_hint: impl Into<String>) -> Self {
        Self {
            is_error: true,
            message: message.into(),
            retry_hint: Some(retry_hint.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalResult {
    pub iso: String,
    pub human_readable: String,
    pub timezone: String,
    pub utc_offset: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DurationResult {
    pub input: String,
    pub total_seconds: f64,
    pub human_readable: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DateDiffResult {
    pub days: i64,
    pub hours: i64,
    pub minutes: i64,
    pub total_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BusinessDayResult {
    pub start_date: String,
    pub end_date: String,
    pub business_days: i64,
    pub country_code: String,
    pub human_readable: String,
}

impl PublicSurfaceContract {
    pub fn parse(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(raw)
    }

    pub fn validate_milestone_zero(&self) -> Result<(), String> {
        if self.package_name != "@kyanitelabs/epoch" {
            return Err(format!("unexpected package name: {}", self.package_name));
        }
        if self.mcp_tool_names.len() != 24 {
            return Err(format!(
                "expected 24 MCP tools, got {}",
                self.mcp_tool_names.len(),
            ));
        }
        if self.write_tool_names != ["record_actual", "batch_record_actuals"] {
            return Err(format!(
                "unexpected write tools: {:?}",
                self.write_tool_names
            ));
        }
        if self.http_routes.len() != 11 {
            return Err(format!(
                "expected 11 HTTP routes, got {}",
                self.http_routes.len(),
            ));
        }
        if self.cli_command_paths.len() != 39 {
            return Err(format!(
                "expected 39 CLI command paths, got {}",
                self.cli_command_paths.len(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::PublicSurfaceContract;

    const SURFACE: &str =
        include_str!("../../../../docs/superpowers/contracts/epoch-public-surface.json");

    #[test]
    fn parses_exported_public_surface_contract() {
        let contract = PublicSurfaceContract::parse(SURFACE).expect("valid contract JSON");
        contract
            .validate_milestone_zero()
            .expect("valid milestone 0 surface");
        assert_eq!(contract.mcp_tool_names[0], "get_current_time");
        assert_eq!(contract.mcp_tool_names[23], "feedback_health");
    }
}
