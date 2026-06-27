use epoch_contract::{
    CocomoBasicCoefficients, CocomoBestBreakdown, CocomoDataset, CocomoGroundTruthResult,
    CocomoModelMetrics, CocomoProjectTypeMetrics, CocomoRecommendedAdjustment,
    CocomoValidationReport, ToolError,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default)]
struct TypeAccum {
    errors: Vec<f64>,
    biases: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
struct PredictionSet {
    basic: f64,
    nominal: f64,
    ai_speedup: f64,
    ai_profile_0: f64,
    ai_profile_05: f64,
    ai_profile_1: f64,
}

#[derive(Debug, Clone)]
struct ProjectPrediction {
    actual: f64,
    dataset: String,
    project_type: String,
    models: PredictionSet,
}

#[derive(Debug, Clone, Copy)]
struct ModelEntry {
    key: ModelKey,
    label: &'static str,
}

#[derive(Debug, Clone, Copy)]
enum ModelKey {
    Basic,
    Nominal,
    AiSpeedup,
    AiProfile0,
    AiProfile05,
    AiProfile1,
}

const DEFAULT_BASIC_COEFFS: CocomoBasicCoefficients = CocomoBasicCoefficients {
    a: 3.0,
    b: 1.12,
    c: None,
    d: None,
};

const MODEL_ENTRIES: &[ModelEntry] = &[
    ModelEntry {
        key: ModelKey::Basic,
        label: "COCOMO Basic",
    },
    ModelEntry {
        key: ModelKey::Nominal,
        label: "COCOMO II Nominal",
    },
    ModelEntry {
        key: ModelKey::AiSpeedup,
        label: "COCOMO II + AI 12x",
    },
    ModelEntry {
        key: ModelKey::AiProfile0,
        label: "AI + Profile (human)",
    },
    ModelEntry {
        key: ModelKey::AiProfile05,
        label: "AI + Profile (hybrid)",
    },
    ModelEntry {
        key: ModelKey::AiProfile1,
        label: "AI + Profile (ai_native)",
    },
];

pub fn cocomo_validate(
    datasets: &[CocomoDataset],
    derived_coefficients: Option<&BTreeMap<String, CocomoBasicCoefficients>>,
    dataset_filter: Option<&[String]>,
) -> Result<CocomoValidationReport, ToolError> {
    if datasets.is_empty() {
        return Err(ToolError::new(
            "COCOMO calibration data not found. Load calibration datasets before validation.",
            "Ensure the COCOMO calibration data files are present in the data directory.",
        ));
    }

    let coefficients = coefficients_with_overrides(derived_coefficients);
    let mut all_errors = Vec::new();
    let mut all_biases = Vec::new();
    let mut by_type: BTreeMap<String, TypeAccum> = BTreeMap::new();
    let mut type_order = Vec::new();
    let mut projects_evaluated = 0;

    for dataset in filtered_datasets(datasets, dataset_filter) {
        for project in &dataset.projects {
            if project.kloc <= 0.0 || project.effort_person_months <= 0.0 {
                continue;
            }

            let project_type = project
                .project_type
                .clone()
                .unwrap_or_else(|| "semidetached".to_string());
            remember_order(&mut type_order, &project_type);
            let coeffs = coefficients
                .get(&project_type)
                .or_else(|| coefficients.get("semidetached"))
                .copied()
                .unwrap_or(DEFAULT_BASIC_COEFFS);
            let predicted = coeffs.a * project.kloc.powf(coeffs.b);
            let actual = project.effort_person_months;
            let error_percent = ((predicted - actual) / actual) * 100.0;
            let abs_error = error_percent.abs();

            all_errors.push(abs_error);
            all_biases.push(error_percent);
            projects_evaluated += 1;

            let entry = by_type.entry(project_type).or_default();
            entry.errors.push(abs_error);
            entry.biases.push(error_percent);
        }
    }

    if projects_evaluated == 0 {
        return Err(ToolError::new(
            "No valid projects found in COCOMO calibration data (all projects had kloc <= 0 or effort <= 0).",
            "Check that calibration datasets contain projects with positive kloc and effort values.",
        ));
    }

    let mape = average(&all_errors);
    let bias = average(&all_biases);
    let mut by_project_type = BTreeMap::new();
    for (project_type, entry) in &by_type {
        by_project_type.insert(
            project_type.clone(),
            CocomoProjectTypeMetrics {
                mape: average(&entry.errors),
                count: entry.errors.len(),
            },
        );
    }

    let mut recommended_adjustments = Vec::new();
    for (project_type, entry) in &by_type {
        let coeffs = coefficients
            .get(project_type)
            .or_else(|| coefficients.get("semidetached"))
            .copied()
            .unwrap_or(DEFAULT_BASIC_COEFFS);
        let type_mape = average(&entry.errors);
        let type_bias = average(&entry.biases);

        if project_type == "organic" && type_mape > 30.0 {
            let adjusted_a = coeffs.a * (1.0 + type_bias / 100.0);
            recommended_adjustments.push(CocomoRecommendedAdjustment {
                parameter: "organic.a".to_string(),
                current_value: coeffs.a,
                recommended_value: round2(adjusted_a),
                reason: format!(
                    "Organic MAPE is {}%, exceeding 30% threshold. Adjust coefficient a to reduce prediction error.",
                    type_mape.round()
                ),
            });
        }

        if project_type == "embedded" && type_mape > 30.0 {
            let adjusted_b = coeffs.b * (1.0 + type_bias / 200.0);
            recommended_adjustments.push(CocomoRecommendedAdjustment {
                parameter: "embedded.b".to_string(),
                current_value: coeffs.b,
                recommended_value: round3(adjusted_b),
                reason: format!(
                    "Embedded MAPE is {}%, exceeding 30% threshold. Adjust coefficient b to reduce prediction error.",
                    type_mape.round()
                ),
            });
        }
    }

    if bias.abs() > 20.0 {
        let scale_factor = 1.0 - bias / 100.0;
        recommended_adjustments.push(CocomoRecommendedAdjustment {
            parameter: "overall_scale_factor".to_string(),
            current_value: 1.0,
            recommended_value: round2(scale_factor),
            reason: format!(
                "Overall bias is {}%, exceeding 20% threshold. Apply scale factor to correct systematic over/underprediction.",
                bias.round()
            ),
        });
    }

    let type_lines = type_order
        .iter()
        .filter_map(|project_type| {
            by_project_type.get(project_type).map(|data| {
                format!(
                    "  {project_type}: MAPE={}% ({data_count} projects)",
                    percent(data.mape.round()),
                    data_count = data.count
                )
            })
        })
        .collect::<Vec<_>>()
        .join("\n");
    let adjustment_line = if recommended_adjustments.is_empty() {
        "No adjustments recommended — model fits within acceptable thresholds.".to_string()
    } else {
        format!(
            "Recommended adjustments: {}.",
            recommended_adjustments
                .iter()
                .map(|adjustment| adjustment.parameter.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };

    Ok(CocomoValidationReport {
        projects_evaluated,
        mape: round2(mape),
        bias: round2(bias),
        by_project_type,
        recommended_adjustments,
        human_readable: [
            format!("COCOMO Validation Report: {projects_evaluated} projects evaluated."),
            format!("Overall MAPE: {}%, Bias: {}%.", mape.round(), bias.round()),
            type_lines,
            adjustment_line,
        ]
        .join("\n"),
    })
}

pub fn cocomo_validate_ground_truth(
    datasets: &[CocomoDataset],
    dataset_filter: Option<&[String]>,
    global_correction_factor: f64,
) -> Result<CocomoGroundTruthResult, ToolError> {
    if datasets.is_empty() {
        return Err(ToolError::new(
            "No COCOMO calibration data available.",
            "Ensure COCOMO calibration data files are present.",
        ));
    }

    let mut projects = Vec::new();
    let mut dataset_order = Vec::new();
    let mut type_order = Vec::new();
    for dataset in filtered_datasets(datasets, dataset_filter) {
        for project in &dataset.projects {
            if project.kloc <= 0.0 || project.effort_person_months <= 0.0 {
                continue;
            }
            remember_order(&mut dataset_order, &dataset.name);
            let project_type = project
                .project_type
                .clone()
                .unwrap_or_else(|| "semidetached".to_string());
            remember_order(&mut type_order, &project_type);
            projects.push(ProjectPrediction {
                actual: project.effort_person_months,
                dataset: dataset.name.clone(),
                project_type: project_type.clone(),
                models: predict_all(project.kloc, &project_type, global_correction_factor),
            });
        }
    }

    if projects.is_empty() {
        return Err(ToolError::new(
            "No valid projects found (all had kloc <= 0 or effort <= 0).",
            "Check that calibration datasets contain projects with positive kloc and effort.",
        ));
    }

    let actuals = projects
        .iter()
        .map(|project| project.actual)
        .collect::<Vec<_>>();
    let all_metrics = MODEL_ENTRIES
        .iter()
        .map(|entry| {
            compute_metrics(
                &projects
                    .iter()
                    .map(|project| project.models.value(entry.key))
                    .collect::<Vec<_>>(),
                &actuals,
                entry.label,
            )
        })
        .collect::<Vec<_>>();
    let winner = all_metrics
        .iter()
        .min_by(|left, right| left.mape.total_cmp(&right.mape))
        .expect("at least one model")
        .clone();

    let mut dataset_groups: BTreeMap<String, Vec<ProjectPrediction>> = BTreeMap::new();
    let mut type_groups: BTreeMap<String, Vec<ProjectPrediction>> = BTreeMap::new();
    for project in &projects {
        dataset_groups
            .entry(project.dataset.clone())
            .or_default()
            .push(project.clone());
        type_groups
            .entry(project.project_type.clone())
            .or_default()
            .push(project.clone());
    }

    let by_dataset = best_breakdown(dataset_groups);
    let by_type = best_breakdown(type_groups);
    let model_table = all_metrics
        .iter()
        .map(|metrics| {
            format!(
                "  {}: MAPE={}%, MMRE={}, PRED(25)={}, PRED(50)={}, bias={}%",
                metrics.name,
                format_number(metrics.mape),
                format_number(metrics.mmre),
                format_number(metrics.pred25),
                format_number(metrics.pred50),
                format_number(metrics.bias)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let ai_models = all_metrics
        .iter()
        .filter(|metrics| metrics.name.contains("AI"))
        .collect::<Vec<_>>();
    let best_ai = ai_models
        .iter()
        .min_by(|left, right| left.mape.total_cmp(&right.mape))
        .copied()
        .unwrap_or(&winner);
    let traditional_best = all_metrics
        .iter()
        .filter(|metrics| !metrics.name.contains("AI"))
        .min_by(|left, right| left.mape.total_cmp(&right.mape))
        .expect("traditional model");
    let ai_speedup_12 = all_metrics
        .iter()
        .find(|metrics| metrics.name == "COCOMO II + AI 12x");
    let conclusion = if ai_speedup_12.map(|metrics| metrics.pred25).unwrap_or(0.0) < 0.05 {
        format!(
            "Best model: {} (MAPE={}%). WARNING: The 12x AI speedup divisor produces catastrophic underprediction (PRED(25)=0%, bias={}%). These are pre-LLM projects — the speedup factor needs empirical validation against modern AI-assisted project data, not historical human-only data. Best traditional model: {} at {}% MAPE.",
            winner.name,
            percent(winner.mape),
            ai_speedup_12
                .map(|metrics| format_number(metrics.bias))
                .unwrap_or_else(|| "unknown".to_string()),
            traditional_best.name,
            format_number(traditional_best.mape),
        )
    } else {
        format!(
            "Best model: {} (MAPE={}%). AI speedup models show {} PRED(25) vs traditional COCOMO.",
            winner.name,
            percent(winner.mape),
            if best_ai.pred25 > traditional_best.pred25 {
                "better"
            } else {
                "comparable"
            }
        )
    };

    let dataset_line = dataset_order
        .iter()
        .filter_map(|name| {
            by_dataset.get(name).map(|data| {
                format!(
                    "{name}({}): {} at {}%",
                    data.count,
                    data.best_model,
                    format_number(data.best_mape)
                )
            })
        })
        .collect::<Vec<_>>()
        .join(" | ");
    let type_line = type_order
        .iter()
        .filter_map(|name| {
            by_type.get(name).map(|data| {
                format!(
                    "{name}({}): {} at {}%",
                    data.count,
                    data.best_model,
                    format_number(data.best_mape)
                )
            })
        })
        .collect::<Vec<_>>()
        .join(" | ");

    Ok(CocomoGroundTruthResult {
        projects_evaluated: projects.len(),
        models: all_metrics,
        by_dataset,
        by_type,
        winner: winner.name,
        conclusion: conclusion.clone(),
        human_readable: [
            format!(
                "COCOMO Ground Truth Validation: {} projects evaluated.",
                projects.len()
            ),
            "Model Comparison:".to_string(),
            model_table,
            String::new(),
            format!("By Dataset: {dataset_line}"),
            format!("By Type: {type_line}"),
            String::new(),
            conclusion,
        ]
        .join("\n"),
    })
}

fn best_breakdown(
    groups: BTreeMap<String, Vec<ProjectPrediction>>,
) -> BTreeMap<String, CocomoBestBreakdown> {
    groups
        .into_iter()
        .map(|(group_name, group_projects)| {
            let actuals = group_projects
                .iter()
                .map(|project| project.actual)
                .collect::<Vec<_>>();
            let mut best_model = "";
            let mut best_mape = f64::INFINITY;
            for entry in MODEL_ENTRIES {
                let metrics = compute_metrics(
                    &group_projects
                        .iter()
                        .map(|project| project.models.value(entry.key))
                        .collect::<Vec<_>>(),
                    &actuals,
                    entry.label,
                );
                if metrics.mape < best_mape {
                    best_mape = metrics.mape;
                    best_model = entry.label;
                }
            }
            (
                group_name,
                CocomoBestBreakdown {
                    count: group_projects.len(),
                    best_model: best_model.to_string(),
                    best_mape: round2(best_mape),
                },
            )
        })
        .collect()
}

fn predict_all(kloc: f64, project_type: &str, global_correction_factor: f64) -> PredictionSet {
    let coeffs = default_coefficients()
        .get(project_type)
        .copied()
        .unwrap_or(DEFAULT_BASIC_COEFFS);
    let basic = coeffs.a * kloc.powf(coeffs.b);
    let nominal = 2.94 * kloc.powf(1.10);
    let ai_speedup = nominal / 12.0;

    PredictionSet {
        basic,
        nominal,
        ai_speedup,
        ai_profile_0: ai_speedup * profile_correction_factor(0.0, global_correction_factor),
        ai_profile_05: ai_speedup * profile_correction_factor(0.5, global_correction_factor),
        ai_profile_1: ai_speedup * profile_correction_factor(1.0, global_correction_factor),
    }
}

fn compute_metrics(
    predictions: &[f64],
    actuals: &[f64],
    name: impl Into<String>,
) -> CocomoModelMetrics {
    let count = predictions.len();
    if count == 0 {
        return CocomoModelMetrics {
            name: name.into(),
            mape: 0.0,
            mmre: 0.0,
            pred25: 0.0,
            pred50: 0.0,
            bias: 0.0,
            count: 0,
        };
    }

    let mut sum_abs_pct_err = 0.0;
    let mut sum_mre = 0.0;
    let mut within25 = 0;
    let mut within50 = 0;
    let mut sum_bias = 0.0;

    for (predicted, actual) in predictions.iter().zip(actuals.iter()) {
        let rel_err = (predicted - actual).abs() / actual;
        sum_abs_pct_err += rel_err * 100.0;
        sum_mre += rel_err;
        if rel_err <= 0.25 {
            within25 += 1;
        }
        if rel_err <= 0.50 {
            within50 += 1;
        }
        sum_bias += (predicted - actual) / actual;
    }

    CocomoModelMetrics {
        name: name.into(),
        mape: round2(sum_abs_pct_err / count as f64),
        mmre: round3(sum_mre / count as f64),
        pred25: round3(within25 as f64 / count as f64),
        pred50: round3(within50 as f64 / count as f64),
        bias: round2((sum_bias / count as f64) * 100.0),
        count,
    }
}

fn filtered_datasets<'a>(
    datasets: &'a [CocomoDataset],
    dataset_filter: Option<&[String]>,
) -> Vec<&'a CocomoDataset> {
    match dataset_filter {
        Some(filter) => datasets
            .iter()
            .filter(|dataset| filter.iter().any(|name| name == &dataset.name))
            .collect(),
        None => datasets.iter().collect(),
    }
}

fn coefficients_with_overrides(
    derived: Option<&BTreeMap<String, CocomoBasicCoefficients>>,
) -> BTreeMap<String, CocomoBasicCoefficients> {
    let mut coefficients = default_coefficients();
    if let Some(derived) = derived {
        for (project_type, factors) in derived {
            coefficients.insert(project_type.clone(), *factors);
        }
    }
    coefficients
}

fn default_coefficients() -> BTreeMap<String, CocomoBasicCoefficients> {
    BTreeMap::from([
        (
            "organic".to_string(),
            CocomoBasicCoefficients {
                a: 2.4,
                b: 1.05,
                c: None,
                d: None,
            },
        ),
        (
            "semidetached".to_string(),
            CocomoBasicCoefficients {
                a: 3.0,
                b: 1.12,
                c: None,
                d: None,
            },
        ),
        (
            "embedded".to_string(),
            CocomoBasicCoefficients {
                a: 3.6,
                b: 1.20,
                c: None,
                d: None,
            },
        ),
    ])
}

impl PredictionSet {
    fn value(self, key: ModelKey) -> f64 {
        match key {
            ModelKey::Basic => self.basic,
            ModelKey::Nominal => self.nominal,
            ModelKey::AiSpeedup => self.ai_speedup,
            ModelKey::AiProfile0 => self.ai_profile_0,
            ModelKey::AiProfile05 => self.ai_profile_05,
            ModelKey::AiProfile1 => self.ai_profile_1,
        }
    }
}

fn profile_correction_factor(ai_ratio: f64, global_correction_factor: f64) -> f64 {
    // Mirror the developer-profile gradient so the COCOMO "AI + Profile" models
    // use the same resolved global correction factor as the enrichment path.
    crate::profiles::developer_profile(ai_ratio, global_correction_factor).correction_factor
}

fn average(values: &[f64]) -> f64 {
    values.iter().copied().sum::<f64>() / values.len() as f64
}

fn remember_order(order: &mut Vec<String>, value: &str) {
    if !order.iter().any(|seen| seen == value) {
        order.push(value.to_string());
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        return format!("{value:.0}");
    }
    let mut out = format!("{value:.3}");
    while out.contains('.') && out.ends_with('0') {
        out.pop();
    }
    if out.ends_with('.') {
        out.pop();
    }
    out
}

fn percent(value: f64) -> String {
    format_number(value)
}

#[cfg(test)]
mod tests {
    use super::{cocomo_validate, cocomo_validate_ground_truth};
    use epoch_contract::{CocomoBasicCoefficients, CocomoDataset, CocomoProject};
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn validation_returns_error_without_data() {
        let result = cocomo_validate(&[], None, None);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .message
                .contains("COCOMO calibration data not found")
        );
    }

    #[test]
    fn validation_computes_exact_mape_for_known_project() {
        let predicted = 2.4_f64 * 10.0_f64.powf(1.05);
        let datasets = vec![dataset(
            "exact-dataset",
            vec![project(1, 10.0, predicted, Some("organic"))],
        )];
        let result = cocomo_validate(&datasets, None, None).expect("valid");

        assert_eq!(result.projects_evaluated, 1);
        assert!(result.mape < 0.01);
        assert!(result.bias.abs() < 0.01);
        assert_eq!(result.by_project_type["organic"].count, 1);
    }

    #[test]
    fn validation_groups_types_and_respects_dataset_filter() {
        let datasets = vec![
            dataset(
                "dataset-a",
                vec![
                    project(1, 10.0, 24.0, Some("organic")),
                    project(2, 20.0, 50.0, Some("organic")),
                ],
            ),
            dataset(
                "dataset-b",
                vec![
                    project(3, 15.0, 60.0, Some("embedded")),
                    project(4, 8.0, 30.0, Some("semidetached")),
                ],
            ),
        ];
        let filter = vec!["dataset-b".to_string()];
        let result = cocomo_validate(&datasets, None, Some(&filter)).expect("valid");

        assert_eq!(result.projects_evaluated, 2);
        assert!(result.by_project_type.contains_key("embedded"));
        assert!(result.by_project_type.contains_key("semidetached"));
        assert!(!result.by_project_type.contains_key("organic"));
    }

    #[test]
    fn validation_human_readable_preserves_typescript_type_order() {
        let datasets = vec![dataset(
            "order",
            vec![
                project(1, 8.0, 30.0, None),
                project(2, 30.0, 80.0, Some("embedded")),
                project(3, 10.0, 24.0, Some("organic")),
            ],
        )];

        let result = cocomo_validate(&datasets, None, None).expect("valid");

        assert_before(&result.human_readable, "  semidetached:", "  embedded:");
        assert_before(&result.human_readable, "  embedded:", "  organic:");
    }

    #[test]
    fn validation_reports_invalid_project_error() {
        let datasets = vec![dataset(
            "bad-dataset",
            vec![
                project(1, 0.0, 10.0, Some("organic")),
                project(2, 10.0, 0.0, Some("organic")),
            ],
        )];
        let result = cocomo_validate(&datasets, None, None);

        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No valid projects"));
    }

    #[test]
    fn validation_uses_derived_coefficients_and_recommends_adjustments() {
        let datasets = vec![dataset(
            "derived",
            vec![
                project(1, 50.0, 50.0, Some("organic")),
                project(2, 100.0, 10.0, Some("embedded")),
            ],
        )];
        let mut derived = BTreeMap::new();
        derived.insert(
            "organic".to_string(),
            CocomoBasicCoefficients {
                a: 1.0,
                b: 1.0,
                c: Some(0.0),
                d: Some(0.0),
            },
        );

        let result = cocomo_validate(&datasets, Some(&derived), None).expect("valid");

        assert!(result.mape > 0.0);
        assert!(result.human_readable.contains("COCOMO Validation Report"));
        assert!(
            result
                .recommended_adjustments
                .iter()
                .any(|adjustment| adjustment.parameter == "embedded.b")
        );
        assert!(
            result
                .recommended_adjustments
                .iter()
                .any(|adjustment| adjustment.parameter == "overall_scale_factor")
        );
    }

    #[test]
    fn ground_truth_returns_error_without_data_or_matching_filter() {
        assert!(cocomo_validate_ground_truth(&[], None, 1.07).is_err());

        let datasets = vec![dataset(
            "dataset-a",
            vec![project(1, 10.0, 24.0, Some("organic"))],
        )];
        let filter = vec!["missing".to_string()];
        let result = cocomo_validate_ground_truth(&datasets, Some(&filter), 1.07);
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No valid projects"));
    }

    #[test]
    fn ground_truth_compares_six_models_and_picks_winner() {
        let datasets = sample_ground_truth_datasets();
        let result = cocomo_validate_ground_truth(&datasets, None, 1.07).expect("valid");

        assert_eq!(result.projects_evaluated, 4);
        assert_eq!(result.models.len(), 6);
        assert!(result.human_readable.contains("Ground Truth"));
        assert!(result.by_dataset.contains_key("COCOMO81"));
        assert!(result.by_type.contains_key("embedded"));

        let winner_mape = result
            .models
            .iter()
            .find(|metrics| metrics.name == result.winner)
            .expect("winner exists")
            .mape;
        let lowest = result
            .models
            .iter()
            .map(|metrics| metrics.mape)
            .fold(f64::INFINITY, f64::min);
        assert_eq!(winner_mape, lowest);
    }

    #[test]
    fn ground_truth_respects_dataset_filter() {
        let datasets = sample_ground_truth_datasets();
        let filter = vec!["NASA93".to_string()];
        let result = cocomo_validate_ground_truth(&datasets, Some(&filter), 1.07).expect("valid");

        assert_eq!(result.projects_evaluated, 2);
        assert!(result.by_dataset.contains_key("NASA93"));
        assert!(!result.by_dataset.contains_key("COCOMO81"));
    }

    #[test]
    fn ground_truth_human_readable_preserves_typescript_type_order() {
        let datasets = vec![dataset(
            "order",
            vec![
                project(1, 8.0, 30.0, None),
                project(2, 30.0, 80.0, Some("embedded")),
                project(3, 10.0, 24.0, Some("organic")),
            ],
        )];

        let result = cocomo_validate_ground_truth(&datasets, None, 1.07).expect("valid");
        let by_type = result
            .human_readable
            .lines()
            .find(|line| line.starts_with("By Type:"))
            .expect("by type line");

        assert_before(by_type, "semidetached(", "embedded(");
        assert_before(by_type, "embedded(", "organic(");
    }

    #[test]
    fn ground_truth_serializes_ts_shape_and_valid_pred_ranges() {
        let datasets = sample_ground_truth_datasets();
        let result = cocomo_validate_ground_truth(&datasets, None, 1.07).expect("valid");

        for metrics in &result.models {
            assert!((0.0..=1.0).contains(&metrics.pred25));
            assert!((0.0..=1.0).contains(&metrics.pred50));
            assert!(metrics.pred50 >= metrics.pred25);
            assert!(metrics.count > 0);
        }

        let serialized = serde_json::to_value(&result).expect("serializes");
        assert_eq!(serialized["projectsEvaluated"], json!(4));
        assert_eq!(serialized["models"][0]["name"], json!("COCOMO Basic"));
        assert!(serialized["byDataset"]["COCOMO81"]["bestModel"].is_string());
        assert!(serialized["byType"]["organic"]["bestMape"].is_number());
    }

    fn sample_ground_truth_datasets() -> Vec<CocomoDataset> {
        vec![
            dataset(
                "COCOMO81",
                vec![
                    project(1, 113.0, 2040.0, Some("embedded")),
                    project(2, 10.0, 24.0, Some("organic")),
                ],
            ),
            dataset(
                "NASA93",
                vec![
                    project(3, 30.0, 80.0, Some("embedded")),
                    project(4, 8.0, 30.0, None),
                ],
            ),
        ]
    }

    fn dataset(name: &str, projects: Vec<CocomoProject>) -> CocomoDataset {
        CocomoDataset {
            name: name.to_string(),
            projects,
        }
    }

    fn project(
        id: u32,
        kloc: f64,
        effort_person_months: f64,
        project_type: Option<&str>,
    ) -> CocomoProject {
        CocomoProject {
            id,
            kloc,
            effort_person_months,
            project_type: project_type.map(str::to_string),
            language: None,
            year: None,
            category: None,
            function_points: None,
            effort_work_hours: None,
            duration_months: None,
        }
    }

    fn assert_before(haystack: &str, first: &str, second: &str) {
        let first_index = haystack.find(first).expect("first marker present");
        let second_index = haystack.find(second).expect("second marker present");
        assert!(
            first_index < second_index,
            "expected {first:?} before {second:?} in {haystack}"
        );
    }
}
