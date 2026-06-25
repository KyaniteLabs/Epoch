use crate::RustToolDispatcher;
use epoch_contract::{ToolError, tool_registry};
use serde_json::{Value, json};

#[derive(Debug, Clone, Default)]
pub struct McpRuntime {
    dispatcher: RustToolDispatcher,
}

impl McpRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_dispatcher(dispatcher: RustToolDispatcher) -> Self {
        Self { dispatcher }
    }

    pub fn handle_json_rpc(&mut self, request: Value) -> Option<Value> {
        let object = match request.as_object() {
            Some(object) => object,
            None => return Some(json_rpc_error(Value::Null, -32600, "Invalid request.")),
        };
        let id = object.get("id").cloned();
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return id.map(|id| json_rpc_error(id, -32600, "Missing method."));
        };

        let response = match method {
            "initialize" => Ok(initialize_result()),
            "tools/list" => Ok(tools_list_result()),
            "tools/call" => self.tools_call(object.get("params")),
            "ping" => Ok(json!({})),
            _ => Err(json_rpc_error(
                id.clone().unwrap_or(Value::Null),
                -32601,
                format!("Unknown MCP method: {method}."),
            )),
        };

        id.map(|id| match response {
            Ok(result) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            }),
            Err(error) => error,
        })
    }

    fn tools_call(&mut self, params: Option<&Value>) -> Result<Value, Value> {
        let params = params.and_then(Value::as_object).ok_or_else(|| {
            json_rpc_error(
                Value::Null,
                -32602,
                "tools/call params must be an object with name and arguments.",
            )
        })?;
        let name = params.get("name").and_then(Value::as_str).ok_or_else(|| {
            json_rpc_error(Value::Null, -32602, "tools/call params.name is required.")
        })?;
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));

        match self.dispatcher.dispatch(name, arguments) {
            Ok(data) => Ok(json!({
                "content": [{ "type": "text", "text": data.to_string() }],
                "structuredContent": data,
                "isError": false,
            })),
            Err(error) => Ok(tool_error_content(error)),
        }
    }
}

pub fn process_json_rpc(runtime: &mut McpRuntime, raw: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(value) => runtime.handle_json_rpc(value),
        Err(error) => Some(json_rpc_error(
            Value::Null,
            -32700,
            format!("Parse error: {error}."),
        )),
    }
}

pub fn process_message_stream(runtime: &mut McpRuntime, input: &str) -> String {
    let mut responses = Vec::new();
    if input.contains("Content-Length:") {
        let mut cursor = 0;
        while cursor < input.len() {
            let Some((header_end, separator_len)) = find_header_end(&input[cursor..]) else {
                break;
            };
            let header = &input[cursor..cursor + header_end];
            let Some(content_length) = content_length(header) else {
                break;
            };
            let body_start = cursor + header_end + separator_len;
            let body_end = body_start + content_length;
            if body_end > input.len() {
                break;
            }
            if let Some(response) = process_json_rpc(runtime, &input[body_start..body_end]) {
                responses.push(frame_message(&response.to_string()));
            }
            cursor = body_end;
        }
    } else {
        for line in input.lines().map(str::trim).filter(|line| !line.is_empty()) {
            if let Some(response) = process_json_rpc(runtime, line) {
                responses.push(frame_message(&response.to_string()));
            }
        }
    }
    responses.join("")
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "serverInfo": {
            "name": "@kyanitelabs/epoch-rust",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": {
            "tools": { "listChanged": false },
        },
    })
}

fn tools_list_result() -> Value {
    json!({
        "tools": tool_registry()
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": true,
                    "xEpochSchema": tool.input_schema,
                },
                "annotations": tool.annotations,
            }))
            .collect::<Vec<_>>(),
    })
}

fn tool_error_content(error: ToolError) -> Value {
    let body = json!({ "error": error });
    json!({
        "content": [{ "type": "text", "text": body.to_string() }],
        "structuredContent": body,
        "isError": true,
    })
}

fn json_rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into(),
        },
    })
}

fn find_header_end(input: &str) -> Option<(usize, usize)> {
    input
        .find("\r\n\r\n")
        .map(|index| (index, 4))
        .or_else(|| input.find("\n\n").map(|index| (index, 2)))
}

fn content_length(header: &str) -> Option<usize> {
    header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    })
}

fn frame_message(body: &str) -> String {
    format!("Content-Length: {}\r\n\r\n{}", body.len(), body)
}

#[cfg(test)]
fn params(name: &str, arguments: Value) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("name".to_string(), Value::String(name.to_string()));
    params.insert("arguments".to_string(), arguments);
    Value::Object(params)
}

#[cfg(test)]
mod tests {
    use super::{McpRuntime, frame_message, params, process_json_rpc, process_message_stream};
    use serde_json::json;

    #[test]
    fn handles_initialize_and_tools_list() {
        let mut runtime = McpRuntime::new();

        let initialized = process_json_rpc(
            &mut runtime,
            r#"{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }"#,
        )
        .expect("initialize responds");
        assert_eq!(
            initialized["result"]["serverInfo"]["name"],
            "@kyanitelabs/epoch-rust"
        );

        let tools = process_json_rpc(
            &mut runtime,
            r#"{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }"#,
        )
        .expect("tools list responds");
        assert_eq!(
            tools["result"]["tools"].as_array().expect("tools").len(),
            24
        );
    }

    #[test]
    fn calls_tools_and_returns_structured_content() {
        let mut runtime = McpRuntime::new();
        let request = json!({
            "jsonrpc": "2.0",
            "id": "call-1",
            "method": "tools/call",
            "params": params("pert_estimate", json!({
                "optimistic": 1,
                "most_likely": 2,
                "pessimistic": 4
            }))
        });

        let response = runtime
            .handle_json_rpc(request)
            .expect("tool call responds");

        assert_eq!(response["result"]["isError"], false);
        assert_eq!(response["result"]["structuredContent"]["expected"], 2.17);
        assert_eq!(
            response["result"]["structuredContent"]["feedbackRef"],
            "rust-estimate-1"
        );
    }

    #[test]
    fn supports_content_length_and_line_delimited_streams() {
        let mut runtime = McpRuntime::new();
        let raw = r#"{ "jsonrpc": "2.0", "id": 1, "method": "ping" }"#;
        let framed = frame_message(raw);
        let output = process_message_stream(&mut runtime, &framed);
        assert!(output.contains("Content-Length:"));
        assert!(output.contains("\"result\":{}"));

        let mut runtime = McpRuntime::new();
        let output = process_message_stream(&mut runtime, raw);
        assert!(output.contains("\"result\":{}"));
    }
}
