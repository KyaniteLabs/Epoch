use epoch_contract::{
    AccuracyMetrics, AccuracyTrend, AccuracyTrendDirection, AccuracyWindow, CalibrationResult,
    ConfidenceLevel, ReferenceClassEstimate, ScopeSignal, TaskType,
};

#[derive(Debug, Clone, PartialEq)]
pub struct HistoricalRecord {
    pub task_type: TaskType,
    pub estimated_hours: f64,
    pub actual_hours: f64,
    pub team_id: Option<String>,
    pub tool: Option<String>,
    pub complexity: Option<f64>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ScopeBaseline {
    small: f64,
    medium: f64,
    large: f64,
    xl: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ReferenceCategory {
    total_samples: usize,
    p25_hours: f64,
    p75_hours: f64,
}

pub fn infer_scope_from_complexity(complexity: f64) -> ScopeSignal {
    if complexity <= 2.0 {
        ScopeSignal::Small
    } else if complexity <= 3.0 {
        ScopeSignal::Medium
    } else if complexity <= 4.0 {
        ScopeSignal::Large
    } else {
        ScopeSignal::Xl
    }
}

pub fn get_scope_guide(task_type: TaskType) -> Option<String> {
    scope_baseline(task_type).map(|baseline| {
        format!(
            "For {} tasks: small=~{}h, medium=~{}h, large=~{}h, xl=~{}h",
            task_type.as_str(),
            format_number(baseline.small),
            format_number(baseline.medium),
            format_number(baseline.large),
            format_number(baseline.xl),
        )
    })
}

pub fn reference_class_estimate(
    records: &[HistoricalRecord],
    task_type: TaskType,
    complexity: f64,
    scope: Option<ScopeSignal>,
    ai_native: bool,
) -> ReferenceClassEstimate {
    reference_class_estimate_with_correction_factor(
        records, task_type, complexity, scope, ai_native, None,
    )
}

pub fn reference_class_estimate_with_correction_factor(
    records: &[HistoricalRecord],
    task_type: TaskType,
    complexity: f64,
    scope: Option<ScopeSignal>,
    ai_native: bool,
    sparse_reference_correction_factor: Option<f64>,
) -> ReferenceClassEstimate {
    let filtered = records
        .iter()
        .filter(|record| record.task_type == task_type && record.estimated_hours > 0.0)
        .collect::<Vec<_>>();

    let using_ai_baselines = ai_native && ai_native_scope_baseline(task_type).is_some();
    let scope_inferred = scope.is_none();
    let effective_scope = scope.unwrap_or_else(|| infer_scope_from_complexity(complexity));

    let correction_factor = if filtered.len() >= 5 {
        let ratios = filtered
            .iter()
            .map(|record| record.actual_hours / record.estimated_hours)
            .collect::<Vec<_>>();
        median(ratios).clamp(0.1, 3.0)
    } else if using_ai_baselines {
        1.0
    } else {
        sparse_reference_correction_factor
            .filter(|factor| factor.is_finite())
            .unwrap_or_else(|| industry_correction_factor(task_type))
    };
    let sample_size = filtered.len();
    let complexity_multiplier = complexity_multiplier(complexity);

    let (raw_estimate, baseline_source) =
        if let Some(baseline) = selected_scope_baseline(task_type, ai_native) {
            let raw = baseline.value(effective_scope) * complexity_multiplier;
            let source = if scope_inferred {
                format!("inferred_scope_{}_real_tasks", effective_scope.as_str())
            } else {
                format!("scope_{}_real_tasks", effective_scope.as_str())
            };
            (raw, source)
        } else if let Some(real_baseline) =
            reference_category(task_type).filter(|baseline| baseline.total_samples >= 5)
        {
            let clamped_complexity = complexity.clamp(1.0, 5.0);
            let complexity_norm = (clamped_complexity - 1.0) / 4.0;
            (
                real_baseline.p25_hours
                    + (real_baseline.p75_hours - real_baseline.p25_hours) * complexity_norm,
                format!("real_tasks_{}", real_baseline.total_samples),
            )
        } else {
            let fallback_multiplier = 0.5 + (complexity - 1.0) * 0.375;
            (8.0 * fallback_multiplier, "industry_8h".to_string())
        };

    let raw_estimate = round1(raw_estimate);
    let corrected_estimate = round1(raw_estimate * correction_factor);

    ReferenceClassEstimate {
        raw_estimate,
        corrected_estimate,
        correction_factor: round2(correction_factor),
        sample_size,
        baseline_source,
        scope_used: effective_scope,
        scope_inferred,
        confidence: if sample_size >= 10 {
            ConfidenceLevel::Likely
        } else if sample_size >= 5 {
            ConfidenceLevel::Optimistic
        } else {
            ConfidenceLevel::Pessimistic
        },
        estimated_token_cost: round2(corrected_estimate * 50_000.0),
    }
}

pub fn compute_accuracy_metrics(records: &[HistoricalRecord]) -> AccuracyMetrics {
    if records.is_empty() {
        return empty_accuracy_metrics();
    }

    let valid_records = records
        .iter()
        .filter(|record| record.actual_hours > 0.0)
        .collect::<Vec<_>>();
    if valid_records.is_empty() {
        return empty_accuracy_metrics();
    }

    let errors = valid_records
        .iter()
        .map(|record| (record.actual_hours - record.estimated_hours).abs() / record.actual_hours)
        .collect::<Vec<_>>();
    let mape = errors.iter().copied().sum::<f64>() / errors.len() as f64 * 100.0;
    let mdape = median(errors.clone()) * 100.0;
    let capped_mdape = median(errors.into_iter().map(|error| error.min(5.0)).collect()) * 100.0;

    let biases = valid_records
        .iter()
        .map(|record| record.actual_hours - record.estimated_hours)
        .collect::<Vec<_>>();
    let bias = biases.iter().copied().sum::<f64>() / biases.len() as f64;
    let variance = biases
        .iter()
        .map(|value| (value - bias).powi(2))
        .sum::<f64>()
        / biases.len() as f64;

    let trend = if valid_records.len() >= 6 {
        let half = valid_records.len() / 2;
        let first_half = valid_records[..half].to_vec();
        let second_half = valid_records[half..].to_vec();
        let first_mape = avg_percentage_error(&first_half);
        let second_mape = avg_percentage_error(&second_half);
        if second_mape < first_mape * 0.85 {
            AccuracyTrendDirection::Improving
        } else if second_mape > first_mape * 1.15 {
            AccuracyTrendDirection::Degrading
        } else {
            AccuracyTrendDirection::Stable
        }
    } else {
        AccuracyTrendDirection::Stable
    };

    AccuracyMetrics {
        mape: round1(mape),
        mdape: round1(mdape),
        capped_mdape: round1(capped_mdape),
        bias: round1(bias),
        variance: round1(variance),
        sample_size: valid_records.len(),
        trend,
    }
}

pub fn calibrate_estimates(
    _team_id: &str,
    period_days: u32,
    minimum_samples: usize,
    records: &[HistoricalRecord],
    global_correction_factor: f64,
) -> CalibrationResult {
    if records.len() >= minimum_samples {
        let metrics = compute_accuracy_metrics(records);
        let ratios = records
            .iter()
            .filter(|record| record.estimated_hours > 0.0)
            .map(|record| record.actual_hours / record.estimated_hours)
            .collect::<Vec<_>>();
        let median_ratio = if ratios.is_empty() {
            1.0
        } else {
            median(ratios)
        };
        let correction_factor = round2(median_ratio.clamp(0.1, 3.0));
        let bias_label = if metrics.bias > 0.0 {
            "underestimation"
        } else {
            "overestimation"
        };

        let mut recommendations = vec![
            format!(
                "Computed from {} historical records over {period_days} days.",
                records.len()
            ),
            format!(
                "MAPE: {}%, MdAPE: {}%, bias: {bias_label} ({}).",
                format_number(metrics.mape),
                format_number(metrics.mdape),
                format_number(metrics.bias),
            ),
            format!("Accuracy trend: {}.", metrics.trend.as_str()),
        ];
        if metrics.trend == AccuracyTrendDirection::Degrading {
            recommendations.push(
                "Accuracy is degrading — review recent estimates for systematic bias.".to_string(),
            );
        }
        if metrics.sample_size < 20 {
            recommendations
                .push("More data points (20+) will improve calibration reliability.".to_string());
        }

        CalibrationResult {
            correction_factor,
            accuracy_trend: metrics.trend,
            velocity_trend: match metrics.trend {
                AccuracyTrendDirection::Improving => "accelerating",
                AccuracyTrendDirection::Degrading => "slowing",
                AccuracyTrendDirection::Stable => "stable",
            }
            .to_string(),
            recommendations,
        }
    } else {
        CalibrationResult {
            correction_factor: global_correction_factor,
            accuracy_trend: AccuracyTrendDirection::Stable,
            velocity_trend: "stable".to_string(),
            recommendations: vec![
                format!(
                    "Using reference database correction factor ({}x) — {} samples, need {minimum_samples}.",
                    format_number(global_correction_factor),
                    records.len()
                ),
                "Submit actuals via POST /v1/feedback/record-actual to enable data-driven calibration."
                    .to_string(),
                "Accuracy improves significantly with 10+ historical data points per task type."
                    .to_string(),
            ],
        }
    }
}

pub fn compute_accuracy_trend(
    records: &[HistoricalRecord],
    requested_window_size: Option<usize>,
) -> AccuracyTrend {
    let requested_window_size = requested_window_size.unwrap_or(50);
    let total_estimates = records.len();
    let total_with_actuals = records.len();

    if records.is_empty() {
        return AccuracyTrend {
            windows: Vec::new(),
            overall_trend: AccuracyTrendDirection::Stable,
            current_mape: 0.0,
            industry_baseline_mape: industry_baseline_mape(),
            improvement_vs_industry: industry_baseline_mape(),
            total_estimates: 0,
            total_with_actuals: 0,
            human_readable:
                "No historical estimation data available. Start recording estimates and actuals to track accuracy trends."
                    .to_string(),
        };
    }

    let mut sorted = records.to_vec();
    sorted.sort_by(|left, right| {
        left.completed_at
            .as_deref()
            .unwrap_or("")
            .cmp(right.completed_at.as_deref().unwrap_or(""))
    });

    let min_window_size = 10;
    let mut window_size = requested_window_size;
    if sorted.len() >= window_size * 2 {
        let remainder = sorted.len() % window_size;
        if remainder > 0 && remainder < window_size / 2 {
            let num_windows = sorted.len().div_ceil(window_size);
            window_size = sorted.len().div_ceil(num_windows);
        }
    }
    window_size = window_size.max(min_window_size);

    if sorted.len() < window_size {
        let metrics = compute_accuracy_metrics(&sorted);
        let window = AccuracyWindow {
            period: format!("Window 1 (estimates 1-{})", sorted.len()),
            date_range: date_range(&sorted),
            mape: metrics.mape,
            mdape: metrics.mdape,
            bias: metrics.bias,
            sample_size: sorted.len(),
        };
        let industry_baseline = industry_baseline_mape();
        let current_mape = metrics.mape;
        let improvement_vs_industry = round1(industry_baseline - current_mape);
        let windows = vec![window];
        return AccuracyTrend {
            windows: windows.clone(),
            overall_trend: AccuracyTrendDirection::Stable,
            current_mape,
            industry_baseline_mape: industry_baseline,
            improvement_vs_industry,
            total_estimates,
            total_with_actuals,
            human_readable: build_trend_human_readable(
                AccuracyTrendDirection::Stable,
                current_mape,
                industry_baseline,
                improvement_vs_industry,
                &windows,
            ),
        };
    }

    let mut windows = Vec::new();
    for (window_index, start) in (0..sorted.len()).step_by(window_size).enumerate() {
        let end = (start + window_size).min(sorted.len());
        let window_records = &sorted[start..end];
        if window_records.is_empty() {
            break;
        }
        let metrics = compute_accuracy_metrics(window_records);
        windows.push(AccuracyWindow {
            period: format!(
                "Window {} (estimates {}-{})",
                window_index + 1,
                start + 1,
                end
            ),
            date_range: date_range(window_records),
            mape: metrics.mape,
            mdape: metrics.mdape,
            bias: metrics.bias,
            sample_size: window_records.len(),
        });
    }

    let first_mdape = windows.first().map(|window| window.mdape).unwrap_or(0.0);
    let last_mdape = windows.last().map(|window| window.mdape).unwrap_or(0.0);
    let current_mape = windows.last().map(|window| window.mape).unwrap_or(0.0);
    let overall_trend = if last_mdape < first_mdape * 0.85 {
        AccuracyTrendDirection::Improving
    } else if last_mdape > first_mdape * 1.15 {
        AccuracyTrendDirection::Degrading
    } else {
        AccuracyTrendDirection::Stable
    };
    let industry_baseline = industry_baseline_mape();
    let improvement_vs_industry = round1(industry_baseline - current_mape);

    AccuracyTrend {
        windows: windows.clone(),
        overall_trend,
        current_mape,
        industry_baseline_mape: industry_baseline,
        improvement_vs_industry,
        total_estimates,
        total_with_actuals,
        human_readable: build_trend_human_readable(
            overall_trend,
            current_mape,
            industry_baseline,
            improvement_vs_industry,
            &windows,
        ),
    }
}

fn empty_accuracy_metrics() -> AccuracyMetrics {
    AccuracyMetrics {
        mape: 0.0,
        mdape: 0.0,
        capped_mdape: 0.0,
        bias: 0.0,
        variance: 0.0,
        sample_size: 0,
        trend: AccuracyTrendDirection::Stable,
    }
}

fn build_trend_human_readable(
    trend: AccuracyTrendDirection,
    current_mape: f64,
    industry_baseline: f64,
    improvement_vs_industry: f64,
    windows: &[AccuracyWindow],
) -> String {
    let vs_industry = if improvement_vs_industry > 0.0 {
        format!(
            "{}% better than industry baseline ({}%)",
            format_number(improvement_vs_industry),
            format_number(industry_baseline)
        )
    } else if improvement_vs_industry < 0.0 {
        format!(
            "{}% worse than industry baseline ({}%)",
            format_number(improvement_vs_industry.abs()),
            format_number(industry_baseline)
        )
    } else {
        format!(
            "equal to industry baseline ({}%)",
            format_number(industry_baseline)
        )
    };

    let last_mdape = windows.last().map(|window| window.mdape).unwrap_or(0.0);
    let estimate_count = windows
        .iter()
        .map(|window| window.sample_size)
        .sum::<usize>();
    let window_summary = if windows.len() == 1 {
        format!(
            "1 window (MdAPE: {}%, MAPE: {}%)",
            format_number(last_mdape),
            format_number(windows.first().map(|window| window.mape).unwrap_or(0.0))
        )
    } else {
        let min_mdape = windows
            .iter()
            .map(|window| window.mdape)
            .fold(f64::INFINITY, f64::min);
        let max_mdape = windows
            .iter()
            .map(|window| window.mdape)
            .fold(f64::NEG_INFINITY, f64::max);
        format!(
            "{} windows, MdAPE range: {}% to {}%",
            windows.len(),
            format_number(min_mdape),
            format_number(max_mdape)
        )
    };

    format!(
        "Accuracy trend is {}. Current MdAPE: {}% (MAPE: {}%), {vs_industry}. {window_summary} across {estimate_count} estimates.",
        trend.as_str(),
        format_number(last_mdape),
        format_number(current_mape)
    )
}

fn date_range(records: &[HistoricalRecord]) -> Option<String> {
    let first = records.first()?;
    let last = records.last()?;
    Some(format!(
        "{} to {}",
        date_prefix(first.completed_at.as_deref().unwrap_or("")),
        date_prefix(last.completed_at.as_deref().unwrap_or(""))
    ))
}

fn date_prefix(value: &str) -> String {
    value.chars().take(10).collect()
}

fn industry_baseline_mape() -> f64 {
    25.0
}

fn avg_percentage_error(records: &[&HistoricalRecord]) -> f64 {
    let valid = records
        .iter()
        .filter(|record| record.actual_hours > 0.0)
        .collect::<Vec<_>>();
    if valid.is_empty() {
        return 0.0;
    }
    valid
        .iter()
        .map(|record| (record.actual_hours - record.estimated_hours).abs() / record.actual_hours)
        .sum::<f64>()
        / valid.len() as f64
        * 100.0
}

fn selected_scope_baseline(task_type: TaskType, ai_native: bool) -> Option<ScopeBaseline> {
    if ai_native {
        ai_native_scope_baseline(task_type).or_else(|| scope_baseline(task_type))
    } else {
        scope_baseline(task_type)
    }
}

fn scope_baseline(task_type: TaskType) -> Option<ScopeBaseline> {
    Some(match task_type {
        TaskType::Bugfix => ScopeBaseline {
            small: 5.2,
            medium: 12.9,
            large: 16.8,
            xl: 20.6,
        },
        TaskType::Design => ScopeBaseline {
            small: 4.6,
            medium: 11.6,
            large: 15.1,
            xl: 18.6,
        },
        TaskType::Documentation => ScopeBaseline {
            small: 4.0,
            medium: 10.0,
            large: 13.0,
            xl: 16.0,
        },
        TaskType::Feature => ScopeBaseline {
            small: 2.3,
            medium: 6.0,
            large: 10.6,
            xl: 17.0,
        },
        TaskType::Infrastructure => ScopeBaseline {
            small: 4.1,
            medium: 10.3,
            large: 13.4,
            xl: 16.5,
        },
        TaskType::Migration => ScopeBaseline {
            small: 4.2,
            medium: 10.5,
            large: 13.7,
            xl: 16.8,
        },
        TaskType::Refactor => ScopeBaseline {
            small: 4.2,
            medium: 10.5,
            large: 16.18,
            xl: 16.8,
        },
        TaskType::Testing => ScopeBaseline {
            small: 4.0,
            medium: 10.0,
            large: 13.0,
            xl: 16.0,
        },
    })
}

fn ai_native_scope_baseline(task_type: TaskType) -> Option<ScopeBaseline> {
    Some(match task_type {
        TaskType::Feature => ScopeBaseline {
            small: 0.5,
            medium: 2.0,
            large: 5.0,
            xl: 12.0,
        },
        TaskType::Bugfix => ScopeBaseline {
            small: 0.1,
            medium: 1.0,
            large: 3.0,
            xl: 6.0,
        },
        TaskType::Infrastructure => ScopeBaseline {
            small: 0.3,
            medium: 1.5,
            large: 4.0,
            xl: 10.0,
        },
        TaskType::Testing => ScopeBaseline {
            small: 0.1,
            medium: 1.0,
            large: 3.0,
            xl: 8.0,
        },
        TaskType::Refactor => ScopeBaseline {
            small: 0.5,
            medium: 1.5,
            large: 4.0,
            xl: 10.0,
        },
        TaskType::Documentation => ScopeBaseline {
            small: 0.2,
            medium: 1.0,
            large: 3.0,
            xl: 6.0,
        },
        TaskType::Design => ScopeBaseline {
            small: 0.5,
            medium: 2.0,
            large: 5.0,
            xl: 12.0,
        },
        TaskType::Migration => ScopeBaseline {
            small: 0.5,
            medium: 2.0,
            large: 6.0,
            xl: 16.0,
        },
    })
}

fn reference_category(task_type: TaskType) -> Option<ReferenceCategory> {
    Some(match task_type {
        TaskType::Bugfix => ReferenceCategory {
            total_samples: 114,
            p25_hours: 8.9,
            p75_hours: 16.8,
        },
        TaskType::Design => ReferenceCategory {
            total_samples: 88,
            p25_hours: 8.1,
            p75_hours: 15.1,
        },
        TaskType::Documentation => ReferenceCategory {
            total_samples: 91,
            p25_hours: 7.0,
            p75_hours: 13.0,
        },
        TaskType::Feature => ReferenceCategory {
            total_samples: 152,
            p25_hours: 4.2,
            p75_hours: 10.6,
        },
        TaskType::Infrastructure => ReferenceCategory {
            total_samples: 94,
            p25_hours: 7.2,
            p75_hours: 13.4,
        },
        TaskType::Migration => ReferenceCategory {
            total_samples: 93,
            p25_hours: 7.4,
            p75_hours: 13.7,
        },
        TaskType::Refactor => ReferenceCategory {
            total_samples: 88,
            p25_hours: 7.4,
            p75_hours: 16.18,
        },
        TaskType::Testing => ReferenceCategory {
            total_samples: 88,
            p25_hours: 7.0,
            p75_hours: 13.0,
        },
    })
}

fn industry_correction_factor(task_type: TaskType) -> f64 {
    match task_type {
        TaskType::Feature => 1.8,
        TaskType::Bugfix => 1.4,
        TaskType::Refactor => 2.0,
        TaskType::Migration => 2.2,
        TaskType::Infrastructure => 1.9,
        TaskType::Documentation => 1.3,
        TaskType::Testing => 1.5,
        TaskType::Design => 1.7,
    }
}

fn complexity_multiplier(complexity: f64) -> f64 {
    let clamped = complexity.clamp(1.0, 5.0);
    if approx_eq(clamped, 1.0) {
        0.7
    } else if approx_eq(clamped, 2.0) {
        0.85
    } else if approx_eq(clamped, 3.0) {
        1.0
    } else if approx_eq(clamped, 4.0) {
        1.2
    } else if approx_eq(clamped, 5.0) {
        1.5
    } else {
        1.0
    }
}

impl ScopeBaseline {
    fn value(self, scope: ScopeSignal) -> f64 {
        match scope {
            ScopeSignal::Small => self.small,
            ScopeSignal::Medium => self.medium,
            ScopeSignal::Large => self.large,
            ScopeSignal::Xl => self.xl,
        }
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

fn approx_eq(left: f64, right: f64) -> bool {
    (left - right).abs() < f64::EPSILON
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        return format!("{value:.0}");
    }
    let mut out = format!("{value:.2}");
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
    use super::{
        HistoricalRecord, calibrate_estimates, compute_accuracy_metrics, compute_accuracy_trend,
        get_scope_guide, infer_scope_from_complexity, reference_class_estimate,
        reference_class_estimate_with_correction_factor, round1,
    };
    use epoch_contract::{AccuracyTrendDirection, ConfidenceLevel, ScopeSignal, TaskType};
    use serde_json::json;

    #[test]
    fn infers_scope_from_complexity() {
        assert_eq!(infer_scope_from_complexity(0.0), ScopeSignal::Small);
        assert_eq!(infer_scope_from_complexity(2.0), ScopeSignal::Small);
        assert_eq!(infer_scope_from_complexity(2.5), ScopeSignal::Medium);
        assert_eq!(infer_scope_from_complexity(3.5), ScopeSignal::Large);
        assert_eq!(infer_scope_from_complexity(5.0), ScopeSignal::Xl);
    }

    #[test]
    fn exposes_scope_guide_for_known_task_types() {
        let guide = get_scope_guide(TaskType::Feature).expect("scope guide");
        assert!(guide.contains("feature"));
        assert!(guide.contains("medium=~6h"));
        assert!(guide.contains("xl=~17h"));
    }

    #[test]
    fn reference_class_uses_scope_baselines_and_industry_correction() {
        let small =
            reference_class_estimate(&[], TaskType::Feature, 3.0, Some(ScopeSignal::Small), false);
        let large =
            reference_class_estimate(&[], TaskType::Feature, 3.0, Some(ScopeSignal::Large), false);

        assert_eq!(small.scope_used, ScopeSignal::Small);
        assert!(!small.scope_inferred);
        assert_eq!(small.baseline_source, "scope_small_real_tasks");
        assert_eq!(small.raw_estimate, 2.3);
        assert_eq!(small.correction_factor, 1.8);
        assert_eq!(small.confidence, ConfidenceLevel::Pessimistic);
        assert!(large.raw_estimate > small.raw_estimate);
    }

    #[test]
    fn reference_class_accepts_sparse_reference_database_correction_factor() {
        let result = reference_class_estimate_with_correction_factor(
            &[],
            TaskType::Feature,
            4.0,
            Some(ScopeSignal::Large),
            false,
            Some(1.0),
        );

        assert_eq!(result.raw_estimate, 12.7);
        assert_eq!(result.correction_factor, 1.0);
        assert_eq!(result.corrected_estimate, 12.7);
    }

    #[test]
    fn reference_class_uses_median_historical_ratio_when_enough_records() {
        let records = vec![
            record(TaskType::Feature, 10.0, 12.0),
            record(TaskType::Feature, 10.0, 14.0),
            record(TaskType::Feature, 10.0, 15.0),
            record(TaskType::Feature, 10.0, 16.0),
            record(TaskType::Feature, 10.0, 18.0),
            record(TaskType::Bugfix, 10.0, 100.0),
        ];
        let result = reference_class_estimate(
            &records,
            TaskType::Feature,
            3.0,
            Some(ScopeSignal::Medium),
            false,
        );

        assert_eq!(result.sample_size, 5);
        assert_eq!(result.correction_factor, 1.5);
        assert_eq!(result.raw_estimate, 6.0);
        assert_eq!(result.corrected_estimate, 9.0);
        assert_eq!(result.confidence, ConfidenceLevel::Optimistic);
    }

    #[test]
    fn reference_class_clamps_extreme_historical_ratio() {
        let records = (0..7)
            .map(|index| record(TaskType::Feature, 10.0, 100.0 + index as f64 * 10.0))
            .collect::<Vec<_>>();
        let result = reference_class_estimate(&records, TaskType::Feature, 3.0, None, false);

        assert_eq!(result.correction_factor, 3.0);
        assert_eq!(result.scope_used, ScopeSignal::Medium);
        assert!(result.scope_inferred);
        assert_eq!(result.baseline_source, "inferred_scope_medium_real_tasks");
    }

    #[test]
    fn ai_native_baselines_use_one_correction_without_local_data() {
        let human =
            reference_class_estimate(&[], TaskType::Bugfix, 1.0, Some(ScopeSignal::Small), false);
        let ai =
            reference_class_estimate(&[], TaskType::Bugfix, 1.0, Some(ScopeSignal::Small), true);

        assert!(ai.raw_estimate < human.raw_estimate);
        assert_eq!(ai.raw_estimate, 0.1);
        assert_eq!(ai.correction_factor, 1.0);
        assert_eq!(ai.corrected_estimate, 0.1);
    }

    #[test]
    fn ai_native_uses_data_driven_ratio_when_enough_records() {
        let records = (0..5)
            .map(|_| record(TaskType::Feature, 10.0, 5.0))
            .collect::<Vec<_>>();
        let result = reference_class_estimate(
            &records,
            TaskType::Feature,
            3.0,
            Some(ScopeSignal::Medium),
            true,
        );

        assert_eq!(result.raw_estimate, 2.0);
        assert_eq!(result.correction_factor, 0.5);
        assert_eq!(result.corrected_estimate, 1.0);
    }

    #[test]
    fn computes_accuracy_metrics_with_mdape_bias_variance_and_trend() {
        let records = vec![
            record(TaskType::Feature, 10.0, 30.0),
            record(TaskType::Feature, 10.0, 25.0),
            record(TaskType::Feature, 10.0, 20.0),
            record(TaskType::Feature, 10.0, 12.0),
            record(TaskType::Feature, 10.0, 11.0),
            record(TaskType::Feature, 10.0, 10.0),
        ];
        let metrics = compute_accuracy_metrics(&records);

        assert_eq!(metrics.sample_size, 6);
        assert!(metrics.mape > 0.0);
        assert!(metrics.mdape > 0.0);
        assert!(metrics.bias > 0.0);
        assert_eq!(metrics.trend, AccuracyTrendDirection::Improving);
    }

    #[test]
    fn accuracy_metrics_ignore_zero_actuals_and_serialize_ts_shape() {
        let records = vec![
            record(TaskType::Feature, 10.0, 0.0),
            record(TaskType::Feature, 10.0, 8.0),
        ];
        let metrics = compute_accuracy_metrics(&records);

        assert_eq!(metrics.sample_size, 1);
        assert_eq!(metrics.mape, 25.0);

        let serialized = serde_json::to_value(&metrics).expect("serializes");
        assert_eq!(serialized["cappedMdape"], json!(25.0));
        assert_eq!(serialized["sample_size"], json!(1));
        assert_eq!(serialized["trend"], json!("stable"));
    }

    #[test]
    fn mdape_is_robust_to_extreme_outliers() {
        let records = vec![
            record(TaskType::Bugfix, 4.0, 3.8),
            record(TaskType::Bugfix, 4.0, 3.5),
            record(TaskType::Bugfix, 4.0, 4.2),
            record(TaskType::Bugfix, 4.0, 0.01),
            record(TaskType::Bugfix, 4.0, 3.9),
        ];
        let metrics = compute_accuracy_metrics(&records);

        assert!(metrics.mape > 5_000.0);
        assert!(metrics.mdape < 20.0);
        assert_eq!(metrics.capped_mdape, metrics.mdape);
    }

    #[test]
    fn calibrate_estimates_uses_median_ratio_and_recommendations() {
        let records = vec![
            record(TaskType::Feature, 10.0, 9.0),
            record(TaskType::Feature, 10.0, 11.0),
            record(TaskType::Feature, 10.0, 10.0),
            record(TaskType::Feature, 10.0, 8.0),
            record(TaskType::Feature, 10.0, 12.0),
            record(TaskType::Feature, 10.0, 0.01),
        ];
        let result = calibrate_estimates("team-a", 90, 5, &records, 1.07);

        assert!(result.correction_factor < 1.5);
        assert_eq!(result.accuracy_trend, AccuracyTrendDirection::Degrading);
        assert_eq!(result.velocity_trend, "slowing");
        assert!(
            result
                .recommendations
                .iter()
                .any(|item| item.contains("MdAPE"))
        );
    }

    #[test]
    fn calibrate_estimates_detects_degrading_trend() {
        let records = vec![
            record(TaskType::Feature, 10.0, 10.0),
            record(TaskType::Feature, 10.0, 10.0),
            record(TaskType::Feature, 10.0, 11.0),
            record(TaskType::Feature, 10.0, 20.0),
            record(TaskType::Feature, 10.0, 30.0),
            record(TaskType::Feature, 10.0, 40.0),
        ];
        let result = calibrate_estimates("team-a", 90, 5, &records, 1.07);

        assert_eq!(result.accuracy_trend, AccuracyTrendDirection::Degrading);
        assert_eq!(result.velocity_trend, "slowing");
        assert!(
            result
                .recommendations
                .iter()
                .any(|item| item.contains("degrading"))
        );
    }

    #[test]
    fn calibrate_estimates_falls_back_with_too_few_samples() {
        let records = vec![record(TaskType::Feature, 10.0, 12.0)];
        let result = calibrate_estimates("team-a", 90, 5, &records, 1.07);

        assert_eq!(result.correction_factor, 1.07);
        assert_eq!(result.accuracy_trend, AccuracyTrendDirection::Stable);
        assert_eq!(result.recommendations.len(), 3);
        assert!(result.recommendations[0].contains("1 samples, need 5"));
    }

    #[test]
    fn accuracy_trend_returns_empty_baseline_without_records() {
        let result = compute_accuracy_trend(&[], None);

        assert!(result.windows.is_empty());
        assert_eq!(result.overall_trend, AccuracyTrendDirection::Stable);
        assert_eq!(result.current_mape, 0.0);
        assert_eq!(result.industry_baseline_mape, 25.0);
        assert_eq!(result.improvement_vs_industry, 25.0);
        assert_eq!(result.total_estimates, 0);
        assert!(result.human_readable.contains("No historical"));
    }

    #[test]
    fn accuracy_trend_uses_single_window_for_small_samples() {
        let records = dated_records(5, |_| 10.0);
        let result = compute_accuracy_trend(&records, Some(50));

        assert_eq!(result.windows.len(), 1);
        assert_eq!(result.windows[0].period, "Window 1 (estimates 1-5)");
        assert_eq!(
            result.windows[0].date_range.as_deref(),
            Some("2026-01-01 to 2026-01-05")
        );
        assert_eq!(result.total_estimates, 5);
        assert_eq!(result.total_with_actuals, 5);
        assert_eq!(result.overall_trend, AccuracyTrendDirection::Stable);
    }

    #[test]
    fn accuracy_trend_detects_improving_stable_and_degrading() {
        let improving = [
            dated_records(50, |_| 60.0),
            dated_records_with_offset(50, 50, |_| 10.0),
        ]
        .concat();
        let stable = dated_records(100, |_| 30.0);
        let degrading = [
            dated_records(50, |_| 10.0),
            dated_records_with_offset(50, 50, |_| 80.0),
        ]
        .concat();

        assert_eq!(
            compute_accuracy_trend(&improving, Some(50)).overall_trend,
            AccuracyTrendDirection::Improving
        );
        assert_eq!(
            compute_accuracy_trend(&stable, Some(50)).overall_trend,
            AccuracyTrendDirection::Stable
        );
        assert_eq!(
            compute_accuracy_trend(&degrading, Some(50)).overall_trend,
            AccuracyTrendDirection::Degrading
        );
    }

    #[test]
    fn accuracy_trend_redistributes_windows_to_avoid_tiny_tail() {
        let records = dated_records(120, |_| 20.0);
        let result = compute_accuracy_trend(&records, Some(50));
        let last_window = result.windows.last().expect("last window");

        assert!(result.windows.len() >= 2);
        assert!(last_window.sample_size >= 25);
    }

    #[test]
    fn accuracy_trend_serializes_ts_shape_and_human_summary() {
        let records = dated_records(100, |_| 30.0);
        let result = compute_accuracy_trend(&records, Some(50));

        assert_eq!(result.windows.len(), 2);
        assert!(result.human_readable.contains("Accuracy trend is stable"));
        assert!(result.human_readable.contains("MdAPE"));

        let serialized = serde_json::to_value(&result).expect("serializes");
        assert_eq!(serialized["overallTrend"], json!("stable"));
        assert_eq!(serialized["industryBaselineMape"], json!(25.0));
        assert_eq!(serialized["totalWithActuals"], json!(100));
        assert_eq!(serialized["windows"][0]["sampleSize"], json!(50));
        assert_eq!(
            serialized["windows"][0]["dateRange"],
            json!("2026-01-01 to 2026-02-19")
        );
    }

    fn record(task_type: TaskType, estimated_hours: f64, actual_hours: f64) -> HistoricalRecord {
        HistoricalRecord {
            task_type,
            estimated_hours,
            actual_hours,
            team_id: None,
            tool: None,
            complexity: None,
            completed_at: None,
        }
    }

    fn dated_records(count: usize, error_fn: impl Fn(usize) -> f64) -> Vec<HistoricalRecord> {
        dated_records_with_offset(count, 0, error_fn)
    }

    fn dated_records_with_offset(
        count: usize,
        day_offset: usize,
        error_fn: impl Fn(usize) -> f64,
    ) -> Vec<HistoricalRecord> {
        (0..count)
            .map(|index| {
                let estimated_hours = 10.0;
                let error = error_fn(index);
                let actual_hours = round1(estimated_hours * (1.0 + error / 100.0));
                let day = day_offset + index + 1;
                let date = chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
                    .expect("valid date")
                    .checked_add_days(chrono::Days::new((day - 1) as u64))
                    .expect("date in range");
                HistoricalRecord {
                    task_type: TaskType::Feature,
                    estimated_hours,
                    actual_hours,
                    team_id: None,
                    tool: None,
                    complexity: None,
                    completed_at: Some(format!("{date}T00:00:00Z")),
                }
            })
            .collect()
    }
}
