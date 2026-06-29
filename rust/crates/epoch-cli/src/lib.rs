use epoch_contract::ToolError;
use epoch_core::feedback::CalibrationFilters;
use epoch_mcp::{RustToolDispatcher, ToolValueResult};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Map;
use serde_json::{Value, json};
use sha2::Sha256;
use std::env;
use std::fs::{create_dir_all, read_to_string, rename, write};
use std::path::PathBuf;
use std::time::Duration;
use uuid::Uuid;

pub use epoch_contract::{CLI_COMMAND_PATHS, PublicSurfaceContract, ToolMetadata, tool_registry};

type HmacSha256 = Hmac<Sha256>;
const CONFIG_FILE: &str = "config.json";
const EXPORTS_DIR: &str = "exports";
const PLACEHOLDER_TELEMETRY_ENDPOINTS: &[&str] =
    &["https://example.com", "https://example.com/v1/telemetry"];
const ANONYMIZED_RECORD_FIELDS: &[&str] = &[
    "task_type",
    "complexity",
    "tool",
    "estimated_hours",
    "actual_hours",
    "ratio",
    "date",
    "completed_at",
];

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
    json!(
        tool_registry()
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
            }))
            .collect::<Vec<_>>()
    )
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
        "telemetry status" => telemetry_status_value(input),
        "telemetry preview" => telemetry_preview_value(input),
        "telemetry export" => telemetry_export_value(input),
        "telemetry enable" => telemetry_enable_value(input),
        "telemetry set-endpoint" => telemetry_set_endpoint_value(input),
        "telemetry submit" => telemetry_submit_value(input),
        "telemetry disable" => telemetry_disable_value(),
        "telemetry delete-data" => telemetry_delete_data_value(),
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct EpochConfig {
    #[serde(default)]
    telemetry: TelemetryConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    last_submission_at: Option<String>,
    #[serde(default)]
    last_submission_record_count: usize,
    #[serde(default)]
    last_submission_accepted_count: usize,
    #[serde(default)]
    last_submission_deduplicated_count: usize,
    #[serde(default)]
    total_records_accepted: usize,
    #[serde(default)]
    total_records_deduplicated: usize,
    #[serde(default)]
    installation_id: String,
}

fn telemetry_status_value(_input: Value) -> ToolValueResult {
    let config = load_config();
    let endpoint_configured = is_usable_telemetry_endpoint(&config.telemetry.endpoint);
    let queued_records =
        extract_anonymized_records_from_epoch_data(config.telemetry.last_submission_at.as_deref())?
            .len();
    let env_val = env::var("EPOCH_TELEMETRY").ok();
    let enabled = env_val
        .as_deref()
        .and_then(parse_env_bool)
        .unwrap_or(config.telemetry.enabled);

    Ok(json!({
        "enabled": enabled,
        "source": if env_val.is_some() { "env var" } else { "config file" },
        "endpoint": if endpoint_configured { Value::String(config.telemetry.endpoint.clone()) } else { Value::String("(not configured)".to_string()) },
        "endpointSource": if env::var("EPOCH_TELEMETRY_ENDPOINT").ok().filter(|value| !value.trim().is_empty()).is_some() { "env var" } else { "config file" },
        "endpointConfigured": endpoint_configured,
        "queuedRecords": queued_records,
        "lastSubmissionAt": config.telemetry.last_submission_at,
        "totalRecordsSubmitted": config.telemetry.last_submission_record_count,
        "lastSubmissionAcceptedCount": config.telemetry.last_submission_accepted_count,
        "lastSubmissionDeduplicatedCount": config.telemetry.last_submission_deduplicated_count,
        "totalRecordsAccepted": config.telemetry.total_records_accepted,
        "totalRecordsDeduplicated": config.telemetry.total_records_deduplicated,
        "installationId": if config.telemetry.installation_id.is_empty() {
            "(not generated yet)"
        } else {
            config.telemetry.installation_id.as_str()
        },
    }))
}

fn telemetry_preview_value(_input: Value) -> ToolValueResult {
    let records = extract_anonymized_records_from_epoch_data(None)?;
    Ok(json!({
        "totalRecords": records.len(),
        "fields": if records.is_empty() { Vec::<&str>::new() } else { ANONYMIZED_RECORD_FIELDS.to_vec() },
        "strippedFields": [
            "estimateId",
            "source",
            "notes",
            "teamId",
            "time-of-day",
        ],
        "sample": records.into_iter().take(5).collect::<Vec<_>>(),
    }))
}

