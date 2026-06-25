use crate::analytics::{HistoricalRecord, compute_accuracy_metrics};
use chrono::{DateTime, Duration, Utc};
use epoch_contract::{
    ActualRecord, BatchActualEntry, BatchResult, CalibrationProvenance, CalibrationUsage,
    EstimateRecord, FeedbackDataQuality, FeedbackHealthReport, FeedbackMatchedRecord,
    FeedbackMetricSummary, FeedbackProvenanceSummary, FeedbackSelfImprovement,
    PendingEstimateRecord, RecordActualFailureReason, TaskType,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const MINIMUM_RECORDED_ACTUAL_HOURS: f64 = 0.0;
const MINIMUM_CALIBRATION_ACTUAL_HOURS: f64 = 0.01;
const MIN_RATIO: f64 = 0.03;
const SYNTHETIC_PREFIXES: &[&str] = &[
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
const ESTIMATION_TOOLS: &[&str] = &[
    "pert_estimate",
    "cocomo_estimate",
    "sprint_forecast",
    "critical_path",
    "monte_carlo_schedule",
    "token_time_bridge",
    "schedule_risk",
    "reference_class_estimate",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalibrationUsageFilter {
    Correction,
    Baseline,
    All,
}

impl Default for CalibrationUsageFilter {
    fn default() -> Self {
        Self::Correction
    }
}

#[derive(Debug, Clone, Default)]
pub struct CalibrationFilters {
    pub team_id: Option<String>,
    pub task_type: Option<TaskType>,
    pub window_days: Option<i64>,
    pub tool: Option<String>,
    pub calibration_usage: CalibrationUsageFilter,
    pub now: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default)]
pub struct FeedbackStore {
    estimates: Vec<EstimateRecord>,
    actuals: Vec<ActualRecord>,
}

impl FeedbackStore {
    pub fn new(estimates: Vec<EstimateRecord>, actuals: Vec<ActualRecord>) -> Self {
        Self { estimates, actuals }
    }

    pub fn estimates(&self) -> &[EstimateRecord] {
        &self.estimates
    }

    pub fn actuals(&self) -> &[ActualRecord] {
        &self.actuals
    }

    pub fn add_estimate(&mut self, estimate: EstimateRecord) {
        self.estimates.push(estimate);
    }

    pub fn record_actual(
        &mut self,
        estimate_id: impl Into<String>,
        actual_hours: f64,
        notes: Option<String>,
    ) -> bool {
        self.record_actual_detailed(estimate_id, actual_hours, notes, Utc::now().to_rfc3339())
            .is_ok()
    }

    pub fn record_actual_detailed(
        &mut self,
        estimate_id: impl Into<String>,
        actual_hours: f64,
        notes: Option<String>,
        reported_at: impl Into<String>,
    ) -> Result<(), RecordActualFailureReason> {
        let estimate_id = estimate_id.into();
        if actual_hours <= MINIMUM_RECORDED_ACTUAL_HOURS || !actual_hours.is_finite() {
            return Err(RecordActualFailureReason::BelowThreshold);
        }
        if is_synthetic_id(&estimate_id) {
            return Err(RecordActualFailureReason::SyntheticId);
        }
        if self
            .actuals
            .iter()
            .any(|actual| actual.estimate_id == estimate_id)
        {
            return Err(RecordActualFailureReason::Duplicate);
        }

        self.actuals.push(ActualRecord {
            estimate_id,
            actual_hours,
            notes,
            reported_at: reported_at.into(),
            completed_at: None,
            calibration_provenance: None,
            calibration_usage: None,
        });
        Ok(())
    }

    pub fn batch_record_actuals(
        &mut self,
        entries: &[BatchActualEntry],
        reported_at: impl AsRef<str>,
    ) -> BatchResult {
        let mut errors = Vec::new();
        let mut succeeded = 0;

        for entry in entries {
            if self
                .record_actual_detailed(
                    entry.estimate_id.clone(),
                    entry.actual_hours,
                    entry.notes.clone(),
                    reported_at.as_ref().to_string(),
                )
                .is_ok()
            {
                succeeded += 1;
            } else {
                errors.push(format!(
                    "Failed to record actual for estimate {}",
                    entry.estimate_id
                ));
            }
        }

        BatchResult {
            total: entries.len(),
            succeeded,
            failed: errors.len(),
            errors,
        }
    }

    pub fn pending_estimates(&self, limit: usize) -> Vec<PendingEstimateRecord> {
        if limit == 0 {
            return Vec::new();
        }

        let actual_ids = self
            .actuals
            .iter()
            .map(|actual| actual.estimate_id.as_str())
            .collect::<BTreeSet<_>>();
        let mut pending = self
            .estimates
            .iter()
            .cloned()
            .map(|estimate| {
                let has_actual = actual_ids.contains(estimate.id.as_str());
                PendingEstimateRecord {
                    estimate,
                    has_actual,
                }
            })
            .filter(|record| !record.has_actual)
            .collect::<Vec<_>>();
        let start = pending.len().saturating_sub(limit);
        pending.drain(0..start);
        pending
    }

    pub fn calibration_data(&self, filters: CalibrationFilters) -> Vec<FeedbackMatchedRecord> {
        let mut records = match_estimates_to_actuals(&self.estimates, &self.actuals, &filters);
        match filters.calibration_usage {
            CalibrationUsageFilter::All => records,
            CalibrationUsageFilter::Correction => {
                records.retain(|record| record.calibration_usage == CalibrationUsage::Correction);
                records
            }
            CalibrationUsageFilter::Baseline => {
                records.retain(|record| record.calibration_usage == CalibrationUsage::Baseline);
                records
            }
        }
    }

    pub fn health_report(&self) -> FeedbackHealthReport {
        feedback_health_report(&self.estimates, &self.actuals)
    }
}

pub fn match_estimates_to_actuals(
    estimates: &[EstimateRecord],
    actuals: &[ActualRecord],
    filters: &CalibrationFilters,
) -> Vec<FeedbackMatchedRecord> {
    let mut actuals_map: BTreeMap<&str, &ActualRecord> = BTreeMap::new();
    for actual in actuals {
        actuals_map.insert(actual.estimate_id.as_str(), actual);
    }

    let cutoff = filters
        .window_days
        .map(|days| filters.now.unwrap_or_else(Utc::now) - Duration::days(days));
    let mut records = Vec::new();

    for estimate in estimates {
        if let Some(cutoff) = cutoff {
            if parse_time(&estimate.estimated_at).is_some_and(|estimated| estimated < cutoff) {
                continue;
            }
        }

        let Some(actual) = actuals_map.get(estimate.id.as_str()) else {
            continue;
        };
        if actual.actual_hours < MINIMUM_CALIBRATION_ACTUAL_HOURS {
            continue;
        }
        if is_seed_record(actual) {
            continue;
        }

        let calibration = classify_calibration_record(estimate, actual);
        if calibration.1 == CalibrationUsage::Exclude {
            continue;
        }

        let Some(estimated_hours) = extract_estimated_hours(&estimate.outputs) else {
            continue;
        };
        if estimated_hours <= 0.0 || actual.actual_hours / estimated_hours < MIN_RATIO {
            continue;
        }

        let task_type = task_type_from_value(estimate.inputs.get("task_type"))
            .unwrap_or_else(|| infer_task_type(&estimate.tool));
        if filters.task_type.is_some_and(|wanted| wanted != task_type) {
            continue;
        }
        if filters.team_id.as_deref().is_some_and(|wanted| {
            string_value(estimate.inputs.get("team_id")).as_deref() != Some(wanted)
        }) {
            continue;
        }
        if filters
            .tool
            .as_deref()
            .is_some_and(|wanted| estimate.tool != wanted)
        {
            continue;
        }

        let completed_at = actual
            .completed_at
            .clone()
            .unwrap_or_else(|| actual.reported_at.clone());

        records.push(FeedbackMatchedRecord {
            task_type,
            estimated_hours,
            actual_hours: actual.actual_hours,
            team_id: string_value(estimate.inputs.get("team_id")),
            tool: Some(estimate.tool.clone()),
            complexity: number_value(estimate.inputs.get("complexity")),
            completed_at,
            calibration_provenance: calibration.0,
            calibration_usage: calibration.1,
        });
    }

    records.sort_by(|left, right| left.completed_at.cmp(&right.completed_at));
    records
}

fn feedback_health_report(
    estimates: &[EstimateRecord],
    actuals: &[ActualRecord],
) -> FeedbackHealthReport {
    let actual_ids = actuals
        .iter()
        .map(|actual| actual.estimate_id.as_str())
        .collect::<BTreeSet<_>>();
    let total_estimates = estimates.len();
    let total_actuals = actuals.len();
    let matched_estimate_count = estimates
        .iter()
        .filter(|estimate| actual_ids.contains(estimate.id.as_str()))
        .count();
    let match_rate = if total_estimates > 0 {
        round1(matched_estimate_count as f64 / total_estimates as f64 * 100.0)
    } else {
        0.0
    };

    let all_matched =
        match_estimates_to_actuals(estimates, actuals, &CalibrationFilters::default());
    let correction_matched = all_matched
        .iter()
        .filter(|record| record.calibration_usage != CalibrationUsage::Baseline)
        .cloned()
        .collect::<Vec<_>>();
    let baseline_records = all_matched.len() - correction_matched.len();
    let seed_records_filtered = count_seed_records_filtered(estimates, actuals);

    let by_tool = summarize_by_tool(estimates, &actual_ids, &correction_matched);
    let by_task_type = summarize_by_task_type(estimates, &correction_matched);
    let ready_types = ready_task_types(&correction_matched);
    let calls_until_update = 100usize.saturating_sub(total_estimates);
    let data_quality = data_quality(&correction_matched, &by_tool, &by_task_type);

    let tools_with_data = by_tool
        .values()
        .filter(|summary| summary.matched_pairs > 0)
        .count();
    let types_with_data = by_task_type
        .values()
        .filter(|summary| summary.matched_pairs > 0)
        .count();
    let mdape_label = data_quality
        .overall_mdape
        .map(|value| format!("{}%", value.round()))
        .unwrap_or_else(|| "N/A".to_string());
    let capped_label = data_quality
        .overall_capped_mdape
        .map(|value| format!("{}%", value.round()))
        .unwrap_or_else(|| "N/A".to_string());
    let seed_label = if seed_records_filtered > 0 {
        format!(" ({seed_records_filtered} seed records filtered)")
    } else {
        String::new()
    };

    FeedbackHealthReport {
        total_estimates,
        total_actuals,
        matched_pairs: correction_matched.len(),
        seed_records_filtered,
        provenance: FeedbackProvenanceSummary {
            correction_records: correction_matched.len(),
            baseline_records,
            excluded_records: seed_records_filtered,
        },
        match_rate,
        by_tool,
        by_task_type,
        self_improvement: FeedbackSelfImprovement {
            ready_types,
            calls_until_update,
        },
        human_readable: format!(
            "{} correction-eligible matched pairs across {tools_with_data} tools and {types_with_data} task types (capped MdAPE: {capped_label}, raw MdAPE: {mdape_label}; {baseline_records} baseline-only records held out). {total_estimates} estimates, {total_actuals} actuals, match rate: {match_rate}%{seed_label}. {}",
            correction_matched.len(),
            data_quality.recommendation
        ),
        data_quality,
    }
}

fn summarize_by_tool(
    estimates: &[EstimateRecord],
    actual_ids: &BTreeSet<&str>,
    matched: &[FeedbackMatchedRecord],
) -> BTreeMap<String, FeedbackMetricSummary> {
    let mut estimate_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut actual_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut matched_groups: BTreeMap<String, Vec<FeedbackMatchedRecord>> = BTreeMap::new();

    for estimate in estimates {
        *estimate_counts.entry(estimate.tool.clone()).or_default() += 1;
        if actual_ids.contains(estimate.id.as_str()) {
            *actual_counts.entry(estimate.tool.clone()).or_default() += 1;
        }
    }
    for record in matched {
        matched_groups
            .entry(record.tool.clone().unwrap_or_else(|| "unknown".to_string()))
            .or_default()
            .push(record.clone());
    }

    estimate_counts
        .into_iter()
        .map(|(tool, estimates)| {
            let group = matched_groups.remove(&tool).unwrap_or_default();
            let summary = metric_summary(
                estimates,
                actual_counts.get(&tool).copied().unwrap_or(0),
                &group,
                false,
            );
            (tool, summary)
        })
        .collect()
}

fn summarize_by_task_type(
    estimates: &[EstimateRecord],
    matched: &[FeedbackMatchedRecord],
) -> BTreeMap<String, FeedbackMetricSummary> {
    let mut estimate_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut groups: BTreeMap<String, Vec<FeedbackMatchedRecord>> = BTreeMap::new();

    for estimate in estimates {
        let task_type = task_type_from_value(estimate.inputs.get("task_type"))
            .unwrap_or_else(|| infer_task_type(&estimate.tool));
        *estimate_counts
            .entry(task_type.as_str().to_string())
            .or_default() += 1;
    }
    for record in matched {
        groups
            .entry(record.task_type.as_str().to_string())
            .or_default()
            .push(record.clone());
    }

    estimate_counts
        .into_iter()
        .map(|(task_type, estimates)| {
            let group = groups.remove(&task_type).unwrap_or_default();
            let summary = metric_summary(estimates, group.len(), &group, true);
            (task_type, summary)
        })
        .collect()
}

fn metric_summary(
    estimates: usize,
    actuals: usize,
    matched: &[FeedbackMatchedRecord],
    is_task_type: bool,
) -> FeedbackMetricSummary {
    let metrics = if matched.len() >= 2 {
        Some(compute_accuracy_metrics(&analytics_records(matched)))
    } else {
        None
    };
    let pairs = matched.len();
    let recommendation = if pairs == 0 {
        if is_task_type {
            "No matched pairs. Use this task type in estimates and record actuals.".to_string()
        } else {
            "No matched pairs. Record actuals to start calibration.".to_string()
        }
    } else if pairs < 3 {
        format!(
            "Only {pairs} matched pair{}. Need {} more for MdAPE computation.",
            if pairs == 1 { "" } else { "s" },
            3 - pairs
        )
    } else if pairs < 10 {
        format!(
            "Sufficient for calibration ({pairs} pairs, capped MdAPE: {}%, {}). Collect more to improve reliability.",
            optional_fixed(metrics.as_ref().map(|metric| metric.capped_mdape)),
            bias_label(metrics.as_ref().map(|metric| metric.bias))
        )
    } else {
        let outlier_note = metrics
            .as_ref()
            .filter(|metric| metric.capped_mdape > 50.0)
            .map(|_| " Review outliers.")
            .unwrap_or("");
        format!(
            "Good coverage ({pairs} pairs, capped MdAPE: {}%, {}).{outlier_note}",
            optional_fixed(metrics.as_ref().map(|metric| metric.capped_mdape)),
            bias_label(metrics.as_ref().map(|metric| metric.bias))
        )
    };

    FeedbackMetricSummary {
        estimates,
        actuals,
        matched_pairs: pairs,
        mape: metrics.as_ref().map(|metric| metric.mape),
        mdape: metrics.as_ref().map(|metric| metric.mdape),
        capped_mdape: metrics.as_ref().map(|metric| metric.capped_mdape),
        bias: metrics.as_ref().map(|metric| metric.bias),
        trend: metrics.as_ref().map(|metric| metric.trend),
        recommendation,
    }
}

fn data_quality(
    correction_matched: &[FeedbackMatchedRecord],
    by_tool: &BTreeMap<String, FeedbackMetricSummary>,
    by_task_type: &BTreeMap<String, FeedbackMetricSummary>,
) -> FeedbackDataQuality {
    let (overall_mdape, overall_capped_mdape, outlier_ratio, recommendation) = if correction_matched
        .len()
        >= 5
    {
        let records = analytics_records(correction_matched);
        let metrics = compute_accuracy_metrics(&records);
        let outlier_threshold = metrics.capped_mdape * 3.0;
        let outliers = correction_matched
            .iter()
            .filter(|record| {
                let err = (record.actual_hours - record.estimated_hours).abs()
                    / record.actual_hours
                    * 100.0;
                err > outlier_threshold
            })
            .count();
        let recommendation = if metrics.capped_mdape < 25.0 {
            "Data quality is good. Capped MdAPE below 25% indicates reliable estimates.".to_string()
        } else if metrics.capped_mdape < 50.0 {
            "Data quality is moderate. Consider filtering outlier records or collecting more matched pairs."
                    .to_string()
        } else {
            "Data quality needs improvement. High capped MdAPE suggests systematic estimation bias. Review seed data for human/AI baseline mismatches."
                    .to_string()
        };
        (
            Some(metrics.mdape),
            Some(metrics.capped_mdape),
            round1(outliers as f64 / correction_matched.len() as f64 * 100.0),
            recommendation,
        )
    } else {
        (
                None,
                None,
                0.0,
                "Insufficient data for quality assessment. Need at least 5 matched estimate-actual pairs."
                    .to_string(),
            )
    };

    let tools_calibrated = ESTIMATION_TOOLS
        .iter()
        .filter(|tool| {
            by_tool
                .get(**tool)
                .is_some_and(|summary| summary.matched_pairs >= 3)
        })
        .count();
    let tool_score = ((tools_calibrated as f64 / ESTIMATION_TOOLS.len() as f64) * 40.0).round();
    let types_calibrated = by_task_type
        .values()
        .filter(|summary| summary.matched_pairs >= 3)
        .count();
    let type_score = if by_task_type.is_empty() {
        0.0
    } else {
        (types_calibrated as f64 / by_task_type.len() as f64 * 30.0).round()
    };
    let pair_score = ((correction_matched.len() as f64 / 100.0) * 30.0)
        .round()
        .min(30.0);

    FeedbackDataQuality {
        overall_mdape,
        overall_capped_mdape,
        outlier_ratio,
        recommendation,
        data_completeness_score: (tool_score + type_score + pair_score) as usize,
    }
}

fn ready_task_types(matched: &[FeedbackMatchedRecord]) -> Vec<String> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for record in matched {
        *counts
            .entry(record.task_type.as_str().to_string())
            .or_default() += 1;
    }
    counts
        .into_iter()
        .filter_map(|(task_type, count)| (count >= 5).then_some(task_type))
        .collect()
}

fn count_seed_records_filtered(estimates: &[EstimateRecord], actuals: &[ActualRecord]) -> usize {
    let estimate_ids = estimates
        .iter()
        .map(|estimate| estimate.id.as_str())
        .collect::<BTreeSet<_>>();
    let actuals_map = actuals
        .iter()
        .map(|actual| (actual.estimate_id.as_str(), actual))
        .collect::<BTreeMap<_, _>>();

    let mut count = 0;
    for actual in actuals {
        if !estimate_ids.contains(actual.estimate_id.as_str()) {
            continue;
        }
        if actual.actual_hours < MINIMUM_CALIBRATION_ACTUAL_HOURS {
            count += 1;
            continue;
        }
        if is_seed_record(actual) {
            count += 1;
        }
    }

    for estimate in estimates {
        let Some(actual) = actuals_map.get(estimate.id.as_str()) else {
            continue;
        };
        if actual.actual_hours < MINIMUM_CALIBRATION_ACTUAL_HOURS || is_seed_record(actual) {
            continue;
        }
        if extract_estimated_hours(&estimate.outputs)
            .is_some_and(|hours| hours > 0.0 && actual.actual_hours / hours < MIN_RATIO)
        {
            count += 1;
        }
    }

    count
}

fn analytics_records(records: &[FeedbackMatchedRecord]) -> Vec<HistoricalRecord> {
    records
        .iter()
        .map(|record| HistoricalRecord {
            task_type: record.task_type,
            estimated_hours: record.estimated_hours,
            actual_hours: record.actual_hours,
            team_id: record.team_id.clone(),
            tool: record.tool.clone(),
            complexity: record.complexity,
            completed_at: Some(record.completed_at.clone()),
        })
        .collect()
}

fn classify_calibration_record(
    estimate: &EstimateRecord,
    actual: &ActualRecord,
) -> (CalibrationProvenance, CalibrationUsage) {
    let explicit_provenance = estimate
        .inputs
        .get("calibration_provenance")
        .and_then(provenance_from_value)
        .or(actual.calibration_provenance);
    let explicit_usage = estimate
        .inputs
        .get("calibration_usage")
        .and_then(usage_from_value)
        .or(actual.calibration_usage);
    let notes = actual.notes.as_deref().unwrap_or("").to_lowercase();
    let tool = estimate.tool.to_lowercase();

    if explicit_usage == Some(CalibrationUsage::Exclude)
        || explicit_provenance == Some(CalibrationProvenance::Synthetic)
        || explicit_provenance == Some(CalibrationProvenance::Smoke)
    {
        return (
            explicit_provenance.unwrap_or(CalibrationProvenance::Synthetic),
            CalibrationUsage::Exclude,
        );
    }

    if tool == "receiver_smoke" || notes.contains("receiver smoke") || notes.contains("smoke test")
    {
        return (CalibrationProvenance::Smoke, CalibrationUsage::Exclude);
    }
    if notes.contains("industry calibration") {
        return (CalibrationProvenance::Synthetic, CalibrationUsage::Exclude);
    }
    if notes.contains("ingested from") {
        return (
            CalibrationProvenance::BackfilledRealSession,
            CalibrationUsage::Baseline,
        );
    }
    if notes.contains("real data calibration") {
        return (
            CalibrationProvenance::BackfilledCalibration,
            CalibrationUsage::Baseline,
        );
    }
    if happened_before(actual.completed_at.as_deref(), Some(&estimate.estimated_at)) {
        return (
            CalibrationProvenance::BackfilledCalibration,
            CalibrationUsage::Baseline,
        );
    }

    if let Some(provenance) = explicit_provenance {
        return (
            provenance,
            explicit_usage.unwrap_or(if provenance == CalibrationProvenance::Prospective {
                CalibrationUsage::Correction
            } else {
                CalibrationUsage::Baseline
            }),
        );
    }

    (
        CalibrationProvenance::Prospective,
        explicit_usage.unwrap_or(CalibrationUsage::Correction),
    )
}

fn extract_estimated_hours(outputs: &BTreeMap<String, Value>) -> Option<f64> {
    if let Some(value) = number_value(outputs.get("totalHours")) {
        return Some(value);
    }
    if let Some(value) = number_value(outputs.get("estimatedHours")) {
        return Some(value);
    }
    if let Some(value) = number_value(outputs.get("estimatedMinutes")) {
        return Some(value / 60.0);
    }
    if let Some(value) = number_value(outputs.get("estimatedSeconds")) {
        return Some(value / 3600.0);
    }
    if let Some(value) = number_value(outputs.get("expected")) {
        return match string_value(outputs.get("unit")).as_deref() {
            Some("hours") | None => Some(value),
            Some("days") => Some(value * 8.0),
            Some("weeks") => Some(value * 40.0),
            Some("months") => Some(value * 160.0),
            Some(_) => None,
        };
    }
    if let Some(value) = number_value(outputs.get("personMonthsLlmAdjusted")) {
        return Some(value * 160.0);
    }
    if let Some(value) = number_value(outputs.get("correctedEstimate")) {
        return Some(value);
    }
    if let Some(value) = number_value(outputs.get("total_duration")) {
        return Some(value * 8.0);
    }
    None
}

fn is_synthetic_id(id: &str) -> bool {
    SYNTHETIC_PREFIXES
        .iter()
        .any(|prefix| id.starts_with(prefix))
}

fn is_seed_record(actual: &ActualRecord) -> bool {
    if is_synthetic_id(&actual.estimate_id) {
        return true;
    }
    let notes = actual.notes.as_deref().unwrap_or("").to_lowercase();
    notes.contains("seed")
        || notes.contains("synthetic")
        || notes.contains("dogfood-seed")
        || notes.contains("test data")
}

fn infer_task_type(tool: &str) -> TaskType {
    match tool {
        "token_time_bridge" | "token_cost_estimate" => TaskType::Infrastructure,
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
        | "compare_models" => TaskType::Feature,
        _ => TaskType::Feature,
    }
}

fn task_type_from_value(value: Option<&Value>) -> Option<TaskType> {
    match string_value(value)?.as_str() {
        "feature" => Some(TaskType::Feature),
        "bugfix" => Some(TaskType::Bugfix),
        "refactor" => Some(TaskType::Refactor),
        "migration" => Some(TaskType::Migration),
        "infrastructure" => Some(TaskType::Infrastructure),
        "documentation" => Some(TaskType::Documentation),
        "testing" => Some(TaskType::Testing),
        "design" => Some(TaskType::Design),
        _ => None,
    }
}

fn provenance_from_value(value: &Value) -> Option<CalibrationProvenance> {
    match value.as_str()? {
        "prospective" => Some(CalibrationProvenance::Prospective),
        "backfilled_real_session" => Some(CalibrationProvenance::BackfilledRealSession),
        "backfilled_calibration" => Some(CalibrationProvenance::BackfilledCalibration),
        "synthetic" => Some(CalibrationProvenance::Synthetic),
        "smoke" => Some(CalibrationProvenance::Smoke),
        "unknown" => Some(CalibrationProvenance::Unknown),
        _ => None,
    }
}

fn usage_from_value(value: &Value) -> Option<CalibrationUsage> {
    match value.as_str()? {
        "correction" => Some(CalibrationUsage::Correction),
        "baseline" => Some(CalibrationUsage::Baseline),
        "exclude" => Some(CalibrationUsage::Exclude),
        _ => None,
    }
}

fn happened_before(a: Option<&str>, b: Option<&str>) -> bool {
    let Some(a) = a.and_then(parse_time) else {
        return false;
    };
    let Some(b) = b.and_then(parse_time) else {
        return false;
    };
    a < b - Duration::minutes(1)
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

fn string_value(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn bias_label(bias: Option<f64>) -> &'static str {
    let Some(bias) = bias else {
        return "";
    };
    if bias > 2.0 {
        "systematic underestimation"
    } else if bias > 0.5 {
        "mild underestimation"
    } else if bias > -0.5 {
        "well-calibrated"
    } else if bias > -3.0 {
        "mild overestimation"
    } else {
        "systematic overestimation"
    }
}

fn optional_fixed(value: Option<f64>) -> String {
    value
        .map(|value| format!("{value:.1}"))
        .unwrap_or_else(|| "N/A".to_string())
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::{
        CalibrationFilters, CalibrationUsageFilter, FeedbackStore, match_estimates_to_actuals,
    };
    use epoch_contract::{
        ActualRecord, BatchActualEntry, CalibrationProvenance, CalibrationUsage, EstimateRecord,
        RecordActualFailureReason, TaskType,
    };
    use serde_json::{Value, json};
    use std::collections::BTreeMap;

    #[test]
    fn records_actuals_and_rejects_invalid_feedback() {
        let mut store = FeedbackStore::default();

        assert_eq!(
            store.record_actual_detailed("est-zero", 0.0, None, reported_at()),
            Err(RecordActualFailureReason::BelowThreshold)
        );
        assert_eq!(
            store.record_actual_detailed("seed-1", 1.0, None, reported_at()),
            Err(RecordActualFailureReason::SyntheticId)
        );
        assert!(
            store
                .record_actual_detailed(
                    "est-fast",
                    0.08,
                    Some("real fast task".into()),
                    reported_at()
                )
                .is_ok()
        );
        assert_eq!(
            store.record_actual_detailed("est-fast", 2.0, None, reported_at()),
            Err(RecordActualFailureReason::Duplicate)
        );
        assert_eq!(store.actuals().len(), 1);
    }

    #[test]
    fn returns_latest_pending_estimates_without_actuals() {
        let store = FeedbackStore::new(
            vec![
                estimate(
                    "e1",
                    "pert_estimate",
                    inputs([]),
                    outputs([("totalHours", json!(1.0))]),
                ),
                estimate(
                    "e2",
                    "pert_estimate",
                    inputs([]),
                    outputs([("totalHours", json!(2.0))]),
                ),
                estimate(
                    "e3",
                    "pert_estimate",
                    inputs([]),
                    outputs([("totalHours", json!(3.0))]),
                ),
            ],
            vec![actual("e2", 2.0, None, None)],
        );

        let pending = store.pending_estimates(1);

        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].estimate.id, "e3");
        assert!(!pending[0].has_actual);
    }

    #[test]
    fn extracts_supported_estimate_output_shapes() {
        let pairs = [
            ("totalHours", json!(8.0), 8.0),
            ("estimatedHours", json!(7.0), 7.0),
            ("estimatedMinutes", json!(90.0), 1.5),
            ("estimatedSeconds", json!(7200.0), 2.0),
            ("personMonthsLlmAdjusted", json!(0.5), 80.0),
            ("correctedEstimate", json!(11.0), 11.0),
            ("total_duration", json!(2.0), 16.0),
        ];

        for (index, (key, value, expected)) in pairs.into_iter().enumerate() {
            let id = format!("e{index}");
            let records = match_estimates_to_actuals(
                &[estimate(
                    &id,
                    "pert_estimate",
                    inputs([]),
                    outputs([(key, value)]),
                )],
                &[actual(&id, expected * 1.1, None, None)],
                &CalibrationFilters::default(),
            );
            assert_eq!(records[0].estimated_hours, expected);
        }

        let records = match_estimates_to_actuals(
            &[estimate(
                "expected-days",
                "pert_estimate",
                inputs([]),
                outputs([("expected", json!(2.0)), ("unit", json!("days"))]),
            )],
            &[actual("expected-days", 18.0, None, None)],
            &CalibrationFilters::default(),
        );
        assert_eq!(records[0].estimated_hours, 16.0);
    }

    #[test]
    fn matches_records_with_calibration_policy_filters() {
        let estimates = vec![
            estimate(
                "correction",
                "pert_estimate",
                inputs([("task_type", json!("bugfix")), ("team_id", json!("team-a"))]),
                outputs([("totalHours", json!(10.0))]),
            ),
            estimate(
                "baseline",
                "pert_estimate",
                inputs([]),
                outputs([("totalHours", json!(10.0))]),
            ),
            estimate(
                "smoke",
                "receiver_smoke",
                inputs([]),
                outputs([("totalHours", json!(10.0))]),
            ),
            estimate(
                "micro",
                "pert_estimate",
                inputs([]),
                outputs([("totalHours", json!(10.0))]),
            ),
            estimate(
                "ratio",
                "pert_estimate",
                inputs([]),
                outputs([("totalHours", json!(10.0))]),
            ),
        ];
        let actuals = vec![
            actual("correction", 12.0, None, Some("2026-01-11T00:00:00Z")),
            actual(
                "baseline",
                11.0,
                Some("ingested from receiver".to_string()),
                Some("2026-01-09T00:00:00Z"),
            ),
            actual("smoke", 12.0, Some("smoke test".to_string()), None),
            actual("micro", 0.001, None, None),
            actual("ratio", 0.2, None, None),
        ];

        let all = match_estimates_to_actuals(
            &estimates,
            &actuals,
            &CalibrationFilters {
                calibration_usage: CalibrationUsageFilter::All,
                ..CalibrationFilters::default()
            },
        );

        assert_eq!(all.len(), 2);
        assert_eq!(all[0].calibration_usage, CalibrationUsage::Baseline);
        assert_eq!(
            all[0].calibration_provenance,
            CalibrationProvenance::BackfilledRealSession
        );
        assert_eq!(all[1].task_type, TaskType::Bugfix);
        assert_eq!(all[1].team_id.as_deref(), Some("team-a"));

        let correction =
            FeedbackStore::new(estimates, actuals).calibration_data(CalibrationFilters {
                team_id: Some("team-a".to_string()),
                task_type: Some(TaskType::Bugfix),
                ..CalibrationFilters::default()
            });
        assert_eq!(correction.len(), 1);
        assert_eq!(
            correction[0].calibration_usage,
            CalibrationUsage::Correction
        );
    }

    #[test]
    fn batch_records_successes_and_failures() {
        let mut store = FeedbackStore::default();

        let result = store.batch_record_actuals(
            &[
                BatchActualEntry {
                    estimate_id: "real-1".to_string(),
                    actual_hours: 4.0,
                    notes: None,
                },
                BatchActualEntry {
                    estimate_id: "batch-test-bad".to_string(),
                    actual_hours: 4.0,
                    notes: None,
                },
                BatchActualEntry {
                    estimate_id: "zero".to_string(),
                    actual_hours: 0.0,
                    notes: None,
                },
            ],
            reported_at(),
        );

        assert_eq!(result.total, 3);
        assert_eq!(result.succeeded, 1);
        assert_eq!(result.failed, 2);
        assert_eq!(store.actuals().len(), 1);
    }

    #[test]
    fn health_report_summarizes_coverage_and_data_quality() {
        let mut estimates = Vec::new();
        let mut actuals = Vec::new();
        for index in 0..5 {
            let id = format!("feature-{index}");
            estimates.push(estimate(
                &id,
                "pert_estimate",
                inputs([("task_type", json!("feature"))]),
                outputs([("totalHours", json!(10.0))]),
            ));
            actuals.push(actual(
                &id,
                10.0 + index as f64,
                None,
                Some(&format!("2026-01-2{index}T00:00:00Z")),
            ));
        }
        estimates.push(estimate(
            "baseline",
            "pert_estimate",
            inputs([]),
            outputs([("totalHours", json!(10.0))]),
        ));
        actuals.push(actual(
            "baseline",
            12.0,
            Some("real data calibration".to_string()),
            Some("2026-01-01T00:00:00Z"),
        ));
        estimates.push(estimate(
            "seeded",
            "pert_estimate",
            inputs([]),
            outputs([("totalHours", json!(10.0))]),
        ));
        actuals.push(actual("seeded", 0.001, None, None));

        let report = FeedbackStore::new(estimates, actuals).health_report();

        assert_eq!(report.total_estimates, 7);
        assert_eq!(report.total_actuals, 7);
        assert_eq!(report.matched_pairs, 5);
        assert_eq!(report.provenance.baseline_records, 1);
        assert_eq!(report.seed_records_filtered, 1);
        assert_eq!(report.match_rate, 100.0);
        assert_eq!(report.self_improvement.ready_types, vec!["feature"]);
        assert!(report.data_quality.overall_capped_mdape.is_some());
        assert!(report.by_tool["pert_estimate"].matched_pairs >= 5);
        assert!(
            report
                .human_readable
                .contains("baseline-only records held out")
        );

        let serialized = serde_json::to_value(&report).expect("serialize health report");
        assert!(serialized.get("matchRate").is_some());
        assert!(serialized.get("byTool").is_some());
        assert!(serialized.get("dataQuality").is_some());
    }

    fn estimate(
        id: &str,
        tool: &str,
        inputs: BTreeMap<String, Value>,
        outputs: BTreeMap<String, Value>,
    ) -> EstimateRecord {
        EstimateRecord {
            id: id.to_string(),
            tool: tool.to_string(),
            inputs,
            outputs,
            estimated_at: "2026-01-10T12:00:00Z".to_string(),
            source: None,
        }
    }

    fn actual(
        estimate_id: &str,
        actual_hours: f64,
        notes: Option<String>,
        completed_at: Option<&str>,
    ) -> ActualRecord {
        ActualRecord {
            estimate_id: estimate_id.to_string(),
            actual_hours,
            notes,
            reported_at: reported_at(),
            completed_at: completed_at.map(str::to_string),
            calibration_provenance: None,
            calibration_usage: None,
        }
    }

    fn inputs<const N: usize>(pairs: [(&str, Value); N]) -> BTreeMap<String, Value> {
        pairs
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect()
    }

    fn outputs<const N: usize>(pairs: [(&str, Value); N]) -> BTreeMap<String, Value> {
        inputs(pairs)
    }

    fn reported_at() -> String {
        "2026-01-11T00:00:00Z".to_string()
    }
}
