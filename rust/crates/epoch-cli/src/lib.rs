use epoch_contract::ToolError;
use epoch_core::feedback::CalibrationFilters;
use epoch_mcp::{RustToolDispatcher, ToolValueResult};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Map;
use serde_json::{Value, json};
use sha2::Sha256;
use std::collections::BTreeMap;
use std::env;
use std::fs::{create_dir_all, read_to_string, rename, write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

pub use epoch_contract::{CLI_COMMAND_PATHS, PublicSurfaceContract, ToolMetadata, tool_registry};

type HmacSha256 = Hmac<Sha256>;
const CONFIG_FILE: &str = "config.json";
const ESTIMATES_FILE: &str = "estimates.jsonl";
const ACTUALS_FILE: &str = "feedback.jsonl";
const TOOL_TELEMETRY_FILE: &str = "telemetry.jsonl";
const REFERENCE_DATABASE_FILE: &str = "reference-database.json";
const RECEIVER_RECORDS_FILE: &str = "telemetry-records.jsonl";
const RECEIVER_RECEIPTS_FILE: &str = "telemetry-receipts.jsonl";
const RECEIVER_DEDUPE_KEYS_FILE: &str = "telemetry-record-keys.jsonl";
const EXPORTS_DIR: &str = "exports";
const TELEMETRY_HELP_TEXT: &str = concat!(
    "Usage: epoch telemetry [options] [command]\n\n",
    "Manage anonymous telemetry settings\n\n",
    "Options:\n",
    "  -h, --help              display help for command\n\n",
    "Commands:\n",
    "  status                  Show current telemetry configuration and history\n",
    "  preview                 Preview anonymized data that would be shared\n",
    "  export [options]        Export all anonymized data to a JSON file\n",
    "  enable [options]        Opt in to anonymous telemetry sharing\n",
    "  set-endpoint [options]  Configure the telemetry receiver endpoint\n",
    "  submit [options]        Submit queued anonymized telemetry to the configured\n",
    "                          endpoint\n",
    "  disable                 Opt out of anonymous telemetry sharing\n",
    "  delete-data [options]   Instructions for deleting your telemetry data\n",
    "  help [command]          display help for command\n"
);
const DATA_HELP_TEXT: &str = concat!(
    "Usage: epoch data [options] [command]\n\n",
    "Inspect local Epoch data files\n\n",
    "Options:\n",
    "  -h, --help      display help for command\n\n",
    "Commands:\n",
    "  where           Show local Epoch data file locations\n",
    "  status          Show local Epoch data status and file counts\n",
    "  help [command]  display help for command\n"
);
const PLACEHOLDER_TELEMETRY_ENDPOINTS: &[&str] =
    &["https://example.com", "https://example.com/v1/telemetry"];
const COMMUNITY_EXPORT_EMPTY_MESSAGE: &str = "No exportable records found. Use Epoch for a few tasks with actual-hour feedback, then run this again.";
const MINIMUM_COMMUNITY_ACTUAL_HOURS: f64 = 0.01;
const MIN_COMMUNITY_ACTUAL_ESTIMATE_RATIO: f64 = 0.03;
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
const COMMUNITY_TASK_TYPES: &[&str] = &[
    "feature",
    "bugfix",
    "refactor",
    "migration",
    "infrastructure",
    "documentation",
    "testing",
    "design",
];
const SYNTHETIC_RECORD_PREFIXES: &[&str] = &[
    "seed-",
    "test-",
    "batch-test-",
    "batch-max-",
    "batch-single-",
    "synth-",
    "demo-",
    "example-",
    "sample-",
    "fake-",
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
        "self-improve" => self_improve_value(),
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
            "ok": false,
            "message": TELEMETRY_HELP_TEXT,
        })),
        "telemetry status" => telemetry_status_value(input),
        "telemetry preview" => telemetry_preview_value(input),
        "telemetry export" => telemetry_export_value(input),
        "telemetry enable" => telemetry_enable_value(input),
        "telemetry set-endpoint" => telemetry_set_endpoint_value(input),
        "telemetry submit" => telemetry_submit_value(input),
        "telemetry disable" => telemetry_disable_value(),
        "telemetry delete-data" => telemetry_delete_data_value(),
        "share-data" => share_data_value(input),
        "data" => Ok(json!({
            "ok": false,
            "message": DATA_HELP_TEXT,
        })),
        "data status" => Ok(data_status_value()),
        "data where" => Ok(data_paths_value()),
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
        first_field_value(&input, &["min_interval_hours", "minIntervalHours"]),
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

fn share_data_value(input: Value) -> ToolValueResult {
    let output = input
        .get("output")
        .and_then(Value::as_str)
        .map(str::to_string);
    let description = input
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("Anonymized Epoch usage export")
        .to_string();
    let default_complexity = optional_f64(&input, &["default_complexity", "defaultComplexity"]);
    let validate = input
        .get("validate")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let records = match build_community_records(default_complexity) {
        Ok(records) => records,
        Err(message) => return Ok(json!({ "ok": false, "message": message })),
    };

    if records.records.is_empty() {
        return Ok(json!({ "ok": false, "message": COMMUNITY_EXPORT_EMPTY_MESSAGE }));
    }

    let output_path = output
        .map(PathBuf::from)
        .unwrap_or_else(default_community_export_path);
    if let Some(parent) = output_path.parent()
        && let Err(error) = create_dir_all(parent)
    {
        return Ok(json!({ "ok": false, "message": error.to_string() }));
    }

    let dataset = CommunityExportDataset {
        _schema: "estimation-record",
        description: &description,
        records: &records.records,
    };
    let raw = match serde_json::to_string_pretty(&dataset) {
        Ok(raw) => raw,
        Err(error) => return Ok(json!({ "ok": false, "message": error.to_string() })),
    };
    if let Err(error) = write(&output_path, raw) {
        return Ok(json!({ "ok": false, "message": error.to_string() }));
    }

    let mut output = Map::new();
    output.insert("ok".to_string(), Value::Bool(true));
    output.insert(
        "path".to_string(),
        Value::String(output_path.to_string_lossy().to_string()),
    );
    output.insert(
        "recordCount".to_string(),
        Value::Number(serde_json::Number::from(records.record_count)),
    );
    output.insert(
        "skipped".to_string(),
        json!({
            "missingComplexity": records.skipped_missing_complexity,
            "invalidTaskType": records.skipped_invalid_task_type,
            "invalidHours": records.skipped_invalid_hours,
        }),
    );
    output.insert(
        "schema".to_string(),
        Value::String("estimation-record".to_string()),
    );
    output.insert("validated".to_string(), Value::Bool(false));
    if validate {
        let dataset_value = match serde_json::to_value(&dataset) {
            Ok(value) => value,
            Err(error) => return Ok(json!({ "ok": false, "message": error.to_string() })),
        };
        let errors = validate_community_dataset(&dataset_value);
        output.insert("validated".to_string(), Value::Bool(errors.is_empty()));
        if !errors.is_empty() {
            output.insert(
                "validationErrors".to_string(),
                Value::Array(errors.into_iter().map(Value::String).collect()),
            );
        }
    }
    output.insert(
        "nextSteps".to_string(),
        json!([
            "Review the exported file to verify anonymization",
            "Copy it to data/community/<contributor-id>-estimation.json",
            "Run node scripts/validate-community-data.mjs",
            "Open a pull request",
        ]),
    );

    Ok(Value::Object(output))
}

struct CommunityRecords {
    records: Vec<CommunityExportRecord>,
    record_count: usize,
    skipped_missing_complexity: usize,
    skipped_invalid_task_type: usize,
    skipped_invalid_hours: usize,
}

#[derive(Debug, Clone, Serialize)]
struct CommunityExportRecord {
    estimated_hours: Value,
    actual_hours: Value,
    task_type: String,
    complexity: i64,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    contributor_id: Option<String>,
}

#[derive(Serialize)]
struct CommunityExportDataset<'a> {
    _schema: &'static str,
    description: &'a str,
    records: &'a [CommunityExportRecord],
}