fn telemetry_export_value(input: Value) -> ToolValueResult {
    let output = input.get("output").and_then(Value::as_str);
    let records = extract_anonymized_records_from_epoch_data(None)?;
    let path = export_telemetry_records(&records, output)?;
    Ok(json!({
        "ok": true,
        "path": path,
        "message": "Anonymized data exported.",
    }))
}

fn telemetry_enable_value(input: Value) -> ToolValueResult {
    let mut config = load_config();
    if let Some(endpoint) = input.get("endpoint").and_then(Value::as_str) {
        config.telemetry.endpoint = validate_telemetry_endpoint(endpoint)?;
    }
    config.telemetry.enabled = true;
    save_config(&config)?;
    Ok(json!({
        "ok": true,
        "endpoint": if config.telemetry.endpoint.is_empty() {
            "(not configured)"
        } else {
            config.telemetry.endpoint.as_str()
        },
        "message": "Telemetry enabled. Use 'epoch telemetry preview' to see what will be shared.",
    }))
}

fn telemetry_set_endpoint_value(input: Value) -> ToolValueResult {
    let endpoint = input
        .get("endpoint")
        .and_then(Value::as_str)
        .ok_or_else(|| telemetry_cli_error("--endpoint is required"))?;
    let endpoint = validate_telemetry_endpoint(endpoint)?;
    let mut config = load_config();
    config.telemetry.endpoint = endpoint.clone();
    save_config(&config)?;
    Ok(json!({ "ok": true, "endpoint": endpoint }))
}

fn telemetry_submit_value(input: Value) -> ToolValueResult {
    if let Some(endpoint) = input.get("endpoint").and_then(Value::as_str) {
        let endpoint = validate_telemetry_endpoint(endpoint)?;
        let mut config = load_config();
        config.telemetry.endpoint = endpoint;
        save_config(&config)?;
    }
    submit_telemetry(
        input.get("force").and_then(Value::as_bool).unwrap_or(false),
        optional_nonnegative_f64(&input, &["min_interval_hours", "minIntervalHours"])?,
    )
}

fn telemetry_disable_value() -> ToolValueResult {
    let mut config = load_config();
    config.telemetry.enabled = false;
    save_config(&config)?;
    Ok(json!({ "ok": true, "message": "Telemetry disabled." }))
}

fn telemetry_delete_data_value() -> ToolValueResult {
    let config = load_config();
    Ok(json!({
        "message": "To delete your telemetry data, delete local Epoch JSONL files and config.json.",
        "localData": [
            "~/.epoch/estimates.jsonl",
            "~/.epoch/feedback.jsonl",
            "~/.epoch/telemetry.jsonl",
        ],
        "config": "~/.epoch/config.json",
        "installationId": if config.telemetry.installation_id.is_empty() {
            "(not generated)"
        } else {
            config.telemetry.installation_id.as_str()
        },
        "mode": "local-rust-runtime",
    }))
}

fn load_config() -> EpochConfig {
    let mut config = read_persisted_config().unwrap_or_default();
    if let Ok(endpoint) = env::var("EPOCH_TELEMETRY_ENDPOINT") {
        let endpoint = endpoint.trim();
        if !endpoint.is_empty() {
            config.telemetry.endpoint = endpoint.to_string();
        }
    }
    config
}

fn read_persisted_config() -> Option<EpochConfig> {
    let raw = read_to_string(config_path()).ok()?;
    serde_json::from_str::<EpochConfig>(&raw).ok()
}

fn save_config(config: &EpochConfig) -> ToolValueResult {
    let mut persisted = config.clone();
    if let Ok(endpoint) = env::var("EPOCH_TELEMETRY_ENDPOINT") {
        let endpoint = endpoint.trim();
        if !endpoint.is_empty() && persisted.telemetry.endpoint == endpoint {
            persisted.telemetry.endpoint = read_persisted_config()
                .map(|config| config.telemetry.endpoint)
                .unwrap_or_default();
        }
    }

    let dir = epoch_data_dir();
    create_dir_all(&dir).map_err(config_io_error)?;
    let target = dir.join(CONFIG_FILE);
    let tmp = dir.join(format!("{CONFIG_FILE}.tmp"));
    let raw = serde_json::to_string_pretty(&persisted).map_err(|error| {
        ToolError::new(
            format!("Failed to serialize telemetry config: {error}."),
            "Inspect local Epoch telemetry config fields.",
        )
    })?;
    write(&tmp, raw).map_err(config_io_error)?;
    rename(tmp, target).map_err(config_io_error)?;
    Ok(json!({ "ok": true }))
}

