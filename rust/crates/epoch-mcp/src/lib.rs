pub mod dispatcher;
pub mod protocol;

pub use dispatcher::{RustToolDispatcher, ToolValueResult, dispatch_stateless};
pub use epoch_contract::{
    PublicSurfaceContract, ToolAnnotations, ToolMetadata, find_tool, tool_names, tool_registry,
    write_tool_names,
};
pub use protocol::{McpRuntime, process_json_rpc, process_message_stream};

pub fn mcp_tool_definitions() -> &'static [ToolMetadata] {
    tool_registry()
}

pub fn mcp_annotations(tool_name: &str) -> Option<ToolAnnotations> {
    find_tool(tool_name).map(|tool| tool.annotations)
}

pub fn crate_label() -> &'static str {
    "epoch-mcp"
}

#[cfg(test)]
mod tests {
    use super::{crate_label, mcp_annotations, mcp_tool_definitions};
    use epoch_contract::{READ_ONLY_ANNOTATIONS, WRITE_ANNOTATIONS};

    #[test]
    fn reports_crate_label() {
        assert_eq!(crate_label(), "epoch-mcp");
    }

    #[test]
    fn exposes_canonical_tool_definitions() {
        let tools = mcp_tool_definitions();
        assert_eq!(tools.len(), 24);
        assert_eq!(tools[0].name, "get_current_time");
        assert_eq!(tools[23].name, "feedback_health");
    }

    #[test]
    fn exposes_mcp_annotations_from_write_policy() {
        assert_eq!(mcp_annotations("record_actual"), Some(WRITE_ANNOTATIONS));
        assert_eq!(
            mcp_annotations("pert_estimate"),
            Some(READ_ONLY_ANNOTATIONS)
        );
        assert_eq!(mcp_annotations("unknown"), None);
    }
}