fn build_community_records(default_complexity: Option<f64>) -> Result<CommunityRecords, String> {
    let raw_records = extract_community_anonymized_records();
    let mut config = load_config();
    let contributor_id = get_installation_id(&mut config)
        .ok()
        .map(|id| pseudonymize_contributor_id(&id));

    let mut out = CommunityRecords {
        records: Vec::new(),
        record_count: 0,
        skipped_missing_complexity: 0,
        skipped_invalid_task_type: 0,
        skipped_invalid_hours: 0,
    };

    for raw in raw_records {
        let Some(task_type) = raw.get("task_type").and_then(Value::as_str) else {
            out.skipped_invalid_task_type += 1;
            continue;
        };
        if !COMMUNITY_TASK_TYPES.contains(&task_type) {
            out.skipped_invalid_task_type += 1;
            continue;
        }

        let complexity = match raw.get("complexity").and_then(Value::as_f64) {
            Some(value) => value,
            None => match default_complexity {
                Some(value) => value,
                None => {
                    out.skipped_missing_complexity += 1;
                    continue;
                }
            },
        };
        if !is_integer_in_range(complexity, 1.0, 5.0) {
            out.skipped_missing_complexity += 1;
            continue;
        }

        let Some(estimated_hours) = raw.get("estimated_hours").and_then(Value::as_f64) else {
            out.skipped_invalid_hours += 1;
            continue;
        };
        let Some(actual_hours) = raw.get("actual_hours").and_then(Value::as_f64) else {
            out.skipped_invalid_hours += 1;
            continue;
        };
        if !estimated_hours.is_finite()
            || estimated_hours <= 0.0
            || !actual_hours.is_finite()
            || actual_hours < 0.0
        {
            out.skipped_invalid_hours += 1;
            continue;
        }

        let date = raw.get("date").and_then(Value::as_str).unwrap_or_default();
        out.records.push(CommunityExportRecord {
            estimated_hours: rounded_json_number(estimated_hours, 2),
            actual_hours: rounded_json_number(actual_hours, 2),
            task_type: task_type.to_string(),
            complexity: complexity as i64,
            timestamp: format!("{date}T00:00:00Z"),
            contributor_id: contributor_id.clone(),
        });
    }
    out.record_count = out.records.len();
    Ok(out)
}

fn extract_community_anonymized_records() -> Vec<Value> {
    let estimates = read_epoch_jsonl_values(&epoch_data_dir().join(ESTIMATES_FILE));
    let actuals = read_epoch_jsonl_values(&epoch_data_dir().join(ACTUALS_FILE));
    let mut actuals_by_id: BTreeMap<String, Value> = BTreeMap::new();
    for actual in actuals {
        if let Some(id) = community_string(actual.get("estimateId")) {
            actuals_by_id.insert(id.to_string(), actual);
        }
    }

    let mut records = Vec::new();
    for estimate in estimates {
        let Some(id) = community_string(estimate.get("id")) else {
            continue;
        };
        let Some(actual) = actuals_by_id.get(id) else {
            continue;
        };
        let Some(actual_hours) = community_number(actual.get("actualHours")) else {
            continue;
        };
        if actual_hours < MINIMUM_COMMUNITY_ACTUAL_HOURS || is_community_seed_record(actual) {
            continue;
        }
        if community_calibration_usage(estimate.get("inputs"), actual, &estimate) != "correction" {
            continue;
        }
        let Some(estimated_hours) = extract_community_estimated_hours(estimate.get("outputs"))
        else {
            continue;
        };
        if estimated_hours <= 0.0
            || actual_hours / estimated_hours < MIN_COMMUNITY_ACTUAL_ESTIMATE_RATIO
        {
            continue;
        }

        let inputs = estimate.get("inputs");
        let task_type = inputs
            .and_then(|inputs| community_string(inputs.get("task_type")))
            .map(str::to_string)
            .unwrap_or_else(|| {
                infer_community_task_type(community_string(estimate.get("tool")).unwrap_or(""))
                    .to_string()
            });
        let completed_at = community_string(actual.get("completedAt"))
            .or_else(|| community_string(actual.get("reportedAt")))
            .unwrap_or("");
        let mut record = Map::new();
        record.insert("task_type".to_string(), Value::String(task_type));
        record.insert(
            "complexity".to_string(),
            inputs
                .and_then(|inputs| community_number(inputs.get("complexity")))
                .map(js_json_number)
                .unwrap_or(Value::Null),
        );
        record.insert(
            "tool".to_string(),
            Value::String(
                community_string(estimate.get("tool"))
                    .unwrap_or("unknown")
                    .to_string(),
            ),
        );
        record.insert(
            "estimated_hours".to_string(),
            rounded_json_number(estimated_hours, 2),
        );
        record.insert(
            "actual_hours".to_string(),
            rounded_json_number(actual_hours, 2),
        );
        record.insert(
            "ratio".to_string(),
            rounded_json_number(actual_hours / estimated_hours, 4),
        );
        record.insert(
            "date".to_string(),
            Value::String(completed_at.chars().take(10).collect()),
        );
        record.insert(
            "completed_at".to_string(),
            Value::String(normalize_timestamp(completed_at)),
        );
        records.push((completed_at.to_string(), Value::Object(record)));
    }
    records.sort_by(|left, right| left.0.cmp(&right.0));
    records.into_iter().map(|(_, record)| record).collect()
}

fn read_epoch_jsonl_values(path: &Path) -> Vec<Value> {
    read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn community_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn community_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn is_community_seed_record(actual: &Value) -> bool {
    if community_string(actual.get("estimateId")).is_some_and(|id| {
        SYNTHETIC_RECORD_PREFIXES
            .iter()
            .any(|prefix| id.starts_with(prefix))
    }) {
        return true;
    }
    let notes = community_string(actual.get("notes"))
        .unwrap_or("")
        .to_lowercase();
    notes.contains("seed")
        || notes.contains("synthetic")
        || notes.contains("dogfood-seed")
        || notes.contains("test data")
}

fn community_calibration_usage(
    inputs: Option<&Value>,
    actual: &Value,
    estimate: &Value,
) -> &'static str {
    let explicit_provenance = normalized_community_provenance(coalesced_json_value(&[
        inputs.and_then(|inputs| inputs.get("calibration_provenance")),
        actual.get("calibrationProvenance"),
        actual.get("calibration_provenance"),
    ]));
    let explicit_usage = normalized_community_usage(coalesced_json_value(&[
        inputs.and_then(|inputs| inputs.get("calibration_usage")),
        actual.get("calibrationUsage"),
        actual.get("calibration_usage"),
    ]));
    let notes = community_string(actual.get("notes"))
        .unwrap_or("")
        .to_lowercase();
    let tool = community_string(estimate.get("tool"))
        .unwrap_or("")
        .to_lowercase();

    if explicit_usage == Some("exclude")
        || matches!(explicit_provenance, Some("synthetic" | "smoke"))
    {
        return "exclude";
    }
    if tool == "receiver_smoke"
        || notes.contains("receiver smoke")
        || notes.contains("smoke test")
        || notes.contains("industry calibration")
    {
        return "exclude";
    }
    if notes.contains("ingested from") || notes.contains("real data calibration") {
        return "baseline";
    }
    if happened_before_community(
        community_string(actual.get("completedAt")),
        community_string(estimate.get("estimatedAt")),
    ) {
        return "baseline";
    }
    if let Some(provenance) = explicit_provenance {
        return explicit_usage.unwrap_or(if provenance == "prospective" {
            "correction"
        } else {
            "baseline"
        });
    }
    explicit_usage.unwrap_or("correction")
}

fn coalesced_json_value<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    for value in values {
        if let Some(value) = *value
            && !value.is_null()
        {
            return Some(value);
        }
    }
    None
}

fn normalized_community_provenance(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_str)? {
        "prospective" => Some("prospective"),
        "backfilled_real_session" => Some("backfilled_real_session"),
        "backfilled_calibration" => Some("backfilled_calibration"),
        "synthetic" => Some("synthetic"),
        "smoke" => Some("smoke"),
        "unknown" => Some("unknown"),
        _ => None,
    }
}

fn normalized_community_usage(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_str)? {
        "correction" => Some("correction"),
        "baseline" => Some("baseline"),
        "exclude" => Some("exclude"),
        _ => None,
    }
}

