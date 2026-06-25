use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub mod registry;
pub use registry::{
    CLI_COMMAND_PATHS, ESTIMATE_HOUR_FIELDS, HTTP_ROUTES, PACKAGE_NAME, READ_ONLY_ANNOTATIONS,
    TOOL_REGISTRY, ToolAnnotations, ToolCategory, ToolMetadata, WRITE_ANNOTATIONS, find_tool,
    tool_cli_commands, tool_has_feedback_ref_candidate_output, tool_names, tool_registry,
    write_tool_names,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PublicSurfaceContract {
    pub package_name: String,
    pub mcp_tool_names: Vec<String>,
    pub write_tool_names: Vec<String>,
    pub http_routes: Vec<String>,
    pub cli_command_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolError {
    pub is_error: bool,
    pub message: String,
    pub retry_hint: Option<String>,
}

impl ToolError {
    pub fn new(message: impl Into<String>, retry_hint: impl Into<String>) -> Self {
        Self {
            is_error: true,
            message: message.into(),
            retry_hint: Some(retry_hint.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalResult {
    pub iso: String,
    pub human_readable: String,
    pub timezone: String,
    pub utc_offset: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DurationResult {
    pub input: String,
    pub total_seconds: f64,
    pub human_readable: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DateDiffResult {
    pub days: i64,
    pub hours: i64,
    pub minutes: i64,
    pub total_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BusinessDayResult {
    pub start_date: String,
    pub end_date: String,
    pub business_days: i64,
    pub country_code: String,
    pub human_readable: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TimeUnit {
    Hours,
    Days,
    Weeks,
    Months,
}

impl TimeUnit {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hours => "hours",
            Self::Days => "days",
            Self::Weeks => "weeks",
            Self::Months => "months",
        }
    }

    pub fn to_hours(self, value: f64) -> f64 {
        match self {
            Self::Hours => value,
            Self::Days => value * 8.0,
            Self::Weeks => value * 40.0,
            Self::Months => value * 160.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UrgencyCategory {
    Short,
    Medium,
    Long,
}

impl UrgencyCategory {
    pub fn from_hours(hours: f64) -> Self {
        if hours < 2.0 {
            Self::Short
        } else if hours <= 48.0 {
            Self::Medium
        } else {
            Self::Long
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Short => "short",
            Self::Medium => "medium",
            Self::Long => "long",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl RiskLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SprintConfidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SpeedupCategory {
    Moderate,
    Significant,
    Extreme,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PertResult {
    pub optimistic: f64,
    pub most_likely: f64,
    pub pessimistic: f64,
    pub expected: f64,
    pub variance: f64,
    pub std_deviation: f64,
    pub confidence_95: [f64; 2],
    pub confidence_99: [f64; 2],
    pub unit: TimeUnit,
    pub urgency_category: UrgencyCategory,
    pub risk_level: RiskLevel,
    pub human_readable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EffortMultipliers {
    pub reasoning_complexity: f64,
    pub context_completeness: f64,
    pub transformation_impact: f64,
    pub iterative_cycles: f64,
    pub human_oversight: f64,
    pub product: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CocomoResult {
    pub kloc: f64,
    pub person_months_nominal: f64,
    pub person_months_llm_adjusted: f64,
    pub effort_multipliers: EffortMultipliers,
    pub assumptions: Vec<String>,
    pub ai_speedup: f64,
    pub speedup_category: SpeedupCategory,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SprintForecastResult {
    pub backlog_points: f64,
    pub average_velocity: f64,
    pub required_sprints: f64,
    pub optimistic_sprints: f64,
    pub pessimistic_sprints: f64,
    pub hours_per_point: f64,
    pub total_hours: f64,
    pub completion_days: i64,
    pub sprint_length_days: f64,
    pub confidence: SprintConfidence,
    pub velocity_cv: f64,
    pub estimated_token_cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CpmTask {
    pub name: String,
    pub duration: f64,
    pub predecessors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CpmResult {
    pub critical_path: Vec<String>,
    pub slack_per_task: BTreeMap<String, f64>,
    pub total_duration: f64,
    pub merge_bias_adjustment: f64,
    #[serde(rename = "estimatedHours")]
    pub estimated_hours: f64,
    #[serde(rename = "estimatedTokenCost")]
    pub estimated_token_cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MonteCarloTask {
    pub name: String,
    pub optimistic: f64,
    pub most_likely: f64,
    pub pessimistic: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RiskEvent {
    pub description: String,
    pub probability: f64,
    pub impact_days: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MonteCarloResult {
    pub p10: String,
    pub p50: String,
    pub p80: String,
    pub p95: String,
    pub estimated_hours: f64,
    pub estimated_cost: f64,
    pub critical_path_probability: f64,
    pub converged: bool,
    pub risk_events: Vec<RiskEvent>,
    pub human_readable: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConfidenceLevel {
    Likely,
    Optimistic,
    Pessimistic,
}

impl ConfidenceLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Likely => "likely",
            Self::Optimistic => "optimistic",
            Self::Pessimistic => "pessimistic",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningDepth {
    Shallow,
    Moderate,
    Deep,
}

impl ReasoningDepth {
    pub fn multiplier(self) -> f64 {
        match self {
            Self::Shallow => 1.0,
            Self::Moderate => 2.5,
            Self::Deep => 5.0,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shallow => "shallow",
            Self::Moderate => "moderate",
            Self::Deep => "deep",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum QualityTier {
    Fast,
    Standard,
    Premium,
}

impl QualityTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Standard => "standard",
            Self::Premium => "premium",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenTimeBreakdown {
    pub prompt_tokens: f64,
    pub completion_tokens: f64,
    pub tool_overhead_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenTimeMapping {
    pub tokens: f64,
    pub model: String,
    pub estimated_seconds: f64,
    pub estimated_minutes: f64,
    pub confidence: ConfidenceLevel,
    pub urgency: UrgencyCategory,
    pub breakdown: TokenTimeBreakdown,
    pub human_readable: String,
    pub estimated_token_cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenCostBreakdown {
    pub input_cost: f64,
    pub output_cost: f64,
    pub tool_call_overhead_cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenCostEstimate {
    pub tokens: f64,
    pub model: String,
    pub estimated_seconds: f64,
    pub estimated_minutes: f64,
    pub estimated_cost: f64,
    pub cost_breakdown: TokenCostBreakdown,
    pub time_breakdown: TokenTimeBreakdown,
    pub confidence: ConfidenceLevel,
    pub urgency: UrgencyCategory,
    pub human_readable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelComparisonEntry {
    pub model: String,
    pub estimated_seconds: f64,
    pub estimated_minutes: f64,
    pub estimated_cost: f64,
    pub cost_available: bool,
    pub quality_tier: QualityTier,
    pub tokens_per_second: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelComparison {
    pub tokens: f64,
    pub models: Vec<ModelComparisonEntry>,
    pub sort_by: String,
    pub human_readable: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TaskType {
    Feature,
    Bugfix,
    Refactor,
    Migration,
    Infrastructure,
    Documentation,
    Testing,
    Design,
}

impl TaskType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Feature => "feature",
            Self::Bugfix => "bugfix",
            Self::Refactor => "refactor",
            Self::Migration => "migration",
            Self::Infrastructure => "infrastructure",
            Self::Documentation => "documentation",
            Self::Testing => "testing",
            Self::Design => "design",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScopeSignal {
    Small,
    Medium,
    Large,
    Xl,
}

impl ScopeSignal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
            Self::Xl => "xl",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AccuracyTrendDirection {
    Improving,
    Degrading,
    Stable,
}

impl AccuracyTrendDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Improving => "improving",
            Self::Degrading => "degrading",
            Self::Stable => "stable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccuracyMetrics {
    pub mape: f64,
    pub mdape: f64,
    pub capped_mdape: f64,
    pub bias: f64,
    pub variance: f64,
    #[serde(rename = "sample_size")]
    pub sample_size: usize,
    pub trend: AccuracyTrendDirection,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceClassEstimate {
    pub raw_estimate: f64,
    pub corrected_estimate: f64,
    pub correction_factor: f64,
    pub sample_size: usize,
    pub baseline_source: String,
    pub scope_used: ScopeSignal,
    pub scope_inferred: bool,
    pub confidence: ConfidenceLevel,
    pub estimated_token_cost: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationResult {
    pub correction_factor: f64,
    pub accuracy_trend: AccuracyTrendDirection,
    pub velocity_trend: String,
    pub recommendations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccuracyWindow {
    pub period: String,
    pub date_range: Option<String>,
    pub mape: f64,
    pub mdape: f64,
    pub bias: f64,
    pub sample_size: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccuracyTrend {
    pub windows: Vec<AccuracyWindow>,
    pub overall_trend: AccuracyTrendDirection,
    pub current_mape: f64,
    pub industry_baseline_mape: f64,
    pub improvement_vs_industry: f64,
    pub total_estimates: usize,
    pub total_with_actuals: usize,
    pub human_readable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CocomoProject {
    pub id: u32,
    #[serde(default, deserialize_with = "nullable_f64")]
    pub kloc: f64,
    #[serde(default, deserialize_with = "nullable_f64")]
    pub effort_person_months: f64,
    #[serde(rename = "type")]
    pub project_type: Option<String>,
    pub language: Option<String>,
    pub year: Option<u32>,
    pub category: Option<String>,
    pub function_points: Option<f64>,
    pub effort_work_hours: Option<f64>,
    pub duration_months: Option<f64>,
}

fn nullable_f64<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<f64>::deserialize(deserializer).map(|value| value.unwrap_or(0.0))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CocomoDataset {
    pub name: String,
    pub projects: Vec<CocomoProject>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CocomoBasicCoefficients {
    pub a: f64,
    pub b: f64,
    pub c: Option<f64>,
    pub d: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CocomoProjectTypeMetrics {
    pub mape: f64,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CocomoRecommendedAdjustment {
    pub parameter: String,
    pub current_value: f64,
    pub recommended_value: f64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CocomoValidationReport {
    pub projects_evaluated: usize,
    pub mape: f64,
    pub bias: f64,
    pub by_project_type: BTreeMap<String, CocomoProjectTypeMetrics>,
    pub recommended_adjustments: Vec<CocomoRecommendedAdjustment>,
    pub human_readable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CocomoModelMetrics {
    pub name: String,
    pub mape: f64,
    pub mmre: f64,
    pub pred25: f64,
    pub pred50: f64,
    pub bias: f64,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CocomoBestBreakdown {
    pub count: usize,
    pub best_model: String,
    pub best_mape: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CocomoGroundTruthResult {
    pub projects_evaluated: usize,
    pub models: Vec<CocomoModelMetrics>,
    pub by_dataset: BTreeMap<String, CocomoBestBreakdown>,
    pub by_type: BTreeMap<String, CocomoBestBreakdown>,
    pub winner: String,
    pub conclusion: String,
    pub human_readable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EstimateRecord {
    pub id: String,
    pub tool: String,
    pub inputs: BTreeMap<String, Value>,
    pub outputs: BTreeMap<String, Value>,
    pub estimated_at: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActualRecord {
    pub estimate_id: String,
    pub actual_hours: f64,
    pub notes: Option<String>,
    pub reported_at: String,
    pub completed_at: Option<String>,
    #[serde(alias = "calibration_provenance")]
    pub calibration_provenance: Option<CalibrationProvenance>,
    #[serde(alias = "calibration_usage")]
    pub calibration_usage: Option<CalibrationUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationProvenance {
    Prospective,
    BackfilledRealSession,
    BackfilledCalibration,
    Synthetic,
    Smoke,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CalibrationUsage {
    Correction,
    Baseline,
    Exclude,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackMatchedRecord {
    pub task_type: TaskType,
    pub estimated_hours: f64,
    pub actual_hours: f64,
    pub team_id: Option<String>,
    pub tool: Option<String>,
    pub complexity: Option<f64>,
    pub completed_at: String,
    pub calibration_provenance: CalibrationProvenance,
    pub calibration_usage: CalibrationUsage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingEstimateRecord {
    #[serde(flatten)]
    pub estimate: EstimateRecord,
    pub has_actual: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BatchActualEntry {
    pub estimate_id: String,
    pub actual_hours: f64,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecordActualFailureReason {
    BelowThreshold,
    Duplicate,
    WriteFailed,
    SyntheticId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackMetricSummary {
    pub estimates: usize,
    pub actuals: usize,
    pub matched_pairs: usize,
    pub mape: Option<f64>,
    pub mdape: Option<f64>,
    pub capped_mdape: Option<f64>,
    pub bias: Option<f64>,
    pub trend: Option<AccuracyTrendDirection>,
    pub recommendation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackProvenanceSummary {
    pub correction_records: usize,
    pub baseline_records: usize,
    pub excluded_records: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSelfImprovement {
    pub ready_types: Vec<String>,
    pub calls_until_update: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackDataQuality {
    pub overall_mdape: Option<f64>,
    pub overall_capped_mdape: Option<f64>,
    pub outlier_ratio: f64,
    pub recommendation: String,
    pub data_completeness_score: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackHealthReport {
    pub total_estimates: usize,
    pub total_actuals: usize,
    pub matched_pairs: usize,
    pub seed_records_filtered: usize,
    pub provenance: FeedbackProvenanceSummary,
    pub match_rate: f64,
    pub by_tool: BTreeMap<String, FeedbackMetricSummary>,
    pub by_task_type: BTreeMap<String, FeedbackMetricSummary>,
    pub self_improvement: FeedbackSelfImprovement,
    pub data_quality: FeedbackDataQuality,
    pub human_readable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfidenceIntervals {
    pub p50: f64,
    pub p80: f64,
    pub p95: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalAccuracy {
    pub mape: f64,
    pub mdape: f64,
    pub sample_size: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskTypeRisk {
    pub risk_level: RiskLevel,
    pub mdape: f64,
    pub sample_size: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRiskAssessment {
    pub estimated_hours: f64,
    pub estimated_token_cost: f64,
    pub risk_level: RiskLevel,
    pub confidence_intervals: ConfidenceIntervals,
    pub historical_accuracy: HistoricalAccuracy,
    pub capped_mdape: f64,
    pub recommendation: String,
    pub task_type_breakdown: BTreeMap<String, TaskTypeRisk>,
    pub human_readable: String,
}

impl PublicSurfaceContract {
    pub fn parse(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(raw)
    }

    pub fn milestone_zero() -> Self {
        Self {
            package_name: PACKAGE_NAME.to_string(),
            mcp_tool_names: tool_names(),
            write_tool_names: write_tool_names(),
            http_routes: HTTP_ROUTES
                .iter()
                .map(|route| (*route).to_string())
                .collect(),
            cli_command_paths: CLI_COMMAND_PATHS
                .iter()
                .map(|command| (*command).to_string())
                .collect(),
        }
    }

    pub fn validate_milestone_zero(&self) -> Result<(), String> {
        if self.package_name != PACKAGE_NAME {
            return Err(format!("unexpected package name: {}", self.package_name));
        }
        let expected = Self::milestone_zero();
        if self.mcp_tool_names != expected.mcp_tool_names {
            return Err(format!(
                "unexpected MCP tools: expected {:?}, got {:?}",
                expected.mcp_tool_names, self.mcp_tool_names,
            ));
        }
        if self.write_tool_names != expected.write_tool_names {
            return Err(format!(
                "unexpected write tools: expected {:?}, got {:?}",
                expected.write_tool_names, self.write_tool_names
            ));
        }
        if self.http_routes != expected.http_routes {
            return Err(format!(
                "unexpected HTTP routes: expected {:?}, got {:?}",
                expected.http_routes, self.http_routes
            ));
        }
        if self.cli_command_paths != expected.cli_command_paths {
            return Err(format!(
                "unexpected CLI commands: expected {:?}, got {:?}",
                expected.cli_command_paths, self.cli_command_paths
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CLI_COMMAND_PATHS, HTTP_ROUTES, PublicSurfaceContract, READ_ONLY_ANNOTATIONS,
        TOOL_REGISTRY, WRITE_ANNOTATIONS, find_tool, tool_cli_commands,
        tool_has_feedback_ref_candidate_output, tool_names, write_tool_names,
    };
    use std::collections::BTreeSet;

    const SURFACE: &str =
        include_str!("../../../../docs/superpowers/contracts/epoch-public-surface.json");

    #[test]
    fn parses_exported_public_surface_contract() {
        let contract = PublicSurfaceContract::parse(SURFACE).expect("valid contract JSON");
        contract
            .validate_milestone_zero()
            .expect("valid milestone 0 surface");
        assert_eq!(contract.mcp_tool_names[0], "get_current_time");
        assert_eq!(contract.mcp_tool_names[23], "feedback_health");
    }

    #[test]
    fn canonical_registry_matches_exported_public_surface() {
        let exported = PublicSurfaceContract::parse(SURFACE).expect("valid contract JSON");
        let expected = PublicSurfaceContract::milestone_zero();

        assert_eq!(exported, expected);
        assert_eq!(TOOL_REGISTRY.len(), 24);
        assert_eq!(HTTP_ROUTES.len(), 11);
        assert_eq!(CLI_COMMAND_PATHS.len(), 39);
    }

    #[test]
    fn registry_names_are_unique_and_ordered() {
        let names = tool_names();
        let unique = names.iter().collect::<BTreeSet<_>>();

        assert_eq!(unique.len(), names.len());
        assert_eq!(names.first().map(String::as_str), Some("get_current_time"));
        assert_eq!(names.last().map(String::as_str), Some("feedback_health"));
        assert!(
            TOOL_REGISTRY
                .iter()
                .all(|tool| !tool.description.is_empty())
        );
    }

    #[test]
    fn write_tools_have_write_annotations() {
        assert_eq!(
            write_tool_names(),
            vec![
                "record_actual".to_string(),
                "batch_record_actuals".to_string()
            ]
        );
        assert_eq!(
            find_tool("record_actual").map(|tool| tool.annotations),
            Some(WRITE_ANNOTATIONS)
        );
        assert_eq!(
            find_tool("pert_estimate").map(|tool| tool.annotations),
            Some(READ_ONLY_ANNOTATIONS)
        );
    }

    #[test]
    fn cli_tool_commands_are_public_cli_commands() {
        let all_commands = CLI_COMMAND_PATHS.iter().copied().collect::<BTreeSet<_>>();
        for command in tool_cli_commands() {
            assert!(
                all_commands.contains(command.as_str()),
                "missing CLI command for tool: {command}"
            );
        }
    }

    #[test]
    fn feedback_ref_candidates_match_hour_estimate_tools() {
        assert!(tool_has_feedback_ref_candidate_output("pert_estimate"));
        assert!(tool_has_feedback_ref_candidate_output("token_time_bridge"));
        assert!(tool_has_feedback_ref_candidate_output("schedule_risk"));
        assert!(!tool_has_feedback_ref_candidate_output("parse_duration"));
        assert!(!tool_has_feedback_ref_candidate_output("record_actual"));
    }
}
