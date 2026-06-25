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
            return Err(format!("unexpected write tools: {:?}", self.write_tool_names));
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
