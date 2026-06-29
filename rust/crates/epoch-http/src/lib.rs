use epoch_contract::ToolError;
use epoch_mcp::RustToolDispatcher;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::{File, OpenOptions, create_dir_all};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

type HmacSha256 = Hmac<Sha256>;

const TELEMETRY_RECEIPTS_FILE: &str = "telemetry-receipts.jsonl";
const TELEMETRY_RECORDS_FILE: &str = "telemetry-records.jsonl";
const TELEMETRY_RECORD_KEYS_FILE: &str = "telemetry-record-keys.jsonl";
const TELEMETRY_RECORD_FIELD_ORDER: &[&str] = &[
    "task_type",
    "complexity",
    "tool",
    "estimated_hours",
    "actual_hours",
    "ratio",
    "date",
    "completed_at",
];

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

#[derive(Debug, Clone)]
pub struct RustHttpRouter {
    dispatcher: RustToolDispatcher,
    telemetry: TelemetryReceiver,
}

impl Default for RustHttpRouter {
    fn default() -> Self {
        Self {
            dispatcher: RustToolDispatcher::default(),
            telemetry: TelemetryReceiver::from_epoch_data_dir(),
        }
    }
}

impl RustHttpRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_dispatcher(dispatcher: RustToolDispatcher) -> Self {
        Self {
            dispatcher,
            telemetry: TelemetryReceiver::from_epoch_data_dir(),
        }
    }

    pub fn with_dispatcher_and_data_dir(
        dispatcher: RustToolDispatcher,
        data_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            dispatcher,
            telemetry: TelemetryReceiver::with_data_dir(data_dir),
        }
    }

    pub fn dispatcher(&self) -> &RustToolDispatcher {
        &self.dispatcher
    }

    pub fn telemetry_data_dir(&self) -> &std::path::Path {
        &self.telemetry.data_dir
    }

    pub fn route(&mut self, method: HttpMethod, path: &str, body: Value) -> RustHttpResponse {
        self.route_with_headers(method, path, body, None, &BTreeMap::new())
    }

    pub fn route_with_headers(
        &mut self,
        method: HttpMethod,
        path: &str,
        body: Value,
        raw_body: Option<&str>,
        headers: &BTreeMap<String, String>,
    ) -> RustHttpResponse {
        match (method, path) {
            (HttpMethod::Get, "/health") => ok(json!({
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION"),
                "tools": tool_registry().len(),
                "uptime": 0.0,
            })),
            (HttpMethod::Get, "/v1/tools") => ok(tools_body()),
            (HttpMethod::Post, "/v1/telemetry") => self.record_telemetry(body, raw_body, headers),
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
            Ok(data) => tool_ok(data),
            Err(error) if error.message.contains("Unknown tool") => error_response(404, error),
            Err(error) => error_response(422, error),
        }
    }

    fn record_telemetry(
        &mut self,
        body: Value,
        raw_body: Option<&str>,
        headers: &BTreeMap<String, String>,
    ) -> RustHttpResponse {
        let owned_raw;
        let raw_body = match raw_body {
            Some(raw_body) => raw_body,
            None => {
                owned_raw = body.to_string();
                owned_raw.as_str()
            }
        };
        self.telemetry.receive(
            raw_body,
            headers.get("x-epoch-signature").map(String::as_str),
        )
    }
}

#[derive(Debug, Clone)]
struct TelemetryReceiver {
    data_dir: PathBuf,
}

impl TelemetryReceiver {
    fn from_epoch_data_dir() -> Self {
        Self {
            data_dir: epoch_data_dir(),
        }
    }