fn happened_before_community(a: Option<&str>, b: Option<&str>) -> bool {
    let Some(a) = a.and_then(parse_timestamp_ms) else {
        return false;
    };
    let Some(b) = b.and_then(parse_timestamp_ms) else {
        return false;
    };
    a < b - 60_000
}

fn extract_community_estimated_hours(outputs: Option<&Value>) -> Option<f64> {
    let outputs = outputs?.as_object()?;
    if let Some(value) = community_number(outputs.get("totalHours")) {
        return Some(value);
    }
    if let Some(value) = community_number(outputs.get("estimatedHours")) {
        return Some(value);
    }
    if let Some(value) = community_number(outputs.get("estimatedMinutes")) {
        return Some(value / 60.0);
    }
    if let Some(value) = community_number(outputs.get("estimatedSeconds")) {
        return Some(value / 3600.0);
    }
    if let Some(value) = community_number(outputs.get("expected")) {
        return match community_string(outputs.get("unit")) {
            Some("hours") | None => Some(value),
            Some("days") => Some(value * 8.0),
            Some("weeks") => Some(value * 40.0),
            Some("months") => Some(value * 160.0),
            Some(_) => None,
        };
    }
    if let Some(value) = community_number(outputs.get("personMonthsLlmAdjusted")) {
        return Some(value * 160.0);
    }
    if let Some(value) = community_number(outputs.get("correctedEstimate")) {
        return Some(value);
    }
    if let Some(value) = community_number(outputs.get("total_duration")) {
        return Some(value * 8.0);
    }
    None
}

fn infer_community_task_type(tool: &str) -> &'static str {
    match tool {
        "token_time_bridge" | "token_cost_estimate" => "infrastructure",
        "pert_estimate"
        | "cocomo_estimate"
        | "sprint_forecast"
        | "reference_class_estimate"
        | "monte_carlo_schedule"
        | "critical_path"
        | "calibrate_estimates"
        | "schedule_risk"
        | "feedback_health"
        | "accuracy_trend"
        | "compare_models" => "feature",
        _ => "feature",
    }
}

fn optional_f64(input: &Value, fields: &[&str]) -> Option<f64> {
    fields
        .iter()
        .find_map(|field| input.get(*field).and_then(Value::as_f64))
}

fn is_integer_in_range(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value >= min && value <= max
}

fn pseudonymize_contributor_id(installation_id: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(b"epoch-community").expect("HMAC key is valid");
    mac.update(installation_id.as_bytes());
    hex_lower(&mac.finalize().into_bytes())
        .chars()
        .take(16)
        .collect()
}

fn default_community_export_path() -> PathBuf {
    epoch_data_dir().join(EXPORTS_DIR).join(format!(
        "epoch-community-estimation-{}.json",
        chrono::Utc::now().format("%Y-%m-%d")
    ))
}

