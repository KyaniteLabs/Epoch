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
    let command = command_path.trim();
    match command {
        "list-tools" => Ok(list_tools_value()),
        "self-improve" => self_improve_value(dispatcher),
        command => {
            if let Some(tool_name) = command_to_tool(command) {
                dispatcher.dispatch(tool_name, input)
            } else {
                meta_command_value(command, input)
            }
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

fn meta_command_value(command_path: &str, input: Value) -> ToolValueResult {
    match command_path {
        "telemetry" => Ok(json!({
            "localRuntime": true,
            "mode": "local-rust-runtime",
            "commands": [
                "telemetry status",
                "telemetry preview",
                "telemetry export",
                "telemetry enable",
                "telemetry set-endpoint",
                "telemetry submit",
                "telemetry disable",
                "telemetry delete-data",
            ],
        })),
        "telemetry status" => Ok(json!({
            "enabled": false,
            "endpoint": Value::Null,
            "queuedEvents": 0,
            "mode": "local-rust-runtime",
        })),
        "telemetry preview" => Ok(json!({
            "preview": input,
            "wouldSubmit": false,
            "mode": "local-rust-runtime",
        })),
        "telemetry export" => Ok(json!({
            "events": [],
            "count": 0,
            "mode": "local-rust-runtime",
        })),
        "telemetry enable" => Ok(json!({
            "enabled": true,
            "persisted": false,
            "message": "Telemetry enabled for this Rust command response only; persistent config is owned by the TypeScript runtime.",
        })),
        "telemetry set-endpoint" => Ok(json!({
            "endpoint": input.get("endpoint").cloned().unwrap_or(Value::Null),
            "persisted": false,
            "mode": "local-rust-runtime",
        })),
        "telemetry submit" => Ok(json!({
            "accepted": true,
            "submitted": false,
            "payload": input,
            "mode": "local-rust-runtime",
        })),
        "telemetry disable" => Ok(json!({
            "enabled": false,
            "persisted": false,
            "mode": "local-rust-runtime",
        })),
        "telemetry delete-data" => Ok(json!({
            "deletedEvents": 0,
            "mode": "local-rust-runtime",
        })),
        "share-data" => Ok(json!({
            "ready": true,
            "publicSafe": true,
            "payload": input,
            "message": "Share-data payload prepared locally; publication remains an explicit caller action.",
        })),
        "data" | "data status" => data_status_value(),
        "data where" => Ok(json!({
            "bundled": true,
            "files": [
                "data/cocomo-calibration-data.json",
                "data/supplementary-database.json",
                "src/data/reference-database.json",
            ],
        })),
        _ => Err(cli_unknown_error(command_path)),
    }
}

fn self_improve_value(dispatcher: &mut RustToolDispatcher) -> ToolValueResult {
    let feedback_health = dispatcher.dispatch("feedback_health", json!({}))?;
    Ok(json!({
        "ready": true,
        "mode": "local-rust-runtime",
        "feedbackHealth": feedback_health,
    }))
}

fn data_status_value() -> ToolValueResult {
    let calibration = epoch_data::bundled_cocomo_calibration().map_err(data_error)?;
    let supplementary = epoch_data::bundled_supplementary_database().map_err(data_error)?;
    let reference = epoch_data::bundled_reference_database().map_err(data_error)?;
    let project_count = calibration
        .datasets
        .iter()
        .map(|dataset| dataset.projects.len())
        .sum::<usize>();
    let declared_project_count = calibration.project_count;
    let dataset_names = calibration
        .datasets
        .iter()
        .map(|dataset| dataset.name.as_str())
        .collect::<Vec<_>>();

    Ok(json!({
        "bundled": true,
        "mode": "local-rust-runtime",
        "cocomo": {
            "datasetNames": dataset_names,
            "projectCount": project_count,
            "declaredProjectCount": declared_project_count,
            "basicCoefficientModes": calibration.derived_factors.cocomo_basic.keys().collect::<Vec<_>>(),
        },
        "supplementary": {
            "loaded": true,
            "hasModelCalibration": supplementary.get("modelCalibration").is_some(),
            "hasReferenceClassBaselines": supplementary.get("referenceClassBaselines").is_some(),
        },
        "reference": {
            "loaded": true,
            "hasToolExecutionBenchmarks": reference.get("toolExecutionBenchmarks").is_some(),
            "hasTaskTypeCorrectionFactors": reference.get("taskTypeCorrectionFactors").is_some(),
        },
    }))
}

fn data_error(error: serde_json::Error) -> ToolError {
    ToolError::new(
        format!("Bundled Epoch data failed to parse: {error}."),
        "Run the Rust data crate tests and repair the bundled JSON data files.",
    )
}

fn cli_unknown_error(command_path: &str) -> ToolError {
    ToolError::new(
        format!("Unknown Rust CLI command: \"{command_path}\"."),
        "Use list-tools, one of the 24 tool command paths, or a documented data/telemetry command.",
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
    use std::collections::BTreeSet;

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
    fn runs_documented_meta_commands() {
        let mut dispatcher = RustToolDispatcher::new();

        let telemetry = run_cli_command(&mut dispatcher, "telemetry status", json!({}))
            .expect("telemetry status runs");
        assert_eq!(telemetry["mode"], "local-rust-runtime");
        assert_eq!(telemetry["queuedEvents"], 0);

        let data =
            run_cli_command(&mut dispatcher, "data status", json!({})).expect("data status runs");
        assert_eq!(data["cocomo"]["projectCount"], 195);
        assert_eq!(data["supplementary"]["hasModelCalibration"], true);

        let share = run_cli_command(&mut dispatcher, "share-data", json!({ "ok": true }))
            .expect("share-data runs");
        assert_eq!(share["publicSafe"], true);
        assert_eq!(share["payload"]["ok"], true);
    }

    #[test]
    fn every_public_meta_command_has_runtime_behavior() {
        let tool_commands = cli_tool_commands()
            .into_iter()
            .map(|(command, _)| command)
            .collect::<BTreeSet<_>>();
        let mut dispatcher = RustToolDispatcher::new();

        for command in cli_command_paths() {
            if tool_commands.contains(command) || *command == "list-tools" {
                continue;
            }

            run_cli_command(&mut dispatcher, command, json!({}))
                .unwrap_or_else(|error| panic!("{command} should run: {}", error.message));
        }
    }

    #[test]
    fn reports_unknown_commands() {
        let mut dispatcher = RustToolDispatcher::new();
        let error =
            run_cli_command(&mut dispatcher, "missing meta", json!({})).expect_err("not a command");

        assert!(error.message.contains("Unknown Rust CLI command"));
    }
}