fn get_installation_id(config: &mut EpochConfig) -> Result<String, ToolError> {
    if !config.telemetry.installation_id.is_empty() {
        return Ok(config.telemetry.installation_id.clone());
    }
    config.telemetry.installation_id = Uuid::new_v4().to_string();
    save_config(config)?;
    Ok(config.telemetry.installation_id.clone())
}

fn is_telemetry_enabled(config: &EpochConfig) -> bool {
    env::var("EPOCH_TELEMETRY")
        .ok()
        .as_deref()
        .and_then(parse_env_bool)
        .unwrap_or(config.telemetry.enabled)
}

fn parse_env_bool(value: &str) -> Option<bool> {
    match value {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

fn validate_telemetry_endpoint(endpoint: &str) -> Result<String, ToolError> {
    let trimmed = endpoint.trim();
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| telemetry_cli_error("--endpoint must be a valid URL"))?;
    let is_local_http = parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    let is_tailscale_http =
        parsed.scheme() == "http" && parsed.host_str().is_some_and(is_tailscale_private_ipv4);
    if parsed.scheme() != "https" && !is_local_http && !is_tailscale_http {
        return Err(telemetry_cli_error(
            "--endpoint must use https://, except for localhost or Tailscale private receivers",
        ));
    }
    Ok(trimmed.to_string())
}

fn is_tailscale_private_ipv4(hostname: &str) -> bool {
    let parts = hostname
        .split('.')
        .map(str::parse::<u8>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(parts) = parts else {
        return false;
    };
    parts.len() == 4 && parts[0] == 100 && (64..=127).contains(&parts[1])
}

fn is_placeholder_telemetry_endpoint(endpoint: &str) -> bool {
    let normalized = endpoint.trim().trim_end_matches('/');
    PLACEHOLDER_TELEMETRY_ENDPOINTS.contains(&normalized)
}

fn is_usable_telemetry_endpoint(endpoint: &str) -> bool {
    !endpoint.trim().is_empty() && !is_placeholder_telemetry_endpoint(endpoint)
}

fn extract_anonymized_records_from_epoch_data(
    since: Option<&str>,
) -> Result<Vec<Value>, ToolError> {
    let store = epoch_core::feedback::FeedbackStore::from_epoch_data_dir()
        .map_err(|error| telemetry_storage_error("read feedback data", error))?;
    Ok(anonymized_records_from_store(&store, since))
}

fn anonymized_records_from_store(
    store: &epoch_core::feedback::FeedbackStore,
    since: Option<&str>,
) -> Vec<Value> {
    let since = since.and_then(parse_timestamp_ms);
    store
        .calibration_data(CalibrationFilters::default())
        .into_iter()
        .filter(|record| {
            since
                .map(|since| parse_timestamp_ms(&record.completed_at).is_some_and(|ts| ts > since))
                .unwrap_or(true)
        })
        .filter(|record| record.estimated_hours.is_finite() && record.estimated_hours > 0.0)
        .filter(|record| record.actual_hours.is_finite())
        .map(|record| {
            let mut object = Map::new();
            object.insert(
                "task_type".to_string(),
                Value::String(record.task_type.as_str().to_string()),
            );
            object.insert(
                "complexity".to_string(),
                record.complexity.map(Value::from).unwrap_or(Value::Null),
            );
            object.insert(
                "tool".to_string(),
                Value::String(record.tool.unwrap_or_else(|| "unknown".to_string())),
            );
            object.insert(
                "estimated_hours".to_string(),
                Value::from(round_to(record.estimated_hours, 2)),
            );
            object.insert(
                "actual_hours".to_string(),
                Value::from(round_to(record.actual_hours, 2)),
            );
            object.insert(
                "ratio".to_string(),
                Value::from(round_to(record.actual_hours / record.estimated_hours, 4)),
            );
            object.insert(
                "date".to_string(),
                Value::String(record.completed_at.chars().take(10).collect()),
            );
            object.insert(
                "completed_at".to_string(),
                Value::String(normalize_timestamp(&record.completed_at)),
            );
            Value::Object(object)
        })
        .collect()
}

fn export_telemetry_records(records: &[Value], output: Option<&str>) -> Result<String, ToolError> {
    let path = output.map(PathBuf::from).unwrap_or_else(|| {
        epoch_data_dir()
            .join(EXPORTS_DIR)
            .join(default_export_filename())
    });
    if output.is_none()
        && let Some(parent) = path.parent()
    {
        create_dir_all(parent).map_err(config_io_error)?;
    }
    let raw = serde_json::to_string_pretty(records).map_err(|error| {
        ToolError::new(
            format!("Failed to serialize telemetry export: {error}."),
            "Inspect local feedback records before exporting.",
        )
    })?;
    write(&path, raw).map_err(config_io_error)?;
    Ok(path.to_string_lossy().into_owned())
}

fn submit_telemetry(force: bool, min_interval_hours: Option<f64>) -> ToolValueResult {
    let mut config = load_config();
    if !is_telemetry_enabled(&config) {
        return Ok(json!({ "ok": false, "recordCount": 0, "error": "telemetry not enabled" }));
    }
    if config.telemetry.endpoint.is_empty() {
        return Ok(json!({ "ok": false, "recordCount": 0, "error": "no endpoint configured" }));
    }
    if !is_usable_telemetry_endpoint(&config.telemetry.endpoint) {
        return Ok(
            json!({ "ok": false, "recordCount": 0, "error": "placeholder endpoint configured" }),
        );
    }
    if telemetry_submit_rate_limited(
        config.telemetry.last_submission_at.as_deref(),
        force,
        min_interval_hours,
    ) {
        return Ok(json!({
            "ok": false,
            "recordCount": 0,
            "error": format!("rate limited: less than {} hour(s) since last submission", telemetry_submit_interval_hours(min_interval_hours)),
        }));
    }

    let records =
        extract_anonymized_records_from_epoch_data(config.telemetry.last_submission_at.as_deref())?;
    if records.is_empty() {
        return Ok(json!({ "ok": false, "recordCount": 0, "error": "no new records to submit" }));
    }

    let installation_id = get_installation_id(&mut config)?;
    let version = package_version();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| telemetry_cli_error(format!("network client error: {error}")))?;
    let mut submitted = 0_usize;
    let mut accepted = 0_usize;
    let mut deduplicated = 0_usize;

    for chunk in records.chunks(100) {
        let chunk_cursor = chunk
            .last()
            .and_then(|record| record.get("completed_at"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let payload = json!({
            "schema_version": 1,
            "installation_id": installation_id,
            "epoch_version": version,
            "records": chunk,
            "generated_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        let raw = payload.to_string();
        let signature = sign_payload(&raw, &installation_id);
        let response = match client
            .post(&config.telemetry.endpoint)
            .header("Content-Type", "application/json")
            .header("X-Epoch-Signature", signature)
            .header("X-Epoch-Version", &version)
            .body(raw)
            .send()
        {
            Ok(response) => response,
            Err(error) => {
                return Ok(json!({ "ok": false, "recordCount": 0, "error": error.to_string() }));
            }
        };

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let suffix = response.text().unwrap_or_default();
            let suffix = suffix.trim().chars().take(200).collect::<String>();
            let error = if suffix.is_empty() {
                format!("server returned {status}")
            } else {
                format!("server returned {status}: {suffix}")
            };
            return Ok(json!({
                "ok": false,
                "recordCount": submitted,
                "accepted": accepted,
                "deduplicated": deduplicated,
                "error": error,
            }));
        }

        let body = response.json::<Value>().unwrap_or(Value::Null);
        let chunk_accepted = receiver_count(body.get("accepted")).unwrap_or(chunk.len());
        let chunk_deduplicated = receiver_count(body.get("deduplicated")).unwrap_or(0);
        submitted += chunk.len();
        accepted += chunk_accepted;
        deduplicated += chunk_deduplicated;

        if let Some(cursor) = chunk_cursor {
            config.telemetry.last_submission_at = Some(cursor);
        }
        config.telemetry.last_submission_record_count += chunk.len();
        config.telemetry.last_submission_accepted_count = accepted;
        config.telemetry.last_submission_deduplicated_count = deduplicated;
        config.telemetry.total_records_accepted += chunk_accepted;
        config.telemetry.total_records_deduplicated += chunk_deduplicated;
        save_config(&config)?;
    }

    Ok(json!({
        "ok": true,
        "recordCount": submitted,
        "accepted": accepted,
        "deduplicated": deduplicated,
    }))
}

fn optional_nonnegative_f64(input: &Value, fields: &[&str]) -> Result<Option<f64>, ToolError> {
    for field in fields {
        if let Some(value) = input.get(*field) {
            let Some(number) = value.as_f64() else {
                return Err(telemetry_cli_error(format!(
                    "{field} must be a number >= 0"
                )));
            };
            if !number.is_finite() || number < 0.0 {
                return Err(telemetry_cli_error(format!(
                    "{field} must be a number >= 0"
                )));
            }
            return Ok(Some(number));
        }
    }
    Ok(None)
}

fn receiver_count(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn telemetry_submit_interval_hours(override_hours: Option<f64>) -> f64 {
    if let Some(hours) = override_hours {
        return hours;
    }
    env::var("EPOCH_TELEMETRY_SUBMIT_INTERVAL_HOURS")
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(1.0)
}

fn should_bypass_telemetry_submit_interval(force: bool) -> bool {
    force
        || env::var("EPOCH_TELEMETRY_SUBMIT_FORCE")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"))
}

fn telemetry_submit_rate_limited(
    last_submission_at: Option<&str>,
    force: bool,
    min_interval_hours: Option<f64>,
) -> bool {
    let Some(last_submission_at) = last_submission_at else {
        return false;
    };
    if should_bypass_telemetry_submit_interval(force) {
        return false;
    }
    let interval_hours = telemetry_submit_interval_hours(min_interval_hours);
    if interval_hours == 0.0 {
        return false;
    }
    let Some(last_ms) = parse_timestamp_ms(last_submission_at) else {
        return false;
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    (now_ms - last_ms) as f64 / 3_600_000.0 < interval_hours
}

fn sign_payload(raw: &str, installation_id: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(installation_id.as_bytes()).expect("HMAC key is valid");
    mac.update(raw.as_bytes());
    hex_lower(&mac.finalize().into_bytes())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

fn package_version() -> String {
    read_to_string("package.json")
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|json| {
            json.get("version")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

fn default_export_filename() -> String {
    format!(
        "epoch-export-{}.json",
        chrono::Utc::now().format("%Y-%m-%d")
    )
}

fn parse_timestamp_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn normalize_timestamp(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| {
            dt.to_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|_| value.to_string())
}

fn round_to(value: f64, decimals: i32) -> f64 {
    let factor = 10_f64.powi(decimals);
    (value * factor).round() / factor
}

fn epoch_data_dir() -> PathBuf {
    env::var_os("EPOCH_DATA_DIR")
        .and_then(non_empty_os_path)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".epoch")))
        .unwrap_or_else(|| PathBuf::from(".epoch"))
}

fn config_path() -> PathBuf {
    epoch_data_dir().join(CONFIG_FILE)
}

fn non_empty_os_path(value: std::ffi::OsString) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty() {
        None
    } else {
        Some(path)
    }
}

fn config_io_error(error: std::io::Error) -> ToolError {
    ToolError::new(
        format!("Failed to write Epoch telemetry config: {error}."),
        "Check EPOCH_DATA_DIR permissions and retry.",
    )
}

fn telemetry_storage_error(action: &str, error: std::io::Error) -> ToolError {
    ToolError::new(
        format!("Failed to {action}: {error}."),
        "Check EPOCH_DATA_DIR permissions and local telemetry files.",
    )
}

fn telemetry_cli_error(message: impl Into<String>) -> ToolError {
    ToolError::new(
        message,
        "Use epoch telemetry status to inspect local telemetry configuration.",
    )
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
    use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::{Mutex, mpsc};
    use std::thread;
    use std::time::Duration;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

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
        assert_eq!(tools.as_array().expect("tools array").len(), 24);
        assert_eq!(tools[0]["name"], "get_current_time");
        assert!(tools[0]["description"].as_str().expect("description").len() > 0);
    }

    #[test]
    fn runs_documented_meta_commands() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("meta-commands");
        set_epoch_data_dir(&data_dir);
        let mut dispatcher = RustToolDispatcher::new();

        let telemetry = run_cli_command(&mut dispatcher, "telemetry status", json!({}))
            .expect("telemetry status runs");
        assert_eq!(telemetry["enabled"], false);
        assert_eq!(telemetry["endpoint"], "(not configured)");
        assert_eq!(telemetry["queuedRecords"], 0);

        let data =
            run_cli_command(&mut dispatcher, "data status", json!({})).expect("data status runs");
        assert_eq!(data["cocomo"]["projectCount"], 195);
        assert_eq!(data["supplementary"]["hasModelCalibration"], true);

        let share = run_cli_command(&mut dispatcher, "share-data", json!({ "ok": true }))
            .expect("share-data runs");
        assert_eq!(share["publicSafe"], true);
        assert_eq!(share["payload"]["ok"], true);
        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn every_public_meta_command_has_runtime_behavior() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("meta-smoke");
        set_epoch_data_dir(&data_dir);
        let tool_commands = cli_tool_commands()
            .into_iter()
            .map(|(command, _)| command)
            .collect::<BTreeSet<_>>();
        let mut dispatcher = RustToolDispatcher::new();

        for command in cli_command_paths() {
            if tool_commands.contains(command) || *command == "list-tools" {
                continue;
            }

            run_cli_command(&mut dispatcher, command, meta_command_input(command))
                .unwrap_or_else(|error| panic!("{command} should run: {}", error.message));
        }
        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn telemetry_enable_status_and_disable_persist_typescript_config() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("telemetry-config");
        set_epoch_data_dir(&data_dir);
        let mut dispatcher = RustToolDispatcher::new();

        let enabled = run_cli_command(
            &mut dispatcher,
            "telemetry enable",
            json!({ "endpoint": "https://collector.example.net/v1/telemetry" }),
        )
        .expect("enable telemetry");
        assert_eq!(enabled["ok"], true);
        assert_eq!(
            enabled["endpoint"],
            "https://collector.example.net/v1/telemetry"
        );

        let config = read_to_string(data_dir.join("config.json")).expect("config written");
        assert!(config.contains("\"enabled\": true"));
        assert!(config.contains("\"lastSubmissionAt\""));

        let status = run_cli_command(&mut dispatcher, "telemetry status", json!({}))
            .expect("status after enable");
        assert_eq!(status["enabled"], true);
        assert_eq!(status["endpointConfigured"], true);
        assert_eq!(
            status["endpoint"],
            "https://collector.example.net/v1/telemetry"
        );

        let disabled = run_cli_command(&mut dispatcher, "telemetry disable", json!({}))
            .expect("disable telemetry");
        assert_eq!(disabled["ok"], true);
        let status = run_cli_command(&mut dispatcher, "telemetry status", json!({}))
            .expect("status after disable");
        assert_eq!(status["enabled"], false);

        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn telemetry_endpoint_validation_matches_typescript() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("telemetry-endpoints");
        set_epoch_data_dir(&data_dir);
        let mut dispatcher = RustToolDispatcher::new();

        let invalid = run_cli_command(
            &mut dispatcher,
            "telemetry set-endpoint",
            json!({ "endpoint": "http://collector.example.net/v1/telemetry" }),
        )
        .expect_err("public http endpoint is rejected");
        assert!(invalid.message.contains("https://"));

        let tailscale = run_cli_command(
            &mut dispatcher,
            "telemetry set-endpoint",
            json!({ "endpoint": "http://100.66.225.85:3099/v1/telemetry" }),
        )
        .expect("tailscale http endpoint is allowed");
        assert_eq!(tailscale["ok"], true);
        assert_eq!(
            tailscale["endpoint"],
            "http://100.66.225.85:3099/v1/telemetry"
        );

        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn telemetry_preview_and_export_use_feedback_jsonl() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("telemetry-preview");
        set_epoch_data_dir(&data_dir);
        write_feedback_fixture(&data_dir);
        let mut dispatcher = RustToolDispatcher::new();

        let preview = run_cli_command(&mut dispatcher, "telemetry preview", json!({}))
            .expect("preview telemetry");
        assert_eq!(preview["totalRecords"], 1);
        assert_eq!(preview["sample"][0]["task_type"], "feature");
        assert_eq!(preview["sample"][0]["ratio"], 1.25);

        let output = data_dir.join("custom-export.json");
        let exported = run_cli_command(
            &mut dispatcher,
            "telemetry export",
            json!({ "output": output.to_string_lossy() }),
        )
        .expect("export telemetry");
        assert_eq!(exported["ok"], true);
        let raw = read_to_string(output).expect("export written");
        assert!(raw.contains("\"task_type\""));

        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn telemetry_submit_posts_signed_payload_and_updates_config() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("telemetry-submit");
        set_epoch_data_dir(&data_dir);
        write_feedback_fixture(&data_dir);
        let (endpoint, request_rx) = start_telemetry_receiver();
        let mut dispatcher = RustToolDispatcher::new();

        run_cli_command(
            &mut dispatcher,
            "telemetry enable",
            json!({ "endpoint": endpoint }),
        )
        .expect("enable telemetry");

        let result = run_cli_command(
            &mut dispatcher,
            "telemetry submit",
            json!({ "force": true }),
        )
        .expect("submit telemetry");
        assert_eq!(result["ok"], true);
        assert_eq!(result["recordCount"], 1);
        assert_eq!(result["accepted"], 1);
        assert_eq!(result["deduplicated"], 0);

        let request = request_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("receiver observed request");
        assert!(request.contains("POST /v1/telemetry HTTP/1.1"));
        assert!(request.contains("x-epoch-signature:") || request.contains("X-Epoch-Signature:"));
        assert!(request.contains("\"installation_id\""));
        assert!(request.contains("\"records\""));

        let config = read_to_string(data_dir.join("config.json")).expect("config after submit");
        assert!(config.contains("\"lastSubmissionAt\": \"2026-05-07T00:00:00.000Z\""));
        assert!(config.contains("\"lastSubmissionRecordCount\": 1"));
        assert!(config.contains("\"totalRecordsAccepted\": 1"));

        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn reports_unknown_commands() {
        let mut dispatcher = RustToolDispatcher::new();
        let error =
            run_cli_command(&mut dispatcher, "missing meta", json!({})).expect_err("not a command");

        assert!(error.message.contains("Unknown Rust CLI command"));
    }

    fn meta_command_input(command: &str) -> serde_json::Value {
        match command {
            "telemetry set-endpoint" => {
                json!({ "endpoint": "http://127.0.0.1:3099/v1/telemetry" })
            }
            _ => json!({}),
        }
    }

    fn temp_data_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "epoch-cli-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_else(|| chrono::Utc::now().timestamp_micros())
        ));
        let _ = remove_dir_all(&dir);
        create_dir_all(&dir).expect("temp data dir");
        dir
    }

    fn set_epoch_data_dir(path: &PathBuf) {
        unsafe {
            std::env::set_var("EPOCH_DATA_DIR", path);
            std::env::remove_var("EPOCH_TELEMETRY");
            std::env::remove_var("EPOCH_TELEMETRY_ENDPOINT");
            std::env::remove_var("EPOCH_TELEMETRY_SUBMIT_FORCE");
            std::env::remove_var("EPOCH_TELEMETRY_SUBMIT_INTERVAL_HOURS");
        }
    }

    fn clear_epoch_env() {
        unsafe {
            std::env::remove_var("EPOCH_DATA_DIR");
            std::env::remove_var("EPOCH_TELEMETRY");
            std::env::remove_var("EPOCH_TELEMETRY_ENDPOINT");
            std::env::remove_var("EPOCH_TELEMETRY_SUBMIT_FORCE");
            std::env::remove_var("EPOCH_TELEMETRY_SUBMIT_INTERVAL_HOURS");
        }
    }

    fn write_feedback_fixture(data_dir: &PathBuf) {
        write(
            data_dir.join("estimates.jsonl"),
            concat!(
                r#"{"id":"real-1","tool":"pert_estimate","inputs":{"task_type":"feature","complexity":3},"outputs":{"expected":4,"unit":"hours"},"estimatedAt":"2026-05-06T00:00:00.000Z"}"#,
                "\n"
            ),
        )
        .expect("estimate fixture");
        write(
            data_dir.join("feedback.jsonl"),
            concat!(
                r#"{"estimateId":"real-1","actualHours":5,"reportedAt":"2026-05-07T00:00:00.000Z","completedAt":"2026-05-07T00:00:00.000Z"}"#,
                "\n"
            ),
        )
        .expect("actual fixture");
    }

    fn start_telemetry_receiver() -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test receiver");
        let endpoint = format!("http://{}/v1/telemetry", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept telemetry request");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("set read timeout");
            let mut buffer = [0_u8; 65_536];
            let bytes = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..bytes]).to_string();
            tx.send(request).expect("send observed request");
            let body = r#"{"accepted":1,"deduplicated":0}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });
        (endpoint, rx)
    }
}
