use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

    pub fn validate_milestone_zero(&self) -> Result<(), String> {
        if self.package_name != "@kyanitelabs/epoch" {
            return Err(format!("unexpected package name: {}", self.package_name));
        }
        if self.mcp_tool_names.len() != 24 {
            return Err(format!(
                "expected 24 MCP tools, got {}",
                self.mcp_tool_names.len(),
            ));
        }
        if self.write_tool_names != ["record_actual", "batch_record_actuals"] {
            return Err(format!(
                "unexpected write tools: {:?}",
                self.write_tool_names
            ));
        }
        if self.http_routes.len() != 11 {
            return Err(format!(
                "expected 11 HTTP routes, got {}",
                self.http_routes.len(),
            ));
        }
        if self.cli_command_paths.len() != 39 {
            return Err(format!(
                "expected 39 CLI command paths, got {}",
                self.cli_command_paths.len(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::PublicSurfaceContract;

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
}