    fn with_data_dir(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    fn receive(&self, raw_body: &str, signature: Option<&str>) -> RustHttpResponse {
        match self.receive_inner(raw_body, signature) {
            Ok((accepted, deduplicated)) => RustHttpResponse {
                status: 200,
                body: json!({
                    "ok": true,
                    "status": 200,
                    "accepted": accepted,
                    "deduplicated": deduplicated,
                }),
            },
            Err(error) => RustHttpResponse {
                status: error.status,
                body: json!({
                    "ok": false,
                    "status": error.status,
                    "accepted": 0,
                    "deduplicated": 0,
                    "error": error.message,
                }),
            },
        }
    }

    fn receive_inner(
        &self,
        raw_body: &str,
        signature: Option<&str>,
    ) -> Result<(usize, usize), TelemetryReceiveError> {
        let payload: Value = serde_json::from_str(raw_body)
            .map_err(|_| TelemetryReceiveError::bad_request("invalid JSON body"))?;
        let object = payload
            .as_object()
            .ok_or_else(|| TelemetryReceiveError::bad_request("unsupported schema_version"))?;

        if !is_schema_version_one(object.get("schema_version")) {
            return Err(TelemetryReceiveError::bad_request(
                "unsupported schema_version",
            ));
        }
        let installation_id =
            required_string(object, "installation_id", "missing installation_id")?;
        let epoch_version = required_string(object, "epoch_version", "missing epoch_version")?;
        let records = object
            .get("records")
            .and_then(Value::as_array)
            .ok_or_else(|| TelemetryReceiveError::bad_request("records must be an array"))?;

        if !records.iter().all(is_anonymized_record) {
            return Err(TelemetryReceiveError::bad_request(
                "records contain invalid anonymized telemetry fields",
            ));
        }
        if records.len() > 100 {
            return Err(TelemetryReceiveError::bad_request("too many records"));
        }
        let signature = signature
            .filter(|value| !value.is_empty())
            .ok_or_else(|| TelemetryReceiveError::unauthorized("missing signature"))?;
        if !verify_signature(raw_body, installation_id, signature) {
            return Err(TelemetryReceiveError::unauthorized("invalid signature"));
        }

        create_dir_all(&self.data_dir).map_err(TelemetryReceiveError::storage)?;
        let mut known_keys = self.load_record_keys()?;
        let received_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut accepted = 0;
        let mut deduplicated = 0;

        for record in records {
            let key = record_key(installation_id, record);
            if known_keys.contains(&key) {
                deduplicated += 1;
                continue;
            }

            known_keys.insert(key.clone());
            self.append_line(TELEMETRY_RECORD_KEYS_FILE, &key)?;
            self.append_json_line(
                TELEMETRY_RECORDS_FILE,
                &record_with_received_at(record, &received_at),
            )?;
            accepted += 1;
        }

        self.append_json_line(
            TELEMETRY_RECEIPTS_FILE,
            &json!({
                "receivedAt": received_at,
                "installationId": installation_id,
                "schemaVersion": 1,
                "epochVersion": epoch_version,
                "accepted": accepted,
                "deduplicated": deduplicated,
            }),
        )?;

        Ok((accepted, deduplicated))
    }

    fn load_record_keys(&self) -> Result<BTreeSet<String>, TelemetryReceiveError> {
        let path = self.data_dir.join(TELEMETRY_RECORD_KEYS_FILE);
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeSet::new());
            }
            Err(error) => return Err(TelemetryReceiveError::storage(error)),
        };

        let mut keys = BTreeSet::new();
        for line in BufReader::new(file).lines() {
            let line = line.map_err(TelemetryReceiveError::storage)?;
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                keys.insert(trimmed.to_string());
            }
        }
        Ok(keys)
    }

    fn append_line(&self, filename: &str, line: &str) -> Result<(), TelemetryReceiveError> {
        create_dir_all(&self.data_dir).map_err(TelemetryReceiveError::storage)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.data_dir.join(filename))
            .map_err(TelemetryReceiveError::storage)?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(TelemetryReceiveError::storage)
    }

    fn append_json_line<T: Serialize>(
        &self,
        filename: &str,
        value: &T,
    ) -> Result<(), TelemetryReceiveError> {
        create_dir_all(&self.data_dir).map_err(TelemetryReceiveError::storage)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.data_dir.join(filename))
            .map_err(TelemetryReceiveError::storage)?;
        serde_json::to_writer(&mut file, value)
            .map_err(|error| TelemetryReceiveError::storage(std::io::Error::other(error)))?;
        file.write_all(b"\n")
            .map_err(TelemetryReceiveError::storage)
    }
}