fn validate_community_dataset(dataset: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    if dataset.get("_schema") != Some(&Value::String("estimation-record".to_string())) {
        errors.push(r#"Missing or invalid _schema: expected "estimation-record""#.to_string());
    }
    let Some(records) = dataset.get("records").and_then(Value::as_array) else {
        errors.push(r#"Missing or invalid "records": expected an array"#.to_string());
        return errors;
    };

    for (index, record) in records.iter().enumerate() {
        let Some(record) = record.as_object() else {
            errors.push(format!("Record {index}: null or undefined"));
            continue;
        };
        for field in [
            "estimated_hours",
            "actual_hours",
            "task_type",
            "complexity",
            "timestamp",
        ] {
            if record.get(field).is_none_or(Value::is_null) {
                errors.push(format!(
                    r#"Record {index}: missing required field "{field}""#
                ));
            }
        }
        if record
            .get("estimated_hours")
            .and_then(Value::as_f64)
            .is_none_or(|value| !value.is_finite() || value < 0.1)
        {
            errors.push(format!("Record {index}: estimated_hours must be >= 0.1"));
        }
        if record
            .get("actual_hours")
            .and_then(Value::as_f64)
            .is_none_or(|value| !value.is_finite() || value < 0.0)
        {
            errors.push(format!("Record {index}: actual_hours must be >= 0"));
        }
        if record
            .get("complexity")
            .and_then(Value::as_f64)
            .is_none_or(|value| !is_integer_in_range(value, 1.0, 5.0))
        {
            errors.push(format!("Record {index}: complexity must be an integer 1-5"));
        }
        match record.get("task_type").and_then(Value::as_str) {
            Some(task_type) if COMMUNITY_TASK_TYPES.contains(&task_type) => {}
            Some(task_type) => errors.push(format!(
                "Record {index}: task_type \"{task_type}\" is not one of: {}",
                COMMUNITY_TASK_TYPES.join(", ")
            )),
            None => errors.push(format!("Record {index}: task_type must be a string")),
        }
        if record
            .get("timestamp")
            .and_then(Value::as_str)
            .is_none_or(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
        {
            errors.push(format!(
                "Record {index}: timestamp must be a valid ISO date-time"
            ));
        }
    }
    errors
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
                record.complexity.map(js_json_number).unwrap_or(Value::Null),
            );
            object.insert(
                "tool".to_string(),
                Value::String(record.tool.unwrap_or_else(|| "unknown".to_string())),
            );
            object.insert(
                "estimated_hours".to_string(),
                rounded_json_number(record.estimated_hours, 2),
            );
            object.insert(
                "actual_hours".to_string(),
                rounded_json_number(record.actual_hours, 2),
            );
            object.insert(
                "ratio".to_string(),
                rounded_json_number(record.actual_hours / record.estimated_hours, 4),
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
    let exports_dir = epoch_data_dir().join(EXPORTS_DIR);
    create_dir_all(&exports_dir).map_err(config_io_error)?;
    let path = output
        .map(PathBuf::from)
        .unwrap_or_else(|| exports_dir.join(default_export_filename()));
    let raw = serialize_telemetry_export_records(records)?;
    write(&path, raw).map_err(config_io_error)?;
    Ok(path.to_string_lossy().into_owned())
}

fn serialize_telemetry_export_records(records: &[Value]) -> Result<String, ToolError> {
    if records.is_empty() {
        return Ok("[]".to_string());
    }

    let mut raw = String::from("[\n");
    for (record_index, record) in records.iter().enumerate() {
        let Some(record) = record.as_object() else {
            return Err(telemetry_cli_error(
                "telemetry export record was not a JSON object",
            ));
        };
        raw.push_str("  {\n");
        for (field_index, field) in ANONYMIZED_RECORD_FIELDS.iter().enumerate() {
            raw.push_str("    ");
            raw.push_str(&serde_json::to_string(field).map_err(|error| {
                ToolError::new(
                    format!("Failed to serialize telemetry export field: {error}."),
                    "Inspect local feedback records before exporting.",
                )
            })?);
            raw.push_str(": ");
            raw.push_str(
                &serde_json::to_string(record.get(*field).unwrap_or(&Value::Null)).map_err(
                    |error| {
                        ToolError::new(
                            format!("Failed to serialize telemetry export value: {error}."),
                            "Inspect local feedback records before exporting.",
                        )
                    },
                )?,
            );
            if field_index + 1 < ANONYMIZED_RECORD_FIELDS.len() {
                raw.push(',');
            }
            raw.push('\n');
        }
        raw.push_str("  }");
        if record_index + 1 < records.len() {
            raw.push(',');
        }
        raw.push('\n');
    }
    raw.push(']');
    Ok(raw)
}

fn submit_telemetry(force: bool, min_interval_hours: Option<&Value>) -> ToolValueResult {
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

fn first_field_value<'a>(input: &'a Value, fields: &[&str]) -> Option<&'a Value> {
    for field in fields {
        if let Some(value) = input.get(*field) {
            return Some(value);
        }
    }
    None
}

fn receiver_count(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn telemetry_submit_interval_hours(override_hours: Option<&Value>) -> f64 {
    if let Some(hours) = override_hours.and_then(interval_hours_from_value) {
        return hours;
    }
    env::var("EPOCH_TELEMETRY_SUBMIT_INTERVAL_HOURS")
        .ok()
        .and_then(|value| parse_typescript_number(value.trim()))
        .unwrap_or(1.0)
}

fn interval_hours_from_value(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return (number.is_finite() && number >= 0.0).then_some(number);
    }
    value
        .as_str()
        .and_then(|raw| parse_typescript_number(raw.trim()))
}

fn parse_typescript_number(raw: &str) -> Option<f64> {
    if raw.is_empty() {
        return None;
    }
    let trimmed = raw.trim();
    let unsigned_hex = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"));
    if let Some(hex) = unsigned_hex {
        return u64::from_str_radix(hex, 16)
            .ok()
            .map(|value| value as f64)
            .filter(|value| value.is_finite());
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
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
    min_interval_hours: Option<&Value>,
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

fn rounded_json_number(value: f64, decimals: i32) -> Value {
    js_json_number(round_to(value, decimals))
}

fn js_json_number(value: f64) -> Value {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value <= i64::MAX as f64
    {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
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

fn self_improve_value() -> ToolValueResult {
    update_reference_database()?;
    Ok(json!({
        "ok": true,
        "message": "Self-improvement complete.",
    }))
}

fn update_reference_database() -> Result<(), ToolError> {
    let Some((mut db, _loaded_from)) = load_self_improve_reference_database() else {
        return Ok(());
    };
    let Some(root) = db.as_object_mut() else {
        return Ok(());
    };

    let tool_stats = load_tool_telemetry_stats(&data_paths().tool_telemetry, 90);
    {
        let benchmarks = object_field_mut(root, "toolExecutionBenchmarks");
        for stat in &tool_stats {
            let next = match benchmarks.get(&stat.tool) {
                Some(existing) => merge_tool_benchmark(existing, stat),
                None => json!({
                    "p50_ms": rounded_json_number(stat.p50_ms, 2),
                    "p95_ms": rounded_json_number(stat.p95_ms, 2),
                    "mean_ms": rounded_json_number(stat.mean_ms, 2),
                    "stddev_ms": 0,
                    "min_ms": rounded_json_number(stat.p50_ms, 2),
                    "max_ms": rounded_json_number(stat.p95_ms, 2),
                    "sampleCount": stat.call_count,
                }),
            };
            benchmarks.insert(stat.tool.clone(), next);
        }
    }

    let feedback_records = extract_self_improve_feedback_records(180);
    let received_records = load_received_self_improve_records(&data_paths().receiver_records);
    let mut calibration_records = feedback_records.clone();
    calibration_records.extend(received_records.clone());
    if calibration_records.len() >= 5 {
        root.insert(
            "taskTypeCorrectionFactors".to_string(),
            compute_self_improve_correction_factors(&calibration_records),
        );
        root.insert(
            "toolTaskCorrectionFactors".to_string(),
            compute_self_improve_tool_correction_factors(&calibration_records),
        );
        root.insert(
            "complexityCorrectionFactors".to_string(),
            compute_self_improve_complexity_correction_factors(&calibration_records),
        );
        root.insert(
            "globalCorrectionFactor".to_string(),
            rounded_json_number(
                compute_self_improve_global_correction(&calibration_records),
                2,
            ),
        );
    }

    let telemetry_size: usize = tool_stats.iter().map(|stat| stat.call_count).sum();
    let existing_sample_size = root
        .get("sampleSize")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    root.insert(
        "sampleSize".to_string(),
        rounded_json_number(
            existing_sample_size
                + telemetry_size as f64
                + feedback_records.len() as f64
                + received_records.len() as f64,
            2,
        ),
    );
    root.insert(
        "generatedAt".to_string(),
        Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    root.insert(
        "source".to_string(),
        Value::String("self-improvement".to_string()),
    );

    let data_dir = epoch_data_dir();
    create_dir_all(&data_dir)
        .map_err(|error| self_improve_io_error("create data directory", error))?;
    let target = data_dir.join(REFERENCE_DATABASE_FILE);
    let tmp = data_dir.join(format!("{REFERENCE_DATABASE_FILE}.tmp"));
    let raw = serde_json::to_string_pretty(&db).map_err(|error| {
        ToolError::new(
            format!("Failed to serialize Epoch reference database: {error}."),
            "Check local reference database contents and retry.",
        )
    })?;
    write(&tmp, raw).map_err(|error| self_improve_io_error("write reference database", error))?;
    rename(&tmp, &target)
        .map_err(|error| self_improve_io_error("replace reference database", error))?;
    Ok(())
}

fn self_improve_io_error(action: &str, error: std::io::Error) -> ToolError {
    ToolError::new(
        format!("Failed to {action}: {error}."),
        "Check EPOCH_DATA_DIR permissions and retry.",
    )
}

fn load_self_improve_reference_database() -> Option<(Value, PathBuf)> {
    let configured = env::var_os("EPOCH_DATA_DIR")
        .and_then(non_empty_os_path)
        .map(|dir| dir.join(REFERENCE_DATABASE_FILE));
    if let Some(path) = configured.filter(|path| path.exists())
        && let Some(db) = read_reference_database(&path)
    {
        return Some((db, path));
    }

    if let Some(path) = user_reference_database_path().filter(|path| path.exists())
        && let Some(db) = read_reference_database(&path)
    {
        return Some((db, path));
    }

    for path in [
        PathBuf::from("src")
            .join("data")
            .join(REFERENCE_DATABASE_FILE),
        PathBuf::from("dist").join(REFERENCE_DATABASE_FILE),
        PathBuf::from(REFERENCE_DATABASE_FILE),
    ] {
        if path.exists()
            && let Some(db) = read_reference_database(&path)
        {
            return Some((db, path));
        }
    }

    epoch_data::bundled_reference_database()
        .ok()
        .map(|db| (db, PathBuf::from("(bundled)")))
}

#[derive(Debug, Clone)]
struct SelfImproveRecord {
    task_type: String,
    complexity: Option<f64>,
    tool: Option<String>,
    estimated_hours: f64,
    actual_hours: f64,
}

#[derive(Debug, Clone)]
struct SelfImproveToolStat {
    tool: String,
    call_count: usize,
    p50_ms: f64,
    p95_ms: f64,
    mean_ms: f64,
}

fn object_field_mut<'a>(root: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let needs_object = !matches!(root.get(key), Some(Value::Object(_)));
    if needs_object {
        root.insert(key.to_string(), Value::Object(Map::new()));
    }
    root.get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("object field just initialized")
}

fn merge_tool_benchmark(existing: &Value, stat: &SelfImproveToolStat) -> Value {
    let sample_count = existing
        .get("sampleCount")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let total_new = stat.call_count as f64;
    let total = sample_count + total_new;
    if total <= 0.0 {
        return json!({
            "p50_ms": rounded_json_number(stat.p50_ms, 2),
            "p95_ms": rounded_json_number(stat.p95_ms, 2),
            "mean_ms": rounded_json_number(stat.mean_ms, 2),
            "stddev_ms": 0,
            "min_ms": rounded_json_number(stat.p50_ms, 2),
            "max_ms": rounded_json_number(stat.p95_ms, 2),
            "sampleCount": stat.call_count,
        });
    }

    let w = sample_count / total;
    let w2 = total_new / total;
    let existing_number = |key: &str| existing.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    json!({
        "p50_ms": rounded_json_number(existing_number("p50_ms") * w + stat.p50_ms * w2, 2),
        "p95_ms": rounded_json_number(existing_number("p95_ms") * w + stat.p95_ms * w2, 2),
        "mean_ms": rounded_json_number(existing_number("mean_ms") * w + stat.mean_ms * w2, 2),
        "stddev_ms": rounded_json_number(
            (existing_number("stddev_ms").powi(2) * w + (stat.p95_ms - stat.p50_ms).powi(2) * w2).sqrt(),
            2
        ),
        "min_ms": rounded_json_number(existing_number("min_ms").min(stat.p50_ms * 0.5), 2),
        "max_ms": rounded_json_number(existing_number("max_ms").max(stat.p95_ms * 1.5), 2),
        "sampleCount": rounded_json_number(total, 2),
    })
}

fn extract_self_improve_feedback_records(window_days: i64) -> Vec<SelfImproveRecord> {
    let estimates = read_epoch_jsonl_values(&epoch_data_dir().join(ESTIMATES_FILE));
    let actuals = read_epoch_jsonl_values(&epoch_data_dir().join(ACTUALS_FILE));
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(window_days))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut actuals_by_id: BTreeMap<String, Value> = BTreeMap::new();
    for actual in actuals {
        if let Some(id) = community_string(actual.get("estimateId")) {
            actuals_by_id.insert(id.to_string(), actual);
        }
    }

    let mut records = Vec::new();
    for estimate in estimates {
        if community_string(estimate.get("estimatedAt"))
            .is_some_and(|value| value < cutoff.as_str())
        {
            continue;
        }
        let Some(id) = community_string(estimate.get("id")) else {
            continue;
        };
        let Some(actual) = actuals_by_id.get(id) else {
            continue;
        };
        let Some(actual_hours) = community_number(actual.get("actualHours")) else {
            continue;
        };
        if actual_hours < MINIMUM_COMMUNITY_ACTUAL_HOURS || is_community_seed_record(actual) {
            continue;
        }
        if community_calibration_usage(estimate.get("inputs"), actual, &estimate) != "correction" {
            continue;
        }
        let Some(estimated_hours) = extract_community_estimated_hours(estimate.get("outputs"))
        else {
            continue;
        };
        if estimated_hours <= 0.0
            || actual_hours / estimated_hours < MIN_COMMUNITY_ACTUAL_ESTIMATE_RATIO
        {
            continue;
        }

        let inputs = estimate.get("inputs");
        let tool = community_string(estimate.get("tool")).map(str::to_string);
        let task_type = inputs
            .and_then(|inputs| community_string(inputs.get("task_type")))
            .map(str::to_string)
            .unwrap_or_else(|| {
                infer_community_task_type(tool.as_deref().unwrap_or("")).to_string()
            });
        records.push(SelfImproveRecord {
            task_type,
            complexity: inputs.and_then(|inputs| community_number(inputs.get("complexity"))),
            tool,
            estimated_hours,
            actual_hours,
        });
    }
    records
}

fn load_received_self_improve_records(path: &Path) -> Vec<SelfImproveRecord> {
    read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|record| received_self_improve_record(&record))
        .collect()
}

fn received_self_improve_record(record: &Value) -> Option<SelfImproveRecord> {
    let task_type = record.get("task_type").and_then(Value::as_str)?.to_string();
    let complexity = match record.get("complexity") {
        Some(Value::Null) | None => None,
        Some(value) => Some(value.as_f64().filter(|value| value.is_finite())?),
    };
    let tool = record.get("tool").and_then(Value::as_str)?.to_string();
    let estimated_hours = record.get("estimated_hours").and_then(Value::as_f64)?;
    let actual_hours = record.get("actual_hours").and_then(Value::as_f64)?;
    let ratio = record.get("ratio").and_then(Value::as_f64)?;
    let date = record.get("date").and_then(Value::as_str)?;
    if !estimated_hours.is_finite()
        || estimated_hours <= 0.0
        || !actual_hours.is_finite()
        || actual_hours <= 0.0
        || !ratio.is_finite()
        || !is_yyyy_mm_dd(date)
    {
        return None;
    }
    Some(SelfImproveRecord {
        task_type,
        complexity,
        tool: Some(tool),
        estimated_hours,
        actual_hours,
    })
}

fn is_yyyy_mm_dd(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn load_tool_telemetry_stats(path: &Path, window_days: i64) -> Vec<SelfImproveToolStat> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(window_days))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut grouped: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for record in read_epoch_jsonl_values(path) {
        let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) else {
            continue;
        };
        if timestamp < cutoff.as_str() {
            continue;
        }
        let Some(tool) = record.get("tool").and_then(Value::as_str) else {
            continue;
        };
        let Some(elapsed_ms) = record.get("elapsedMs").and_then(Value::as_f64) else {
            continue;
        };
        if !elapsed_ms.is_finite() {
            continue;
        }
        grouped
            .entry(tool.to_string())
            .or_default()
            .push(elapsed_ms);
    }

    let mut stats = grouped
        .into_iter()
        .map(|(tool, mut elapsed)| {
            elapsed.sort_by(|left, right| left.total_cmp(right));
            let call_count = elapsed.len();
            let mean_ms = elapsed.iter().sum::<f64>() / call_count as f64;
            SelfImproveToolStat {
                tool,
                call_count,
                p50_ms: percentile_ts(&elapsed, 0.5),
                p95_ms: percentile_ts(&elapsed, 0.95),
                mean_ms: round_to(mean_ms, 2),
            }
        })
        .collect::<Vec<_>>();
    stats.sort_by(|left, right| right.call_count.cmp(&left.call_count));
    stats
}

fn percentile_ts(sorted: &[f64], percentile: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() as f64) * percentile).floor() as usize;
    round_to(sorted[index.min(sorted.len() - 1)], 2)
}

