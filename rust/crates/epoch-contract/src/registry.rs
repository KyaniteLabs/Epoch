use serde::{Deserialize, Serialize};

pub const PACKAGE_NAME: &str = "@kyanitelabs/epoch";

pub const READ_ONLY_ANNOTATIONS: ToolAnnotations = ToolAnnotations {
    read_only_hint: true,
    destructive_hint: false,
    idempotent_hint: true,
    open_world_hint: false,
};

pub const WRITE_ANNOTATIONS: ToolAnnotations = ToolAnnotations {
    read_only_hint: false,
    destructive_hint: false,
    idempotent_hint: false,
    open_world_hint: false,
};

pub const ESTIMATE_HOUR_FIELDS: &[&str] = &[
    "expected",
    "totalHours",
    "estimatedHours",
    "estimatedMinutes",
    "estimatedSeconds",
    "personMonthsLlmAdjusted",
    "correctedEstimate",
    "total_duration",
];

pub const HTTP_ROUTES: &[&str] = &[
    "GET /health",
    "GET /v1/tools",
    "POST /v1/tools/:toolName",
    "POST /v1/telemetry",
    "GET /.well-known/ai-plugin.json",
    "GET /llms.txt",
    "GET /openapi.json",
    "POST /v1/feedback/record-actual",
    "GET /v1/feedback/pending",
    "POST /v1/feedback/batch-record-actuals",
    "GET /v1/feedback/health",
];