#[derive(Debug, Clone)]
struct TelemetryReceiveError {
    status: u16,
    message: String,
}

impl TelemetryReceiveError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: 401,
            message: message.into(),
        }
    }

    fn storage(error: std::io::Error) -> Self {
        Self {
            status: 400,
            message: format!("telemetry storage error: {error}"),
        }
    }
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    message: &'static str,
) -> Result<&'a str, TelemetryReceiveError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| TelemetryReceiveError::bad_request(message))
}

fn is_schema_version_one(value: Option<&Value>) -> bool {
    let Some(Value::Number(number)) = value else {
        return false;
    };
    number.as_i64() == Some(1)
        || number.as_u64() == Some(1)
        || number.as_f64().is_some_and(|value| value == 1.0)
}

fn is_anonymized_record(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    let complexity_ok = matches!(record.get("complexity"), Some(Value::Null))
        || record
            .get("complexity")
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite);
    record.get("task_type").and_then(Value::as_str).is_some()
        && complexity_ok
        && record.get("tool").and_then(Value::as_str).is_some()
        && finite_number(record, "estimated_hours")
        && finite_number(record, "actual_hours")
        && finite_number(record, "ratio")
        && record
            .get("date")
            .and_then(Value::as_str)
            .is_some_and(is_iso_date)
}

fn finite_number(record: &Map<String, Value>, field: &str) -> bool {
    record
        .get(field)
        .and_then(Value::as_f64)
        .is_some_and(f64::is_finite)
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn verify_signature(raw_body: &str, installation_id: &str, signature: &str) -> bool {
    let Some(signature_bytes) = decode_hex_32(signature) else {
        return false;
    };
    let mut mac =
        HmacSha256::new_from_slice(installation_id.as_bytes()).expect("HMAC accepts any key size");
    mac.update(raw_body.as_bytes());
    mac.verify_slice(&signature_bytes).is_ok()
}

fn decode_hex_32(value: &str) -> Option<[u8; 32]> {
    let bytes = value.as_bytes();
    if bytes.len() != 64 {
        return None;
    }

    let mut decoded = [0_u8; 32];
    for index in 0..32 {
        let high = hex_nibble(bytes[index * 2])?;
        let low = hex_nibble(bytes[index * 2 + 1])?;
        decoded[index] = (high << 4) | low;
    }
    Some(decoded)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn record_key(installation_id: &str, record: &Value) -> String {
    let payload = format!(
        "{{\"installationId\":{},\"record\":{}}}",
        serde_json::to_string(installation_id).expect("string serialization cannot fail"),
        record_json_for_typescript_submitter(record)
    );
    sha256_hex(payload.as_bytes())
}

fn record_json_for_typescript_submitter(record: &Value) -> String {
    let Some(object) = record.as_object() else {
        return record.to_string();
    };
    let mut parts = Vec::new();
    for field in TELEMETRY_RECORD_FIELD_ORDER {
        if let Some(value) = object.get(*field) {
            parts.push(json_field(field, value));
        }
    }
    for (field, value) in object {
        if !TELEMETRY_RECORD_FIELD_ORDER.contains(&field.as_str()) {
            parts.push(json_field(field, value));
        }
    }
    format!("{{{}}}", parts.join(","))
}

fn json_field(field: &str, value: &Value) -> String {
    format!(
        "{}:{}",
        serde_json::to_string(field).expect("string serialization cannot fail"),
        value
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

fn record_with_received_at(record: &Value, received_at: &str) -> Value {
    let Some(object) = record.as_object() else {
        return record.clone();
    };
    let mut enriched = object.clone();
    enriched.insert(
        "received_at".to_string(),
        Value::String(received_at.to_string()),
    );
    Value::Object(enriched)
}

fn epoch_data_dir() -> PathBuf {
    env::var_os("EPOCH_DATA_DIR")
        .and_then(non_empty_os_path)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".epoch")))
        .unwrap_or_else(|| PathBuf::from(".epoch"))
}

fn non_empty_os_path(value: std::ffi::OsString) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty() {
        None
    } else {
        Some(path)
    }
}

