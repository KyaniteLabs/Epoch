use epoch_contract::ToolError;
use epoch_mcp::{RustToolDispatcher, ToolValueResult};
use serde_json::{Value, json};

pub use epoch_contract::{CLI_COMMAND_PATHS, PublicSurfaceContract, ToolMetadata, tool_registry};

pub fn cli_command_paths() -> &'static [&'static str] {
    CLI_COMMAND_PATHS
}

pub fn cli_tool_commands() -> Vec<(&'static str, &'static str)> {
    tool_registry()
        .iter()
        .map(|tool| (tool.cli_command, tool.name))
        .collect()
}

pub fn command_to_tool(command_path: &str) -> Option<&'static str> {
    let normalized = command_path.trim();
    tool_registry()
        .iter()
        .find(|tool| tool.cli_command == normalized)
        .map(|tool| tool.name)
}

pub fn run_cli_command(
    dispatcher: &mut RustToolDispatcher,
    command_path: &str,
    input: Value,
) -> ToolValueResult {
    match command_path.trim() {
        "list-tools" => Ok(list_tools_value()),
        command => {
            let Some(tool_name) = command_to_tool(command) else {
                return Err(cli_unsupported_error(command));
            };
            dispatcher.dispatch(tool_name, input)
        }
    }
}

pub fn run_cli_json(
    dispatcher: &mut RustToolDispatcher,
    command_path: &str,
    raw_input: &str,
) -> ToolValueResult {
    let input = if raw_input.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(raw_input).map_err(|error| {
            ToolError::new(
                format!("Invalid JSON input: {error}."),
                "Pass command input as a JSON object.",
            )
        })?
    };
    run_cli_command(dispatcher, command_path, input)
}

pub fn list_tools_value() -> Value {
    json!({
        "count": tool_registry().len(),
        "tools": tool_registry()
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "cliCommand": tool.cli_command,
                "category": tool.category,
                "readOnly": tool.annotations.read_only_hint,
            }))
            .collect::<Vec<_>>(),
    })
}

pub fn crate_label() -> &'static str {
    "epoch-cli"
}

fn cli_unsupported_error(command_path: &str) -> ToolError {
    ToolError::new(
        format!("Unsupported Rust CLI command: \"{command_path}\"."),
        "Use list-tools or one of the 24 tool command paths.",
    )
}

#[cfg(test)]
mod tests {
    use super::{
        cli_command_paths, cli_tool_commands, command_to_tool, crate_label, run_cli_command,
        run_cli_json,
    };
    use epoch_mcp::RustToolDispatcher;
    use serde_json::json;

    #[test]
    fn reports_crate_label() {
        assert_eq!(crate_label(), "epoch-cli");
    }

    #[test]
    fn exposes_full_cli_public_surface() {
        let paths = cli_command_paths();
        assert_eq!(paths.len(), 39);
        assert!(paths.contains(&"list-tools"));
        assert!(paths.contains(&"telemetry submit"));
    }

    #[test]
    fn maps_tool_names_to_cli_commands() {
        let commands = cli_tool_commands();
        assert_eq!(commands.len(), 24);
        assert!(commands.contains(&("pert-estimate", "pert_estimate")));
        assert!(commands.contains(&("feedback-health", "feedback_health")));
    }

    #[test]
    fn maps_public_command_paths_to_tools() {
        assert_eq!(command_to_tool("pert-estimate"), Some("pert_estimate"));
        assert_eq!(
            command_to_tool(" feedback-health "),
            Some("feedback_health")
        );
        assert_eq!(command_to_tool("telemetry"), None);
    }

    #[test]
    fn runs_tool_commands_through_dispatcher() {
        let mut dispatcher = RustToolDispatcher::new();
        let result = run_cli_command(
            &mut dispatcher,
            "pert-estimate",
            json!({ "optimistic": 1, "most_likely": 2, "pessimistic": 4 }),
        )
        .expect("CLI command dispatches");

        assert_eq!(result["expected"], 2.17);
        assert_eq!(result["feedbackRef"], "rust-estimate-1");
    }

    #[test]
    fn parses_json_input_and_lists_tools() {
        let mut dispatcher = RustToolDispatcher::new();
        let result = run_cli_json(
            &mut dispatcher,
            "parse-duration",
            r#"{ "duration_string": "1h30m" }"#,
        )
        .expect("JSON CLI command dispatches");
        assert_eq!(result["totalSeconds"], 5400.0);

        let tools = run_cli_command(&mut dispatcher, "list-tools", json!({}))
            .expect("list-tools dispatches");
        assert_eq!(tools["count"], 24);
    }

    #[test]
    fn reports_unsupported_meta_commands() {
        let mut dispatcher = RustToolDispatcher::new();
        let error = run_cli_command(&mut dispatcher, "telemetry status", json!({}))
            .expect_err("not a tool");

        assert!(error.message.contains("Unsupported Rust CLI command"));
    }
}