fn compute_self_improve_correction_factors(records: &[SelfImproveRecord]) -> Value {
    let mut grouped: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for record in valid_self_improve_records(records) {
        grouped
            .entry(record.task_type.clone())
            .or_default()
            .push(record.actual_hours / record.estimated_hours);
    }
    let mut out = Map::new();
    for (task_type, ratios) in grouped {
        if ratios.len() < 3 {
            continue;
        }
        out.insert(task_type, rounded_json_number(clamped_median(ratios), 2));
    }
    Value::Object(out)
}

fn compute_self_improve_global_correction(records: &[SelfImproveRecord]) -> f64 {
    let ratios = valid_self_improve_records(records)
        .into_iter()
        .map(|record| record.actual_hours / record.estimated_hours)
        .collect::<Vec<_>>();
    if ratios.is_empty() {
        return 1.07;
    }
    clamped_median(ratios)
}

fn compute_self_improve_tool_correction_factors(records: &[SelfImproveRecord]) -> Value {
    let mut grouped: BTreeMap<String, BTreeMap<String, Vec<f64>>> = BTreeMap::new();
    for record in valid_self_improve_records(records) {
        let tool = record.tool.clone().unwrap_or_else(|| "unknown".to_string());
        grouped
            .entry(tool)
            .or_default()
            .entry(record.task_type.clone())
            .or_default()
            .push(record.actual_hours / record.estimated_hours);
    }
    let mut out = Map::new();
    for (tool, task_map) in grouped {
        let mut task_out = Map::new();
        for (task_type, ratios) in task_map {
            if ratios.len() < 3 {
                continue;
            }
            task_out.insert(task_type, rounded_json_number(clamped_median(ratios), 2));
        }
        out.insert(tool, Value::Object(task_out));
    }
    Value::Object(out)
}

fn compute_self_improve_complexity_correction_factors(records: &[SelfImproveRecord]) -> Value {
    let mut grouped: BTreeMap<String, BTreeMap<String, Vec<f64>>> = BTreeMap::new();
    for record in valid_self_improve_records(records) {
        let Some(complexity) = record.complexity else {
            continue;
        };
        grouped
            .entry(record.task_type.clone())
            .or_default()
            .entry(number_key(complexity))
            .or_default()
            .push(record.actual_hours / record.estimated_hours);
    }
    let mut out = Map::new();
    for (task_type, complexity_map) in grouped {
        let mut complexity_out = Map::new();
        for (complexity, ratios) in complexity_map {
            if ratios.len() < 3 {
                continue;
            }
            complexity_out.insert(complexity, rounded_json_number(clamped_median(ratios), 2));
        }
        out.insert(task_type, Value::Object(complexity_out));
    }
    Value::Object(out)
}

fn valid_self_improve_records(records: &[SelfImproveRecord]) -> Vec<&SelfImproveRecord> {
    records
        .iter()
        .filter(|record| {
            record.estimated_hours.is_finite()
                && record.estimated_hours > 0.0
                && record.actual_hours.is_finite()
                && record.actual_hours > 0.0
        })
        .collect()
}

fn clamped_median(mut ratios: Vec<f64>) -> f64 {
    ratios.sort_by(|left, right| left.total_cmp(right));
    let mid = ratios.len() / 2;
    let median = if ratios.len().is_multiple_of(2) {
        (ratios[mid - 1] + ratios[mid]) / 2.0
    } else {
        ratios[mid]
    };
    round_to(median.clamp(0.1, 3.0), 2)
}