pub fn crate_label() -> &'static str {
    "epoch-http"
}

fn ok(body: Value) -> RustHttpResponse {
    RustHttpResponse { status: 200, body }
}

fn tool_ok(data: Value) -> RustHttpResponse {
    RustHttpResponse {
        status: 200,
        body: json!({ "ok": true, "data": data }),
    }
}

fn error_response(status: u16, error: ToolError) -> RustHttpResponse {
    RustHttpResponse {
        status,
        body: json!({ "ok": false, "error": error }),
    }
}

fn tools_body() -> Value {
    json!({
        "ok": true,
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
    let mut paths = serde_json::Map::new();
    for tool in tool_registry() {
        paths.insert(
            format!("/v1/tools/{}", tool.name),
            json!({
                "post": {
                    "operationId": tool.name,
                    "summary": tool.description,
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": { "type": "object" }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Tool result",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "oneOf": [
                                            {
                                                "type": "object",
                                                "properties": {
                                                    "ok": { "type": "boolean", "enum": [true] },
                                                    "data": { "type": "object" }
                                                }
                                            },
                                            {
                                                "type": "object",
                                                "properties": {
                                                    "ok": { "type": "boolean", "enum": [false] },
                                                    "error": {
                                                        "type": "object",
                                                        "properties": {
                                                            "isError": { "type": "boolean" },
                                                            "message": { "type": "string" },
                                                            "retryHint": { "type": "string" }
                                                        }
                                                    }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            }),
        );
    }
    for route in HTTP_ROUTES {
        let mut parts = route.splitn(2, ' ');
        let method = parts.next().unwrap_or("GET").to_lowercase();
        let path = parts.next().unwrap_or("/");
        if path == "/v1/tools/:toolName" {
            continue;
        }
        paths.entry(path.to_string()).or_insert_with(|| {
            json!({
                method: {
                    "responses": {
                        "200": { "description": "OK" }
                    }
                }
            })
        });
    }

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Epoch Rust Adapter",
            "version": "0.1.0",
        },
        "paths": paths,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        HmacSha256, HttpMethod, RustHttpRouter, TELEMETRY_RECEIPTS_FILE,
        TELEMETRY_RECORD_KEYS_FILE, TELEMETRY_RECORDS_FILE, crate_label, direct_feedback_routes,
        hex_lower, http_routes,
    };
    use hmac::Mac;
    use serde_json::{Value, json};
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;

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
        assert_eq!(health.body["status"], "ok");
        assert_eq!(health.body["tools"], 24);
        assert!(health.body["version"].as_str().is_some());
        assert!(health.body["uptime"].as_f64().is_some());

        let tools = router.route(HttpMethod::Get, "/v1/tools", json!({}));
        assert_eq!(tools.status, 200);
        assert_eq!(tools.body["ok"], true);
        assert_eq!(
            tools.body["tools"].as_array().expect("tools array").len(),
            24
        );

        let openapi = router.route(HttpMethod::Get, "/openapi.json", json!({}));
        assert_eq!(openapi.status, 200);
        assert_eq!(openapi.body["openapi"], "3.1.0");
        let paths = openapi.body["paths"].as_object().expect("paths object");
        let tool_path_count = paths
            .keys()
            .filter(|path| path.starts_with("/v1/tools/"))
            .count();
        assert_eq!(tool_path_count, 24);
        assert!(paths.contains_key("/v1/tools/pert_estimate"));
        assert!(!paths.contains_key("/v1/tools/:toolName"));
    }

    #[test]
    fn accepts_signed_telemetry_payloads_and_persists_jsonl() {
        let data_dir = temp_data_dir("accepts");
        let mut router =
            RustHttpRouter::with_dispatcher_and_data_dir(Default::default(), data_dir.clone());
        let payload = telemetry_payload();
        let raw_body = payload.to_string();
        let headers = signed_headers(&raw_body, "http-test-installation");

        let response = router.route_with_headers(
            HttpMethod::Post,
            "/v1/telemetry",
            payload,
            Some(&raw_body),
            &headers,
        );

        assert_eq!(response.status, 200);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["accepted"], 1);
        assert_eq!(response.body["deduplicated"], 0);
        assert_eq!(router.telemetry_data_dir(), data_dir.as_path());

        let records = read_jsonl(data_dir.join(TELEMETRY_RECORDS_FILE));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["task_type"], "feature");
        assert_eq!(records[0]["received_at"].as_str().unwrap().len(), 24);

        let receipts = read_jsonl(data_dir.join(TELEMETRY_RECEIPTS_FILE));
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0]["installationId"], "http-test-installation");
        assert_eq!(receipts[0]["accepted"], 1);

        let keys = fs::read_to_string(data_dir.join(TELEMETRY_RECORD_KEYS_FILE))
            .expect("record keys are written");
        assert_eq!(keys.lines().count(), 1);
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn deduplicates_repeated_telemetry_records() {
        let data_dir = temp_data_dir("dedupe");
        let mut router =
            RustHttpRouter::with_dispatcher_and_data_dir(Default::default(), data_dir.clone());
        let payload = telemetry_payload();
        let raw_body = payload.to_string();
        let headers = signed_headers(&raw_body, "http-test-installation");

        let first = router.route_with_headers(
            HttpMethod::Post,
            "/v1/telemetry",
            payload.clone(),
            Some(&raw_body),
            &headers,
        );
        let second = router.route_with_headers(
            HttpMethod::Post,
            "/v1/telemetry",
            payload,
            Some(&raw_body),
            &headers,
        );

        assert_eq!(first.status, 200);
        assert_eq!(first.body["accepted"], 1);
        assert_eq!(second.status, 200);
        assert_eq!(second.body["accepted"], 0);
        assert_eq!(second.body["deduplicated"], 1);

        assert_eq!(
            fs::read_to_string(data_dir.join(TELEMETRY_RECORD_KEYS_FILE))
                .expect("record keys")
                .lines()
                .count(),
            1
        );
        assert_eq!(read_jsonl(data_dir.join(TELEMETRY_RECEIPTS_FILE)).len(), 2);
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn accepts_schema_version_number_like_typescript() {
        let data_dir = temp_data_dir("schema-version-number");
        let mut router =
            RustHttpRouter::with_dispatcher_and_data_dir(Default::default(), data_dir.clone());
        let mut payload = telemetry_payload();
        payload["schema_version"] = json!(1.0);
        let raw_body = payload.to_string();
        let headers = signed_headers(&raw_body, "http-test-installation");

        let response = router.route_with_headers(
            HttpMethod::Post,
            "/v1/telemetry",
            payload,
            Some(&raw_body),
            &headers,
        );

        assert_eq!(response.status, 200);
        assert_eq!(response.body["accepted"], 1);
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn rejects_telemetry_with_invalid_signatures() {
        let data_dir = temp_data_dir("invalid-signature");
        let mut router =
            RustHttpRouter::with_dispatcher_and_data_dir(Default::default(), data_dir.clone());
        let payload = telemetry_payload();
        let raw_body = payload.to_string();
        let mut headers = BTreeMap::new();
        headers.insert("x-epoch-signature".to_string(), "0".repeat(64));

        let response = router.route_with_headers(
            HttpMethod::Post,
            "/v1/telemetry",
            payload,
            Some(&raw_body),
            &headers,
        );

        assert_eq!(response.status, 401);
        assert_eq!(response.body["ok"], false);
        assert_eq!(response.body["error"], "invalid signature");
        assert!(!data_dir.join(TELEMETRY_RECEIPTS_FILE).exists());
        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn record_keys_match_typescript_receiver_for_submitter_order() {
        let payload = telemetry_payload();
        let record = &payload["records"]
            .as_array()
            .expect("records array")
            .first()
            .expect("record");

        assert_eq!(
            super::record_key("http-test-installation", record),
            "a79a2e57716118c495dee93674f81ae2b0002f60609608baddd51dba71643686"
        );
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
        assert_eq!(estimate.body["ok"], true);
        assert_eq!(estimate.body["data"]["feedbackRef"], "rust-estimate-1");

        let pending = router.route(HttpMethod::Get, "/v1/feedback/pending", json!({}));
        assert_eq!(pending.status, 200);
        assert_eq!(pending.body["ok"], true);
        assert_eq!(pending.body["data"]["count"], 1);

        let actual = router.route(
            HttpMethod::Post,
            "/v1/feedback/record-actual",
            json!({ "estimate_id": "rust-estimate-1", "actual_hours": 2.5 }),
        );
        assert_eq!(actual.status, 200);
        assert_eq!(actual.body["ok"], true);
        assert_eq!(actual.body["data"]["recorded"], true);

        let health = router.route(HttpMethod::Get, "/v1/feedback/health", json!({}));
        assert_eq!(health.body["ok"], true);
        assert_eq!(health.body["data"]["totalActuals"], 1);
    }

    #[test]
    fn reports_route_and_tool_errors_with_status_codes() {
        let mut router = RustHttpRouter::new();

        let missing = router.route(HttpMethod::Get, "/missing", json!({}));
        assert_eq!(missing.status, 404);
        assert_eq!(missing.body["ok"], false);

        let unknown_tool = router.route(HttpMethod::Post, "/v1/tools/nope", json!({}));
        assert_eq!(unknown_tool.status, 404);
        assert_eq!(unknown_tool.body["ok"], false);

        let invalid_input = router.route(
            HttpMethod::Post,
            "/v1/tools/pert_estimate",
            json!({ "optimistic": 10, "most_likely": 2, "pessimistic": 4 }),
        );
        assert_eq!(invalid_input.status, 422);
        assert_eq!(invalid_input.body["ok"], false);
    }

    fn telemetry_payload() -> Value {
        json!({
            "schema_version": 1,
            "installation_id": "http-test-installation",
            "epoch_version": "0.2.2-test",
            "records": [{
                "task_type": "feature",
                "complexity": 3,
                "tool": "test",
                "estimated_hours": 4,
                "actual_hours": 5,
                "ratio": 1.25,
                "date": "2026-05-07",
                "completed_at": "2026-05-07T00:00:00.000Z"
            }],
            "generated_at": "2026-05-07T00:00:00.000Z",
        })
    }

    fn signed_headers(raw_body: &str, installation_id: &str) -> BTreeMap<String, String> {
        let mut mac =
            HmacSha256::new_from_slice(installation_id.as_bytes()).expect("HMAC key is valid");
        mac.update(raw_body.as_bytes());
        let signature = mac.finalize().into_bytes();
        let mut headers = BTreeMap::new();
        headers.insert("x-epoch-signature".to_string(), hex_lower(&signature));
        headers
    }

    fn temp_data_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "epoch-http-telemetry-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_else(|| chrono::Utc::now().timestamp_micros())
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp data dir");
        dir
    }

    fn read_jsonl(path: PathBuf) -> Vec<Value> {
        fs::read_to_string(path)
            .expect("jsonl file")
            .lines()
            .map(|line| serde_json::from_str(line).expect("jsonl record"))
            .collect()
    }
}
