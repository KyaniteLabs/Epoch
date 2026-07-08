use epoch_contract::{
    ConfidenceIntervals, HistoricalAccuracy, RiskLevel, ScheduleRiskAssessment, TaskTypeRisk,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct CalibrationRecord {
    pub task_type: Option<String>,
    pub estimated_hours: f64,
    pub actual_hours: f64,
}

#[derive(Debug, Clone)]
pub struct ScheduleRiskParams {
    pub estimated_hours: f64,
    pub task_type: Option<String>,
    pub ai_native: f64,
    pub complexity: Option<f64>,
    pub records: Vec<CalibrationRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct AccuracyMetrics {
    mape: f64,
    mdape: f64,
    capped_mdape: f64,
    sample_size: usize,
}

pub fn schedule_risk(params: ScheduleRiskParams) -> ScheduleRiskAssessment {
    if !params.estimated_hours.is_finite() || params.estimated_hours <= 0.0 {
        return ScheduleRiskAssessment {
            estimated_hours: 0.0,
            estimated_token_cost: 0.0,
            risk_level: RiskLevel::Critical,
            confidence_intervals: ConfidenceIntervals {
                p50: 0.0,
                p80: 0.0,
                p95: 0.0,
            },
            historical_accuracy: HistoricalAccuracy {
                mape: 0.0,
                mdape: 0.0,
                sample_size: 0,
            },
            capped_mdape: 0.0,
            recommendation: "Invalid estimated hours. Provide a positive number.".to_string(),
            task_type_breakdown: BTreeMap::new(),
            human_readable: "Cannot assess risk: estimated hours is zero or invalid.".to_string(),
        };
    }

    let primary_records = params
        .records
        .iter()
        .filter(|record| {
            params
                .task_type
                .as_ref()
                .is_none_or(|task_type| record.task_type.as_ref() == Some(task_type))
        })
        .cloned()
        .collect::<Vec<_>>();

    let (mape, mdape, capped_mdape, sample_size) = if primary_records.len() >= 5 {
        let metrics = compute_accuracy_metrics(&primary_records);
        (
            metrics.mape,
            metrics.mdape,
            metrics.capped_mdape,
            metrics.sample_size,
        )
    } else {
        let fallback = profile_estimation_mape(params.ai_native);
        (fallback, fallback, fallback, primary_records.len())
    };

    let complexity_factor = params
        .complexity
        .filter(|complexity| *complexity >= 4.0)
        .map(|complexity| 1.0 + (complexity - 3.0) * 0.1)
        .unwrap_or(1.0);
    let p50 = round1(params.estimated_hours);
    let p80 =
        round1(params.estimated_hours * (1.0 + 0.842 * capped_mdape / 100.0 * complexity_factor));
    let p95 =
        round1(params.estimated_hours * (1.0 + 1.645 * capped_mdape / 100.0 * complexity_factor));
    let risk_level = risk_level_from_mdape(capped_mdape);
    let recommendation = recommendation(risk_level).to_string();
    let task_type_breakdown = compute_task_type_breakdown(&params.records);

    let task_label = params
        .task_type
        .as_ref()
        .map(|task_type| format!(" for {task_type}"))
        .unwrap_or_default();
    let complexity_label = params
        .complexity
        .map(|complexity| format!(" (complexity {})", format_number(complexity)))
        .unwrap_or_default();

    ScheduleRiskAssessment {
        estimated_hours: p50,
        estimated_token_cost: round2(p50 * 50_000.0),
        risk_level,
        confidence_intervals: ConfidenceIntervals { p50, p80, p95 },
        historical_accuracy: HistoricalAccuracy {
            mape: round1(mape),
            mdape: round1(mdape),
            sample_size,
        },
        capped_mdape: round1(capped_mdape),
        recommendation: recommendation.clone(),
        task_type_breakdown,
        human_readable: format!(
            "Schedule risk{task_label}{complexity_label}: {}. MdAPE: {}% (MAPE: {}%, based on {sample_size} historical records). Confidence intervals: p50={}h, p80={}h, p95={}h. {recommendation}",
            risk_level.as_str(),
            format_number(round1(capped_mdape)),
            format_number(round1(mape)),
            format_number(p50),
            format_number(p80),
            format_number(p95),
        ),
    }
}

fn compute_accuracy_metrics(records: &[CalibrationRecord]) -> AccuracyMetrics {
    let valid_records = records
        .iter()
        .filter(|record| record.actual_hours > 0.0)
        .collect::<Vec<_>>();

    if valid_records.is_empty() {
        return AccuracyMetrics {
            mape: 0.0,
            mdape: 0.0,
            capped_mdape: 0.0,
            sample_size: 0,
        };
    }

    let errors = valid_records
        .iter()
        .map(|record| (record.actual_hours - record.estimated_hours).abs() / record.actual_hours)
        .collect::<Vec<_>>();
    let mape = errors.iter().copied().sum::<f64>() / errors.len() as f64 * 100.0;
    let mdape = median(errors.clone()) * 100.0;
    let capped_mdape = median(errors.into_iter().map(|error| error.min(5.0)).collect()) * 100.0;

    AccuracyMetrics {
        mape: round1(mape),
        mdape: round1(mdape),
        capped_mdape: round1(capped_mdape),
        sample_size: valid_records.len(),
    }
}

fn compute_task_type_breakdown(records: &[CalibrationRecord]) -> BTreeMap<String, TaskTypeRisk> {
    let mut grouped: BTreeMap<String, Vec<CalibrationRecord>> = BTreeMap::new();
    for record in records {
        grouped
            .entry(
                record
                    .task_type
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
            )
            .or_default()
            .push(record.clone());
    }

    grouped
        .into_iter()
        .filter_map(|(task_type, records)| {
            if records.len() < 3 {
                return None;
            }
            let metrics = compute_accuracy_metrics(&records);
            Some((
                task_type,
                TaskTypeRisk {
                    risk_level: risk_level_from_mdape(metrics.capped_mdape),
                    mdape: round1(metrics.capped_mdape),
                    sample_size: metrics.sample_size,
                },
            ))
        })
        .collect()
}

fn profile_estimation_mape(ai_ratio: f64) -> f64 {
    let clamped = ai_ratio.clamp(0.0, 1.0);
    round1(25.0 + (15.0 - 25.0) * clamped)
}

fn risk_level_from_mdape(mdape: f64) -> RiskLevel {
    if mdape < 20.0 {
        RiskLevel::Low
    } else if mdape <= 35.0 {
        RiskLevel::Medium
    } else if mdape <= 50.0 {
        RiskLevel::High
    } else {
        RiskLevel::Critical
    }
}

fn recommendation(risk_level: RiskLevel) -> &'static str {
    match risk_level {
        RiskLevel::Low => "Low risk. Estimate is within normal variance.",
        RiskLevel::Medium => "Moderate risk. Consider adding 20-30% buffer.",
        RiskLevel::High => "High risk. Recommend re-estimating with more detail.",
        RiskLevel::Critical => "Critical risk. Break down the task and re-estimate each component.",
    }
}

fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|left, right| left.total_cmp(right));
    let mid = values.len() / 2;
    if values.len().is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        return format!("{value:.0}");
    }
    let mut out = format!("{value:.1}");
    while out.contains('.') && out.ends_with('0') {
        out.pop();
    }
    if out.ends_with('.') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{CalibrationRecord, ScheduleRiskParams, schedule_risk};
    use epoch_contract::RiskLevel;
    use serde_json::json;

    #[test]
    fn uses_profile_baseline_when_no_history() {
        let result = schedule_risk(params(40.0, None, 1.0, None, Vec::new()));
        assert_eq!(result.historical_accuracy.mape, 15.0);
        assert_eq!(result.risk_level, RiskLevel::Low);
        assert_eq!(result.historical_accuracy.sample_size, 0);
    }

    #[test]
    fn computes_risk_from_historical_data() {
        let result = schedule_risk(params(
            20.0,
            None,
            1.0,
            None,
            make_records(10, 30.0, "feature"),
        ));
        assert_eq!(result.historical_accuracy.sample_size, 10);
        assert!(result.historical_accuracy.mape > 0.0);
        assert_eq!(result.capped_mdape, 23.1);
        assert_eq!(result.risk_level, RiskLevel::Medium);
    }

    #[test]
    fn historical_data_overrides_profile_fallback() {
        let result = schedule_risk(params(
            20.0,
            None,
            0.0,
            None,
            make_records(5, 0.0, "feature"),
        ));
        assert_eq!(result.historical_accuracy.sample_size, 5);
        assert_eq!(result.historical_accuracy.mape, 0.0);
        assert_eq!(result.capped_mdape, 0.0);
        assert_eq!(result.confidence_intervals.p95, 20.0);
    }

    #[test]
    fn confidence_intervals_widen_with_error_and_complexity() {
        let low = schedule_risk(params(
            40.0,
            None,
            1.0,
            None,
            make_records(10, 10.0, "feature"),
        ));
        let high = schedule_risk(params(
            40.0,
            None,
            1.0,
            None,
            make_records(10, 50.0, "feature"),
        ));
        assert!(high.confidence_intervals.p95 > low.confidence_intervals.p95);

        let normal = schedule_risk(params(
            40.0,
            None,
            1.0,
            None,
            make_records(10, 30.0, "feature"),
        ));
        let complex = schedule_risk(params(
            40.0,
            None,
            1.0,
            Some(5.0),
            make_records(10, 30.0, "feature"),
        ));
        assert!(complex.confidence_intervals.p95 > normal.confidence_intervals.p95);
        assert!(complex.confidence_intervals.p80 > normal.confidence_intervals.p80);
        assert_eq!(
            complex.confidence_intervals.p50,
            normal.confidence_intervals.p50
        );
    }

    #[test]
    fn classifies_low_and_critical_risk() {
        let low = schedule_risk(params(
            16.0,
            None,
            1.0,
            None,
            make_records(10, 5.0, "feature"),
        ));
        assert_eq!(low.risk_level, RiskLevel::Low);

        let critical = schedule_risk(params(
            8.0,
            None,
            1.0,
            None,
            make_records(10, 150.0, "feature"),
        ));
        assert_eq!(critical.risk_level, RiskLevel::Critical);
    }

    #[test]
    fn profile_gradient_matches_human_hybrid_ai_baselines() {
        let ai = schedule_risk(params(40.0, None, 1.0, None, Vec::new()));
        let hybrid = schedule_risk(params(40.0, None, 0.5, None, Vec::new()));
        let human = schedule_risk(params(40.0, None, 0.0, None, Vec::new()));
        assert_eq!(ai.historical_accuracy.mape, 15.0);
        assert_eq!(hybrid.historical_accuracy.mape, 20.0);
        assert_eq!(human.historical_accuracy.mape, 25.0);
    }

    #[test]
    fn uses_mdape_for_outlier_robust_risk() {
        let mut records = make_records(9, 10.0, "feature");
        records.push(CalibrationRecord {
            task_type: Some("feature".to_string()),
            estimated_hours: 10.0,
            actual_hours: 510.0,
        });
        let result = schedule_risk(params(20.0, None, 1.0, None, records));
        assert_eq!(result.risk_level, RiskLevel::Low);
        assert!(result.human_readable.contains("MdAPE:"));
        assert!(result.human_readable.contains("MAPE:"));
    }

    #[test]
    fn includes_labels_breakdown_and_token_cost() {
        let records = [
            make_records(5, 10.0, "feature"),
            make_records(5, 200.0, "bugfix"),
            vec![CalibrationRecord {
                task_type: Some("migration".to_string()),
                estimated_hours: 10.0,
                actual_hours: 15.0,
            }],
        ]
        .concat();
        let result = schedule_risk(params(
            20.0,
            Some("feature".to_string()),
            1.0,
            Some(4.0),
            records,
        ));

        assert!(result.human_readable.contains("for feature"));
        assert!(result.human_readable.contains("complexity 4"));
        assert!(result.task_type_breakdown.contains_key("feature"));
        assert!(result.task_type_breakdown.contains_key("bugfix"));
        assert!(!result.task_type_breakdown.contains_key("migration"));
        assert_eq!(
            result.estimated_token_cost,
            result.estimated_hours * 50_000.0
        );

        let serialized = serde_json::to_value(&result).expect("serializes");
        assert_eq!(serialized["estimatedHours"], json!(20.0));
        assert_eq!(serialized["estimatedTokenCost"], json!(1_000_000.0));
        assert_eq!(serialized["riskLevel"], json!("low"));
        assert_eq!(serialized["historicalAccuracy"]["sampleSize"], json!(5));
        assert_eq!(
            serialized["taskTypeBreakdown"]["feature"]["riskLevel"],
            json!("low")
        );
    }

    #[test]
    fn invalid_estimated_hours_returns_critical_error_assessment() {
        let result = schedule_risk(params(0.0, None, 1.0, None, Vec::new()));
        assert_eq!(result.estimated_hours, 0.0);
        assert_eq!(result.risk_level, RiskLevel::Critical);
        assert!(result.recommendation.contains("Invalid estimated hours"));
        assert!(result.human_readable.contains("Cannot assess risk"));
    }

    fn params(
        estimated_hours: f64,
        task_type: Option<String>,
        ai_native: f64,
        complexity: Option<f64>,
        records: Vec<CalibrationRecord>,
    ) -> ScheduleRiskParams {
        ScheduleRiskParams {
            estimated_hours,
            task_type,
            ai_native,
            complexity,
            records,
        }
    }

    fn make_records(count: usize, error_percent: f64, task_type: &str) -> Vec<CalibrationRecord> {
        (0..count)
            .map(|_| CalibrationRecord {
                task_type: Some(task_type.to_string()),
                estimated_hours: 10.0,
                actual_hours: (10.0 * (1.0 + error_percent / 100.0) * 10.0).round() / 10.0,
            })
            .collect()
    }
}