fn number_key(value: f64) -> String {
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        (value as i64).to_string()
    } else {
        let mut text = value.to_string();
        if text.contains('.') {
            while text.ends_with('0') {
                text.pop();
            }
            if text.ends_with('.') {
                text.pop();
            }
        }
        text
    }
}

fn data_paths() -> DataPaths {
    let dir = epoch_data_dir();
    DataPaths {
        data_dir: dir.clone(),
        config: dir.join(CONFIG_FILE),
        estimates: dir.join(ESTIMATES_FILE),
        actuals: dir.join(ACTUALS_FILE),
        tool_telemetry: dir.join(TOOL_TELEMETRY_FILE),
        reference_database: dir.join(REFERENCE_DATABASE_FILE),
        exports_dir: dir.join(EXPORTS_DIR),
        receiver_records: dir.join(RECEIVER_RECORDS_FILE),
        receiver_receipts: dir.join(RECEIVER_RECEIPTS_FILE),
        receiver_dedupe_keys: dir.join(RECEIVER_DEDUPE_KEYS_FILE),
    }
}

#[derive(Debug, Clone)]
struct DataPaths {
    data_dir: PathBuf,
    config: PathBuf,
    estimates: PathBuf,
    actuals: PathBuf,
    tool_telemetry: PathBuf,
    reference_database: PathBuf,
    exports_dir: PathBuf,
    receiver_records: PathBuf,
    receiver_receipts: PathBuf,
    receiver_dedupe_keys: PathBuf,
}

fn data_paths_value() -> Value {
    let paths = data_paths();
    json!({
        "dataDir": path_string(&paths.data_dir),
        "config": path_string(&paths.config),
        "estimates": path_string(&paths.estimates),
        "actuals": path_string(&paths.actuals),
        "toolTelemetry": path_string(&paths.tool_telemetry),
        "referenceDatabase": path_string(&paths.reference_database),
        "exportsDir": path_string(&paths.exports_dir),
        "receiverRecords": path_string(&paths.receiver_records),
        "receiverReceipts": path_string(&paths.receiver_receipts),
        "receiverDedupeKeys": path_string(&paths.receiver_dedupe_keys),
    })
}

