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
        description: "Returns the current date and time in the specified IANA timezone. Useful for grounding the LLM in the user's local time. Example timezones: 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'.",
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
        description: "Converts an ISO-8601 timestamp to a target IANA timezone. The input timestamp must include timezone information or be in UTC. Returns the localised time, UTC offset, and human-readable format.",
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
        description: "Parses a human-readable duration string into structured seconds. Supports combinations of y (years), mo (months), w (weeks), d (days), h (hours), m (minutes), s (seconds). Examples: '2h30m', '1d6h', '1w3d', '45m'.",
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
        description: "Performs compound time-math operations. Dispatches to the appropriate sub-operation based on the 'operation' parameter. Operations: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration. Use this for multi-step or dynamic time operations; for single-purpose calls use get_current_time, convert_timezone, parse_duration, add_business_days, or count_business_days.",
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
        description: "Adds N business (working) days to a start date, skipping weekends and country-specific public holidays. Supports US, UK, FR, DE, and JP holidays.",
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
        description: "Counts the number of business (working) days between two dates, excluding weekends and country-specific public holidays. The count is exclusive of the start date and inclusive of the end date.",
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
        description: "Calculate PERT expected duration from three-point estimates using Beta distribution.\n\nFormula: E = (O + 4M + P) / 6. Returns expected value, variance, standard deviation,\nand 95%/99% confidence bounds with urgency categorization.\nUse when estimating task duration with uncertain outcomes.",
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
        description: "LLM-adapted COCOMO II parametric effort estimation.\n\nReplaces traditional 17 human-labor cost drivers with 5 LLM-specific factors:\nreasoning complexity, context completeness, transformation impact, iterative cycles,\nand human oversight. Returns both nominal and LLM-adjusted person-months.",
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
        description: "Forecast sprint completion date from backlog size and historical velocity.\n\nComputes average velocity from sprint history, converts story points to hours,\nand returns required sprints with pessimistic estimate based on velocity variance.",
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
        description: "Compute critical path with merge-bias adjustment for project schedules.\n\nPerforms forward/backward pass to identify critical tasks and slack.\nApplies merge bias: tasks with >2 predecessors get 5% duration increase per extra predecessor.",
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
        description: "Run Monte Carlo simulation for probabilistic schedule risk analysis.\n\nSamples task durations from triangular distributions and returns P10/P50/P80/P95\ncompletion estimates with identified risk events. Use seed for reproducible results.",
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
        description: "Data-driven estimate using reference class forecasting.\n\nApplies historical correction factors based on actual-vs-estimated ratios.\nWhen no historical data exists, uses industry averages (1.3-2.2x for software tasks).\nPrioritize this over algorithmic models when historical data is available.",
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
        description: "Recalculate team-specific correction factors from historical estimation data.\n\nCompares estimated vs actual hours to compute a correction multiplier.\nRequires PM system integration for best results. Returns recommendations\nfor improving estimation accuracy.",
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
        description: "Map LLM token budgets to estimated wall-clock time.\n\nUses model-specific calibration data (tokens/second, reasoning overhead,\ntool-call latency) to estimate how long a task will actually take.\nBridges the gap between token-space (how agents reason) and time-space (what humans need).\nUse token_cost_estimate instead when dollar cost matters too.",
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
        description: "Estimate wall-clock time AND dollar cost for LLM token usage.\n\nCombines token-to-time mapping with model-specific pricing data.\nReturns cost breakdown (input/output/overhead) alongside the time estimate.\nUse token_time_bridge when you only need wall-clock time and not dollar cost.",
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
        description: "Compare all LLM models side-by-side for a given token budget.\n\nRanks models by estimated cost or time. Shows quality tier for each model.\nUse when choosing which model to use for a task.",
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
        description: "Track estimation accuracy improvement over time.\n\nComputes sliding-window MAPE and compares against industry baseline (25%).\nShows whether your estimates are improving, degrading, or stable.\nIndustry research shows estimation accuracy does NOT improve with experience (Cao 2022) \u{2014} self-correcting systems like Epoch can buck this trend.",
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
        description: "Assess schedule risk for an estimate using historical accuracy data.\n\nComputes confidence intervals (p50/p80/p95) based on your team's MAPE.\nReturns risk level and actionable recommendations.\nUses industry baseline (25% MAPE) when no historical data is available.",
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
        description: "Validate COCOMO estimation model against 195 real historical projects.\n\nRuns the COCOMO Basic formula against projects from NASA93, COCOMO81, Albrecht, and Kemerer datasets.\nReports overall MAPE, bias, per-type accuracy, and recommended coefficient adjustments.\nUse cocomo_ground_truth for the full multi-model benchmark across all COCOMO and AI-adjusted models.",
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
        description: "Validate all COCOMO estimation models against 240 real historical projects with known effort.\n\nRuns 6 models in parallel: COCOMO Basic, COCOMO II Nominal, COCOMO II + AI 12x speedup, and AI + developer profile at human/hybrid/ai_native gradients.\nReports MAPE, MMRE, PRED(25), PRED(50), bias per model, with breakdowns by dataset and project type.\nUse cocomo_validate for a quicker Basic COCOMO-only validation pass.",
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
        description: "Submit actual hours for a previous estimate to improve future accuracy.\n\nPairs with any estimation tool. The estimate_id comes from the estimate response.\nActuals feed into the self-improvement loop \u{2014} after enough samples, correction factors\nupdate automatically to reduce estimation bias.",
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
        description: "List recent estimates that have not yet received actual-hour feedback.\n\nReturns estimates awaiting actuals so you can submit feedback via record_actual.\nUse this to close the estimation feedback loop and improve accuracy over time.",
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
        description: "Record actual hours for multiple estimates in a single call.\n\nEfficient for bulk feedback submission \u{2014} accepts 1 to 500 entries at once.\nEach entry pairs an estimate ID with the actual hours spent.",
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
        description: "Get a health report on the estimation feedback loop.\n\nShows total estimates, actuals, match rate, MAPE by tool and task type,\nand self-improvement readiness (which types have enough data for auto-calibration).",
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
