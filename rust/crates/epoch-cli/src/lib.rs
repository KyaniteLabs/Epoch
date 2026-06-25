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

pub fn crate_label() -> &'static str {
    "epoch-cli"
}

#[cfg(test)]
mod tests {
    use super::{cli_command_paths, cli_tool_commands, crate_label};

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
}