fn data_status_value() -> Value {
    let paths = data_paths();
    let estimates = file_status(&paths.estimates);
    let actuals = file_status(&paths.actuals);
    let tool_telemetry = file_status(&paths.tool_telemetry);
    let receiver_records = file_status(&paths.receiver_records);
    let receiver_receipts = file_status(&paths.receiver_receipts);
    let matched_pairs = count_matched_pairs(&paths.estimates, &paths.actuals);
    let total_estimates = estimates["lines"].as_u64().unwrap_or(0);
    let total_actuals = actuals["lines"].as_u64().unwrap_or(0);
    let match_rate = if total_estimates > 0 {
        ((matched_pairs as f64 / total_estimates as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };
    let telemetry = data_telemetry_status();
    let reference_database = reference_database_status(&paths.reference_database);
    let has_receiver_records = receiver_records["exists"].as_bool().unwrap_or(false)
        && receiver_records["lines"].as_u64().unwrap_or(0) > 0;

    json!({
        "dataDir": path_string(&paths.data_dir),
        "exists": paths.data_dir.exists(),
        "machine": {
            "hostname": hostname(),
            "platform": node_platform(),
            "arch": node_arch(),
        },
        "files": {
            "estimates": estimates,
            "actuals": actuals,
            "toolTelemetry": tool_telemetry,
            "receiverRecords": receiver_records,
            "receiverReceipts": receiver_receipts,
        },
        "feedback": {
            "totalEstimates": total_estimates,
            "totalActuals": total_actuals,
            "matchedPairs": matched_pairs,
            "matchRate": match_rate,
        },
        "telemetry": telemetry,
        "referenceDatabase": reference_database,
        "roleHints": {
            "hasReceiverRecords": has_receiver_records,
            "likelyReceiver": has_receiver_records,
        },
    })
}

fn file_status(path: &Path) -> Value {
    let exists = path.exists();
    json!({
        "path": path_string(path),
        "exists": exists,
        "lines": if exists { count_lines(path) } else { 0 },
    })
}

fn count_lines(path: &Path) -> usize {
    read_to_string(path)
        .map(|raw| raw.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or(0)
}

fn count_matched_pairs(estimates_path: &Path, actuals_path: &Path) -> usize {
    let Ok(raw_estimates) = read_to_string(estimates_path) else {
        return 0;
    };
    let estimate_ids = raw_estimates
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<std::collections::BTreeSet<_>>();
    if estimate_ids.is_empty() {
        return 0;
    }

    let Ok(raw_actuals) = read_to_string(actuals_path) else {
        return 0;
    };
    raw_actuals
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            value
                .get("estimateId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|id| estimate_ids.contains(id))
        .count()
}

fn data_telemetry_status() -> Value {
    let config = load_config();
    let queued_records =
        extract_anonymized_records_from_epoch_data(config.telemetry.last_submission_at.as_deref())
            .map(|records| records.len())
            .unwrap_or(0);
    json!({
        "enabled": config.telemetry.enabled,
        "endpointConfigured": is_usable_telemetry_endpoint(&config.telemetry.endpoint),
        "queuedRecords": queued_records,
        "lastSubmissionAt": config.telemetry.last_submission_at,
        "totalRecordsAccepted": config.telemetry.total_records_accepted,
        "totalRecordsDeduplicated": config.telemetry.total_records_deduplicated,
    })
}

fn reference_database_status(local_path: &Path) -> Value {
    let local_exists = local_path.exists();
    let db = if local_exists {
        read_reference_database(local_path)
    } else if let Some(user_path) = user_reference_database_path().filter(|path| path.exists()) {
        read_reference_database(&user_path)
    } else {
        epoch_data::bundled_reference_database().ok()
    };

    let Some(db) = db else {
        return json!({
            "loaded": false,
            "path": path_string(local_path),
            "source": Value::Null,
            "sampleSize": Value::Null,
            "generatedAt": Value::Null,
        });
    };

    json!({
        "loaded": true,
        "path": if local_exists { path_string(local_path) } else { "(bundled)".to_string() },
        "source": db.get("source").cloned().unwrap_or(Value::Null),
        "sampleSize": db.get("sampleSize").cloned().unwrap_or(Value::Null),
        "generatedAt": db.get("generatedAt").cloned().unwrap_or(Value::Null),
    })
}

fn read_reference_database(path: &Path) -> Option<Value> {
    read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

fn user_reference_database_path() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(".epoch").join(REFERENCE_DATABASE_FILE))
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env::var("COMPUTERNAME")
                .or_else(|_| env::var("HOSTNAME"))
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default()
}

fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        other => other,
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
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
        COMMUNITY_EXPORT_EMPTY_MESSAGE, cli_command_paths, cli_tool_commands, command_to_tool,
        crate_label, run_cli_command, run_cli_json,
    };
    use epoch_mcp::RustToolDispatcher;
    use serde_json::{Value, json};
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
        assert_eq!(data["dataDir"], data_dir.to_string_lossy().as_ref());
        assert_eq!(data["exists"], true);
        assert_eq!(data["files"]["estimates"]["lines"], 0);
        assert_eq!(data["feedback"]["totalEstimates"], 0);
        assert_eq!(data["telemetry"]["queuedRecords"], 0);
        assert_eq!(data["referenceDatabase"]["loaded"], true);
        assert_eq!(data["referenceDatabase"]["path"], "(bundled)");

        let data_where =
            run_cli_command(&mut dispatcher, "data where", json!({})).expect("data where runs");
        assert_eq!(data_where["dataDir"], data_dir.to_string_lossy().as_ref());
        assert_eq!(
            data_where["receiverDedupeKeys"],
            data_dir
                .join("telemetry-record-keys.jsonl")
                .to_string_lossy()
                .as_ref()
        );

        let share =
            run_cli_command(&mut dispatcher, "share-data", json!({})).expect("share-data runs");
        assert_eq!(share["ok"], false);
        assert_eq!(share["message"], COMMUNITY_EXPORT_EMPTY_MESSAGE);
        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn share_data_writes_typescript_compatible_community_export() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("share-data-export");
        set_epoch_data_dir(&data_dir);
        write_community_feedback_fixture(&data_dir);
        let output = data_dir.join("community-export.json");
        let mut dispatcher = RustToolDispatcher::new();

        let result = run_cli_command(
            &mut dispatcher,
            "share-data",
            json!({
                "output": output.to_string_lossy(),
                "description": "Test community export",
                "validate": true,
            }),
        )
        .expect("share-data export runs");

        assert_eq!(result["ok"], true);
        assert_eq!(result["path"], output.to_string_lossy().as_ref());
        assert_eq!(result["recordCount"], 1);
        assert_eq!(result["skipped"]["missingComplexity"], 1);
        assert_eq!(result["skipped"]["invalidTaskType"], 1);
        assert_eq!(result["skipped"]["invalidHours"], 0);
        assert_eq!(result["schema"], "estimation-record");
        assert_eq!(result["validated"], true);
        assert_eq!(result["nextSteps"].as_array().expect("next steps").len(), 4);

        let raw = read_to_string(&output).expect("export file written");
        let dataset: Value = serde_json::from_str(&raw).expect("export json parses");
        assert_eq!(dataset["_schema"], "estimation-record");
        assert_eq!(dataset["description"], "Test community export");
        let record = &dataset["records"][0];
        assert_eq!(record["estimated_hours"], 4.0);
        assert_eq!(record["actual_hours"], 5.0);
        assert_eq!(record["task_type"], "feature");
        assert_eq!(record["complexity"], 3);
        assert_eq!(record["timestamp"], "2026-05-07T00:00:00Z");
        assert_eq!(
            record["contributor_id"]
                .as_str()
                .expect("pseudonymous contributor id")
                .len(),
            16
        );
        assert!(record.get("tool").is_none());
        assert!(record.get("ratio").is_none());
        assert!(record.get("completed_at").is_none());

        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn share_data_returns_typescript_compatible_error_when_empty() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("share-data-empty");
        set_epoch_data_dir(&data_dir);
        let output = data_dir.join("community-export.json");
        let mut dispatcher = RustToolDispatcher::new();

        let result = run_cli_command(
            &mut dispatcher,
            "share-data",
            json!({ "output": output.to_string_lossy() }),
        )
        .expect("share-data empty result is a compatibility payload");

        assert_eq!(result["ok"], false);
        assert_eq!(
            result["message"],
            "No exportable records found. Use Epoch for a few tasks with actual-hour feedback, then run this again."
        );
        assert!(!output.exists());

        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn self_improve_writes_typescript_compatible_reference_database() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("self-improve-reference-db");
        set_epoch_data_dir(&data_dir);
        write_reference_database_fixture(&data_dir);
        write_self_improve_feedback_fixture(&data_dir);
        let mut dispatcher = RustToolDispatcher::new();

        let result =
            run_cli_command(&mut dispatcher, "self-improve", json!({})).expect("self-improve runs");

        assert_eq!(result["ok"], true);
        assert_eq!(result["message"], "Self-improvement complete.");

        let raw = read_to_string(data_dir.join("reference-database.json"))
            .expect("reference database written");
        let db: Value = serde_json::from_str(&raw).expect("reference database json parses");
        assert_eq!(db["source"], "self-improvement");
        assert_eq!(db["sampleSize"], 105);
        assert_eq!(db["globalCorrectionFactor"], 1.5);
        assert_eq!(db["taskTypeCorrectionFactors"]["feature"], 1.5);
        assert_eq!(
            db["toolTaskCorrectionFactors"]["pert_estimate"]["feature"],
            1.5
        );
        assert_eq!(db["complexityCorrectionFactors"]["feature"]["3"], 1.5);
        assert!(
            db["generatedAt"].as_str().is_some_and(|value| {
                value != "2026-01-01T00:00:00.000Z" && value.ends_with('Z')
            })
        );

        clear_epoch_env();
        let _ = remove_dir_all(data_dir);
    }

    #[test]
    fn self_improve_merges_received_telemetry_and_tool_stats_like_typescript() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("self-improve-telemetry");
        set_epoch_data_dir(&data_dir);
        write_reference_database_with_tool_benchmark_fixture(&data_dir);
        write_self_improve_receiver_and_tool_telemetry_fixture(&data_dir);
        let mut dispatcher = RustToolDispatcher::new();

        let result =
            run_cli_command(&mut dispatcher, "self-improve", json!({})).expect("self-improve runs");

        assert_eq!(result["ok"], true);
        let raw = read_to_string(data_dir.join("reference-database.json"))
            .expect("reference database written");
        let db: Value = serde_json::from_str(&raw).expect("reference database json parses");
        assert_eq!(db["sampleSize"], 108);
        assert_eq!(db["globalCorrectionFactor"], 1.6);
        assert_eq!(db["taskTypeCorrectionFactors"]["feature"], 1.6);
        assert_eq!(
            db["toolTaskCorrectionFactors"]["reference_class_estimate"]["feature"],
            1.6
        );
        assert_eq!(db["complexityCorrectionFactors"]["feature"]["3"], 1.6);

        let benchmark = &db["toolExecutionBenchmarks"]["test-tool"];
        assert_eq!(benchmark["p50_ms"], 132.31);
        assert_eq!(benchmark["p95_ms"], 523.08);
        assert_eq!(benchmark["mean_ms"], 227.69);
        assert_eq!(benchmark["stddev_ms"], 178.41);
        assert_eq!(benchmark["min_ms"], 50);
        assert_eq!(benchmark["max_ms"], 900);
        assert_eq!(benchmark["sampleCount"], 13);

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
    fn telemetry_submit_interval_values_are_typescript_lazy() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let data_dir = temp_data_dir("telemetry-submit-interval-lazy");
        set_epoch_data_dir(&data_dir);
        let mut dispatcher = RustToolDispatcher::new();

        let disabled = run_cli_command(
            &mut dispatcher,
            "telemetry submit",
            json!({ "min_interval_hours": "not-a-number" }),
        )
        .expect("invalid interval preserves disabled guard");
        assert_eq!(disabled["ok"], false);
        assert_eq!(disabled["error"], "telemetry not enabled");

        run_cli_command(
            &mut dispatcher,
            "telemetry enable",
            json!({ "endpoint": "https://collector.example.net/v1/telemetry" }),
        )
        .expect("enable telemetry");

        let no_records = run_cli_command(
            &mut dispatcher,
            "telemetry submit",
            json!({ "min_interval_hours": "-1" }),
        )
        .expect("negative interval preserves no-records guard");
        assert_eq!(no_records["ok"], false);
        assert_eq!(no_records["error"], "no new records to submit");

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
        assert_eq!(
            raw,
            concat!(
                "[\n",
                "  {\n",
                "    \"task_type\": \"feature\",\n",
                "    \"complexity\": 3,\n",
                "    \"tool\": \"pert_estimate\",\n",
                "    \"estimated_hours\": 4,\n",
                "    \"actual_hours\": 5,\n",
                "    \"ratio\": 1.25,\n",
                "    \"date\": \"2026-05-07\",\n",
                "    \"completed_at\": \"2026-05-07T00:00:00.000Z\"\n",
                "  }\n",
                "]"
            )
        );
        assert!(data_dir.join("exports").exists());

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

    fn write_community_feedback_fixture(data_dir: &PathBuf) {
        write(
            data_dir.join("estimates.jsonl"),
            concat!(
                r#"{"id":"real-1","tool":"pert_estimate","inputs":{"task_type":"feature","complexity":3},"outputs":{"expected":4,"unit":"hours"},"estimatedAt":"2026-05-06T00:00:00.000Z"}"#,
                "\n",
                r#"{"id":"real-2","tool":"pert_estimate","inputs":{"task_type":"invalid_type","complexity":2},"outputs":{"expected":2,"unit":"hours"},"estimatedAt":"2026-05-06T00:00:00.000Z"}"#,
                "\n",
                r#"{"id":"real-3","tool":"pert_estimate","inputs":{"task_type":"bugfix"},"outputs":{"expected":3,"unit":"hours"},"estimatedAt":"2026-05-06T00:00:00.000Z"}"#,
                "\n"
            ),
        )
        .expect("community estimate fixture");
        write(
            data_dir.join("feedback.jsonl"),
            concat!(
                r#"{"estimateId":"real-1","actualHours":5,"reportedAt":"2026-05-07T00:00:00.000Z","completedAt":"2026-05-07T00:00:00.000Z"}"#,
                "\n",
                r#"{"estimateId":"real-2","actualHours":3,"reportedAt":"2026-05-08T00:00:00.000Z","completedAt":"2026-05-08T00:00:00.000Z"}"#,
                "\n",
                r#"{"estimateId":"real-3","actualHours":4,"reportedAt":"2026-05-09T00:00:00.000Z","completedAt":"2026-05-09T00:00:00.000Z"}"#,
                "\n"
            ),
        )
        .expect("community actual fixture");
    }

    fn write_reference_database_fixture(data_dir: &PathBuf) {
        let db = json!({
            "version": "1.0.0",
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "source": "test",
            "sampleSize": 100,
            "description": "test db",
            "toolExecutionBenchmarks": {},
            "modelLatencyProfiles": {},
            "estimationAccuracy": {
                "taskTypes": {},
                "correctionFactors": {
                    "byTaskType": {},
                    "global": 1.07
                }
            },
            "taskTypeCorrectionFactors": {},
            "toolTaskCorrectionFactors": {},
            "complexityCorrectionFactors": {},
            "tokenTimeCalibration": {},
            "globalCorrectionFactor": 1.07
        });
        write(
            data_dir.join("reference-database.json"),
            serde_json::to_string_pretty(&db).expect("reference db fixture json"),
        )
        .expect("reference db fixture");
    }

    fn write_reference_database_with_tool_benchmark_fixture(data_dir: &PathBuf) {
        let db = json!({
            "version": "1.0.0",
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "source": "test",
            "sampleSize": 100,
            "description": "test db",
            "toolExecutionBenchmarks": {
                "test-tool": {
                    "p50_ms": 100,
                    "p95_ms": 500,
                    "mean_ms": 200,
                    "stddev_ms": 50,
                    "min_ms": 50,
                    "max_ms": 800,
                    "sampleCount": 10
                }
            },
            "modelLatencyProfiles": {},
            "estimationAccuracy": {
                "taskTypes": {},
                "correctionFactors": {
                    "byTaskType": {},
                    "global": 1.07
                }
            },
            "taskTypeCorrectionFactors": {},
            "toolTaskCorrectionFactors": {},
            "complexityCorrectionFactors": {},
            "tokenTimeCalibration": {},
            "globalCorrectionFactor": 1.07
        });
        write(
            data_dir.join("reference-database.json"),
            serde_json::to_string_pretty(&db).expect("reference db fixture json"),
        )
        .expect("reference db fixture");
    }

    fn write_self_improve_feedback_fixture(data_dir: &PathBuf) {
        write(
            data_dir.join("estimates.jsonl"),
            concat!(
                r#"{"id":"real-si-1","tool":"pert_estimate","inputs":{"task_type":"feature","complexity":3},"outputs":{"expected":10,"unit":"hours"},"estimatedAt":"2026-04-01T00:00:00.000Z"}"#,
                "\n",
                r#"{"id":"real-si-2","tool":"pert_estimate","inputs":{"task_type":"feature","complexity":3},"outputs":{"expected":10,"unit":"hours"},"estimatedAt":"2026-04-02T00:00:00.000Z"}"#,
                "\n",
                r#"{"id":"real-si-3","tool":"pert_estimate","inputs":{"task_type":"feature","complexity":3},"outputs":{"expected":10,"unit":"hours"},"estimatedAt":"2026-04-03T00:00:00.000Z"}"#,
                "\n",
                r#"{"id":"real-si-4","tool":"pert_estimate","inputs":{"task_type":"feature","complexity":3},"outputs":{"expected":10,"unit":"hours"},"estimatedAt":"2026-04-04T00:00:00.000Z"}"#,
                "\n",
                r#"{"id":"real-si-5","tool":"pert_estimate","inputs":{"task_type":"feature","complexity":3},"outputs":{"expected":10,"unit":"hours"},"estimatedAt":"2026-04-05T00:00:00.000Z"}"#,
                "\n",
                r#"{"id":"real-si-baseline","tool":"pert_estimate","inputs":{"task_type":"feature","complexity":3},"outputs":{"expected":10,"unit":"hours"},"estimatedAt":"2026-04-06T00:00:00.000Z"}"#,
                "\n"
            ),
        )
        .expect("self-improve estimates fixture");
        write(
            data_dir.join("feedback.jsonl"),
            concat!(
                r#"{"estimateId":"real-si-1","actualHours":12,"reportedAt":"2026-04-02T00:00:00.000Z","completedAt":"2026-04-02T00:00:00.000Z"}"#,
                "\n",
                r#"{"estimateId":"real-si-2","actualHours":14,"reportedAt":"2026-04-03T00:00:00.000Z","completedAt":"2026-04-03T00:00:00.000Z"}"#,
                "\n",
                r#"{"estimateId":"real-si-3","actualHours":15,"reportedAt":"2026-04-04T00:00:00.000Z","completedAt":"2026-04-04T00:00:00.000Z"}"#,
                "\n",
                r#"{"estimateId":"real-si-4","actualHours":16,"reportedAt":"2026-04-05T00:00:00.000Z","completedAt":"2026-04-05T00:00:00.000Z"}"#,
                "\n",
                r#"{"estimateId":"real-si-5","actualHours":18,"reportedAt":"2026-04-06T00:00:00.000Z","completedAt":"2026-04-06T00:00:00.000Z"}"#,
                "\n",
                r#"{"estimateId":"real-si-baseline","actualHours":30,"notes":"real data calibration backfill","reportedAt":"2026-04-07T00:00:00.000Z","completedAt":"2026-04-07T00:00:00.000Z"}"#,
                "\n"
            ),
        )
        .expect("self-improve actuals fixture");
    }

    fn write_self_improve_receiver_and_tool_telemetry_fixture(data_dir: &PathBuf) {
        write(
            data_dir.join("telemetry-records.jsonl"),
            concat!(
                r#"{"task_type":"feature","complexity":3,"tool":"reference_class_estimate","estimated_hours":10,"actual_hours":12,"ratio":1.2,"date":"2026-04-01","received_at":"2026-04-01T00:00:00.000Z"}"#,
                "\n",
                r#"{"task_type":"feature","complexity":3,"tool":"reference_class_estimate","estimated_hours":10,"actual_hours":14,"ratio":1.4,"date":"2026-04-02","received_at":"2026-04-02T00:00:00.000Z"}"#,
                "\n",
                r#"{"task_type":"feature","complexity":3,"tool":"reference_class_estimate","estimated_hours":10,"actual_hours":16,"ratio":1.6,"date":"2026-04-03","received_at":"2026-04-03T00:00:00.000Z"}"#,
                "\n",
                r#"{"task_type":"feature","complexity":3,"tool":"reference_class_estimate","estimated_hours":10,"actual_hours":18,"ratio":1.8,"date":"2026-04-04","received_at":"2026-04-04T00:00:00.000Z"}"#,
                "\n",
                r#"{"task_type":"feature","complexity":3,"tool":"reference_class_estimate","estimated_hours":10,"actual_hours":20,"ratio":2,"date":"2026-04-05","received_at":"2026-04-05T00:00:00.000Z"}"#,
                "\n"
            ),
        )
        .expect("receiver telemetry fixture");
        write(
            data_dir.join("telemetry.jsonl"),
            concat!(
                r#"{"timestamp":"2026-06-20T00:00:00.000Z","tool":"test-tool","inputHash":"h0","outputOk":true,"elapsedMs":120}"#,
                "\n",
                r#"{"timestamp":"2026-06-21T00:00:00.000Z","tool":"test-tool","inputHash":"h1","outputOk":true,"elapsedMs":240}"#,
                "\n",
                r#"{"timestamp":"2026-06-22T00:00:00.000Z","tool":"test-tool","inputHash":"h2","outputOk":true,"elapsedMs":600}"#,
                "\n"
            ),
        )
        .expect("tool telemetry fixture");
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