pub const CLI_COMMAND_PATHS: &[&str] = &[
    "get-current-time",
    "convert-timezone",
    "parse-duration",
    "time-math",
    "add-business-days",
    "count-business-days",
    "pert-estimate",
    "cocomo-estimate",
    "sprint-forecast",
    "critical-path",
    "monte-carlo-schedule",
    "reference-class-estimate",
    "calibrate-estimates",
    "token-time-bridge",
    "token-cost-estimate",
    "compare-models",
    "accuracy-trend",
    "schedule-risk",
    "cocomo-validate",
    "record-actual",
    "get-pending-estimates",
    "batch-record-actuals",
    "feedback-health",
    "cocomo-ground-truth",
    "self-improve",
    "telemetry",
    "telemetry status",
    "telemetry preview",
    "telemetry export",
    "telemetry enable",
    "telemetry set-endpoint",
    "telemetry submit",
    "telemetry disable",
    "telemetry delete-data",
    "share-data",
    "data",
    "data where",
    "data status",
    "list-tools",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    pub read_only_hint: bool,
    pub destructive_hint: bool,
    pub idempotent_hint: bool,
    pub open_world_hint: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCategory {
    Temporal,
    Estimation,
    Analytics,
    Cost,
    Risk,
    Validation,
    Feedback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolMetadata {
    pub name: &'static str,
    pub description: &'static str,
    pub category: ToolCategory,
    pub input_schema: &'static str,
    pub output_schema: &'static str,
    pub cli_command: &'static str,
    pub direct_http_route: Option<&'static str>,
    pub annotations: ToolAnnotations,
    pub feedback_ref_candidate: bool,
}

pub const TOOL_REGISTRY: &[ToolMetadata] = &[
    ToolMetadata {
        name: "get_current_time",
        description: "Returns the current date and time in an IANA timezone.",
        category: ToolCategory::Temporal,
        input_schema: "getCurrentTimeSchema",
        output_schema: "temporalOutput",
        cli_command: "get-current-time",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "convert_timezone",
        description: "Converts an ISO-8601 timestamp to a target IANA timezone.",
        category: ToolCategory::Temporal,
        input_schema: "convertTimezoneSchema",
        output_schema: "temporalOutput",
        cli_command: "convert-timezone",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "parse_duration",
        description: "Parses a human-readable duration string into structured seconds.",
        category: ToolCategory::Temporal,
        input_schema: "parseDurationSchema",
        output_schema: "durationOutput",
        cli_command: "parse-duration",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "time_math",
        description: "Performs compound time-math operations by dispatching to sub-operations.",
        category: ToolCategory::Temporal,
        input_schema: "timeMathSchema",
        output_schema: "timeMathOutput",
        cli_command: "time-math",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "add_business_days",
        description: "Adds business days to a date, skipping weekends and known holidays.",
        category: ToolCategory::Temporal,
        input_schema: "addBusinessDaysSchema",
        output_schema: "businessDayOutput",
        cli_command: "add-business-days",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "count_business_days",
        description: "Counts business days between two dates using supported holiday calendars.",
        category: ToolCategory::Temporal,
        input_schema: "countBusinessDaysSchema",
        output_schema: "businessDayOutput",
        cli_command: "count-business-days",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "pert_estimate",
        description: "Calculates PERT expected duration from optimistic, likely, and pessimistic inputs.",
        category: ToolCategory::Estimation,
        input_schema: "pertEstimateSchema",
        output_schema: "pertOutput",
        cli_command: "pert-estimate",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: true,
    },
    ToolMetadata {
        name: "cocomo_estimate",
        description: "Runs LLM-adapted COCOMO effort estimation.",
        category: ToolCategory::Estimation,
        input_schema: "cocomoEstimateSchema",
        output_schema: "cocomoOutput",
        cli_command: "cocomo-estimate",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: true,
    },
    ToolMetadata {
        name: "sprint_forecast",
        description: "Forecasts sprint completion from backlog size and velocity history.",
        category: ToolCategory::Estimation,
        input_schema: "sprintForecastSchema",
        output_schema: "sprintOutput",
        cli_command: "sprint-forecast",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: true,
    },
    ToolMetadata {
        name: "critical_path",
        description: "Computes critical path and slack with merge-bias adjustment.",
        category: ToolCategory::Estimation,
        input_schema: "criticalPathSchema",
        output_schema: "criticalPathOutput",
        cli_command: "critical-path",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: true,
    },
    ToolMetadata {
        name: "monte_carlo_schedule",
        description: "Runs Monte Carlo schedule simulation with seeded reproducibility.",
        category: ToolCategory::Estimation,
        input_schema: "monteCarloSchema",
        output_schema: "monteCarloOutput",
        cli_command: "monte-carlo-schedule",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: true,
    },
    ToolMetadata {
        name: "reference_class_estimate",
        description: "Applies historical/reference-class correction factors to an estimate.",
        category: ToolCategory::Analytics,
        input_schema: "referenceClassEstimateSchema",
        output_schema: "referenceClassOutput",
        cli_command: "reference-class-estimate",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: true,
    },
    ToolMetadata {
        name: "calibrate_estimates",
        description: "Recalculates team-specific correction factors from actuals.",
        category: ToolCategory::Analytics,
        input_schema: "calibrateEstimatesSchema",
        output_schema: "calibrateOutput",
        cli_command: "calibrate-estimates",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "token_time_bridge",
        description: "Maps LLM token budgets to estimated wall-clock time.",
        category: ToolCategory::Analytics,
        input_schema: "tokenTimeBridgeSchema",
        output_schema: "tokenTimeOutput",
        cli_command: "token-time-bridge",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: true,
    },
    ToolMetadata {
        name: "token_cost_estimate",
        description: "Estimates wall-clock time and dollar cost for LLM token usage.",
        category: ToolCategory::Cost,
        input_schema: "tokenCostEstimateSchema",
        output_schema: "tokenTimeOutput",
        cli_command: "token-cost-estimate",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: true,
    },
    ToolMetadata {
        name: "compare_models",
        description: "Compares supported LLM models for a token budget by time or cost.",
        category: ToolCategory::Cost,
        input_schema: "compareModelsSchema",
        output_schema: "modelComparisonOutput",
        cli_command: "compare-models",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "accuracy_trend",
        description: "Tracks estimation accuracy across sliding windows.",
        category: ToolCategory::Analytics,
        input_schema: "accuracyTrendSchema",
        output_schema: "accuracyTrendOutput",
        cli_command: "accuracy-trend",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "schedule_risk",
        description: "Assesses schedule risk using historical accuracy and confidence intervals.",
        category: ToolCategory::Risk,
        input_schema: "scheduleRiskSchema",
        output_schema: "scheduleRiskOutput",
        cli_command: "schedule-risk",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: true,
    },
    ToolMetadata {
        name: "cocomo_validate",
        description: "Validates COCOMO Basic against historical calibration datasets.",
        category: ToolCategory::Validation,
        input_schema: "cocomoValidateSchema",
        output_schema: "cocomoValidateOutput",
        cli_command: "cocomo-validate",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "cocomo_ground_truth",
        description: "Benchmarks all COCOMO and AI-adjusted models against ground-truth datasets.",
        category: ToolCategory::Validation,
        input_schema: "cocomoGroundTruthSchema",
        output_schema: "cocomoGroundTruthOutput",
        cli_command: "cocomo-ground-truth",
        direct_http_route: None,
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "record_actual",
        description: "Submits actual hours for a previous estimate.",
        category: ToolCategory::Feedback,
        input_schema: "recordActualSchema",
        output_schema: "recordActualOutput",
        cli_command: "record-actual",
        direct_http_route: Some("POST /v1/feedback/record-actual"),
        annotations: WRITE_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "get_pending_estimates",
        description: "Lists recent estimates that have not yet received actual-hour feedback.",
        category: ToolCategory::Feedback,
        input_schema: "getPendingEstimatesSchema",
        output_schema: "pendingEstimatesOutput",
        cli_command: "get-pending-estimates",
        direct_http_route: Some("GET /v1/feedback/pending"),
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "batch_record_actuals",
        description: "Records actual hours for multiple estimates in one call.",
        category: ToolCategory::Feedback,
        input_schema: "batchRecordActualsSchema",
        output_schema: "batchRecordActualsOutput",
        cli_command: "batch-record-actuals",
        direct_http_route: Some("POST /v1/feedback/batch-record-actuals"),
        annotations: WRITE_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
    ToolMetadata {
        name: "feedback_health",
        description: "Reports health and readiness of the estimation feedback loop.",
        category: ToolCategory::Feedback,
        input_schema: "feedbackHealthSchema",
        output_schema: "feedbackHealthOutput",
        cli_command: "feedback-health",
        direct_http_route: Some("GET /v1/feedback/health"),
        annotations: READ_ONLY_ANNOTATIONS,
        feedback_ref_candidate: false,
    },
];

pub fn tool_registry() -> &'static [ToolMetadata] {
    TOOL_REGISTRY
}

pub fn find_tool(name: &str) -> Option<&'static ToolMetadata> {
    TOOL_REGISTRY.iter().find(|tool| tool.name == name)
}

pub fn tool_names() -> Vec<String> {
    TOOL_REGISTRY
        .iter()
        .map(|tool| tool.name.to_string())
        .collect()
}

pub fn write_tool_names() -> Vec<String> {
    TOOL_REGISTRY
        .iter()
        .filter(|tool| tool.annotations == WRITE_ANNOTATIONS)
        .map(|tool| tool.name.to_string())
        .collect()
}

pub fn tool_cli_commands() -> Vec<String> {
    TOOL_REGISTRY
        .iter()
        .map(|tool| tool.cli_command.to_string())
        .collect()
}

pub fn tool_has_feedback_ref_candidate_output(name: &str) -> bool {
    find_tool(name).is_some_and(|tool| tool.feedback_ref_candidate)
}
