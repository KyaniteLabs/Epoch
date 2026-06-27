use epoch_contract::{CocomoBasicCoefficients, CocomoDataset, TaskType};
use serde::{Deserialize, Serialize, de::Error as _};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Reference-database fallback when no `globalCorrectionFactor` is available.
/// Mirrors the TypeScript `getGlobalCorrectionFactor()` default in
/// `src/lib/self-improve.ts`.
pub const DEFAULT_GLOBAL_CORRECTION_FACTOR: f64 = 1.07;

pub const BUNDLED_COCOMO_CALIBRATION_JSON: &str =
    include_str!("../../../../data/cocomo-calibration-data.json");
pub const BUNDLED_SUPPLEMENTARY_DATABASE_JSON: &str =
    include_str!("../../../../data/supplementary-database.json");
pub const BUNDLED_REFERENCE_DATABASE_JSON: &str =
    include_str!("../../../../src/data/reference-database.json");

pub use epoch_contract::PublicSurfaceContract;

pub type CocomoBasicCoefficientMap = BTreeMap<String, CocomoBasicCoefficients>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CocomoCalibrationFile {
    pub cocomo_calibration: CocomoCalibration,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CocomoCalibration {
    pub source: Option<String>,
    pub description: Option<String>,
    pub project_count: Option<usize>,
    pub datasets: Vec<CocomoDataset>,
    pub derived_factors: CocomoDerivedFactors,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CocomoDerivedFactors {
    #[serde(deserialize_with = "deserialize_cocomo_basic")]
    pub cocomo_basic: CocomoBasicCoefficientMap,
}

fn deserialize_cocomo_basic<'de, D>(deserializer: D) -> Result<CocomoBasicCoefficientMap, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = BTreeMap::<String, Value>::deserialize(deserializer)?;
    let mut coefficients = BTreeMap::new();
    for (key, value) in raw {
        if !value.is_object() {
            continue;
        }
        let parsed = serde_json::from_value(value).map_err(D::Error::custom)?;
        coefficients.insert(key, parsed);
    }
    Ok(coefficients)
}

pub fn bundled_cocomo_calibration() -> Result<CocomoCalibration, serde_json::Error> {
    serde_json::from_str::<CocomoCalibrationFile>(BUNDLED_COCOMO_CALIBRATION_JSON)
        .map(|file| file.cocomo_calibration)
}

pub fn bundled_cocomo_datasets() -> Result<Vec<CocomoDataset>, serde_json::Error> {
    bundled_cocomo_calibration().map(|calibration| calibration.datasets)
}

pub fn bundled_cocomo_basic_coefficients() -> Result<CocomoBasicCoefficientMap, serde_json::Error> {
    bundled_cocomo_calibration().map(|calibration| calibration.derived_factors.cocomo_basic)
}

pub fn bundled_supplementary_database() -> Result<Value, serde_json::Error> {
    serde_json::from_str(BUNDLED_SUPPLEMENTARY_DATABASE_JSON)
}

pub fn bundled_reference_database() -> Result<Value, serde_json::Error> {
    serde_json::from_str(BUNDLED_REFERENCE_DATABASE_JSON)
}

/// Resolve the global correction factor exactly like the TypeScript
/// `getGlobalCorrectionFactor()` (`src/lib/self-improve.ts`): prefer a
/// `reference-database.json` under `$EPOCH_DATA_DIR`, then `$HOME/.epoch`, then
/// the bundled copy, and read its `globalCorrectionFactor` (default 1.07).
///
/// Keeping the same resolution as TypeScript is what makes the Rust developer
/// profile, calibration fallback, and COCOMO ground-truth metrics agree with
/// the TS contract in every environment — not just where `~/.epoch` happens to
/// exist.
pub fn resolve_global_correction_factor() -> f64 {
    resolve_reference_database()
        .as_ref()
        .and_then(|db| db.get("globalCorrectionFactor"))
        .and_then(Value::as_f64)
        .unwrap_or(DEFAULT_GLOBAL_CORRECTION_FACTOR)
}

/// Resolve the token-time calibration used by TypeScript `tokenTimeBridge()`.
/// Prefer `tokenTimeCalibration[model]`; use `_default` only for unknown models.
pub fn resolve_token_time_calibration_tps(model: &str, use_default: bool) -> Option<f64> {
    let db = resolve_reference_database()?;
    let calibrations = db.get("tokenTimeCalibration")?;
    if let Some(tps) = calibrations.get(model).and_then(median_tps) {
        return Some(tps);
    }
    if use_default {
        return calibrations.get("_default").and_then(median_tps);
    }
    None
}

/// Resolve the sparse-data correction factor for `reference_class_estimate`
/// using the same priority order as TypeScript `getCorrectionFactorForTaskType`:
/// complexity-aware, tool-specific, task-type, canary task-type, industry.
pub fn resolve_reference_correction_factor(
    task_type: TaskType,
    tool: Option<&str>,
    complexity: Option<f64>,
) -> f64 {
    let Some(db) = resolve_reference_database() else {
        return industry_correction_factor(task_type);
    };

    reference_correction_factor_from_db(&db, task_type, tool, complexity)
}

fn reference_correction_factor_from_db(
    db: &Value,
    task_type: TaskType,
    tool: Option<&str>,
    complexity: Option<f64>,
) -> f64 {
    if let Some(complexity) = complexity {
        if let Some(factor) = complexity_correction_factor(db, task_type, complexity) {
            return factor;
        }
    }

    if let Some(tool) = tool {
        if let Some(factor) =
            nested_factor(db, "toolTaskCorrectionFactors", tool, task_type.as_str())
        {
            return factor;
        }
    }

    if let Some(factor) = top_level_factor(db, "taskTypeCorrectionFactors", task_type.as_str()) {
        return factor;
    }

    let canary_key = canary_task_key(task_type);
    if let Some(factor) = db
        .get("estimationAccuracy")
        .and_then(|value| value.get("correctionFactors"))
        .and_then(|value| value.get("byTaskType"))
        .and_then(|value| value.get(canary_key))
        .and_then(Value::as_f64)
    {
        return factor;
    }
    if let Some(factor) = db
        .get("estimationAccuracy")
        .and_then(|value| value.get("taskTypes"))
        .and_then(|value| value.get(canary_key))
        .and_then(|value| value.get("correctionFactor"))
        .and_then(Value::as_f64)
    {
        return factor;
    }

    industry_correction_factor(task_type)
}

fn complexity_correction_factor(db: &Value, task_type: TaskType, complexity: f64) -> Option<f64> {
    let complexity_key = json_number_key(complexity);
    nested_factor(
        db,
        "complexityCorrectionFactors",
        task_type.as_str(),
        &complexity_key,
    )
}

fn nested_factor(db: &Value, section: &str, first: &str, second: &str) -> Option<f64> {
    db.get(section)?
        .get(first)?
        .get(second)?
        .as_f64()
        .filter(|value| value.is_finite())
}

fn top_level_factor(db: &Value, section: &str, key: &str) -> Option<f64> {
    db.get(section)?
        .get(key)?
        .as_f64()
        .filter(|value| value.is_finite())
}

fn median_tps(calibration: &Value) -> Option<f64> {
    calibration
        .get("medianTps")
        .or_else(|| calibration.get("medianTokensPerSecond"))?
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn json_number_key(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn canary_task_key(task_type: TaskType) -> &'static str {
    match task_type {
        TaskType::Feature => "pert_estimation",
        TaskType::Bugfix => "calendar_calculation",
        TaskType::Refactor | TaskType::Migration => "cocomo_estimation",
        TaskType::Infrastructure => "token_time_bridge",
        TaskType::Documentation => "other",
        TaskType::Testing => "calibration",
        TaskType::Design => "reference_class",
    }
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

/// Load the reference database following the TypeScript resolution order:
/// `$EPOCH_DATA_DIR/reference-database.json`, then
/// `$HOME/.epoch/reference-database.json`, then the bundled copy.
fn resolve_reference_database() -> Option<Value> {
    reference_database_candidates()
        .iter()
        .find_map(|path| {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        })
        .or_else(|| bundled_reference_database().ok())
}

fn reference_database_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = std::env::var_os("EPOCH_DATA_DIR") {
        candidates.push(PathBuf::from(dir).join("reference-database.json"));
    }
    if let Some(home) = home_dir() {
        candidates.push(home.join(".epoch").join("reference-database.json"));
    }
    candidates
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub fn crate_label() -> &'static str {
    "epoch-data"
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_cocomo_basic_coefficients, bundled_cocomo_calibration, bundled_reference_database,
        bundled_supplementary_database, crate_label, reference_correction_factor_from_db,
        resolve_global_correction_factor, resolve_token_time_calibration_tps,
    };
    use epoch_contract::TaskType;
    use epoch_core::cocomo::{cocomo_validate, cocomo_validate_ground_truth};

    #[test]
    fn reports_crate_label() {
        assert_eq!(crate_label(), "epoch-data");
    }

    #[test]
    fn loads_bundled_cocomo_calibration_data() {
        let calibration = bundled_cocomo_calibration().expect("bundled COCOMO data parses");
        let dataset_names = calibration
            .datasets
            .iter()
            .map(|dataset| dataset.name.as_str())
            .collect::<Vec<_>>();
        let project_count = calibration
            .datasets
            .iter()
            .map(|dataset| dataset.projects.len())
            .sum::<usize>();

        assert_eq!(dataset_names, ["COCOMO81", "NASA93", "Albrecht", "Kemerer"]);
        assert_eq!(project_count, 195);
        assert_eq!(calibration.datasets[1].projects.len(), 93);
        assert!(
            calibration
                .derived_factors
                .cocomo_basic
                .contains_key("organic")
        );
    }

    #[test]
    fn exposes_bundled_cocomo_basic_coefficients() {
        let coefficients = bundled_cocomo_basic_coefficients().expect("bundled coefficients parse");

        assert!(coefficients["organic"].a > 0.0);
        assert!(coefficients["semidetached"].b > 0.0);
        assert!(coefficients["embedded"].c.is_some());
    }

    #[test]
    fn bundled_cocomo_data_drives_validation_tools() {
        let calibration = bundled_cocomo_calibration().expect("bundled COCOMO data parses");
        let report = cocomo_validate(
            &calibration.datasets,
            Some(&calibration.derived_factors.cocomo_basic),
            None,
        )
        .expect("bundled validation succeeds");
        let ground_truth = cocomo_validate_ground_truth(
            &calibration.datasets,
            None,
            resolve_global_correction_factor(),
        )
        .expect("bundled ground truth succeeds");

        assert_eq!(report.projects_evaluated, 182);
        assert_eq!(ground_truth.projects_evaluated, 182);
        assert_eq!(ground_truth.models.len(), 6);
        assert!(!ground_truth.winner.is_empty());
    }

    #[test]
    fn bundled_cocomo_validation_respects_dataset_filter() {
        let calibration = bundled_cocomo_calibration().expect("bundled COCOMO data parses");
        let filter = vec!["NASA93".to_string()];
        let report = cocomo_validate(
            &calibration.datasets,
            Some(&calibration.derived_factors.cocomo_basic),
            Some(&filter),
        )
        .expect("filtered bundled validation succeeds");

        assert_eq!(report.projects_evaluated, 93);
    }

    #[test]
    fn resolves_a_positive_global_correction_factor() {
        // Resolution is environment-dependent (EPOCH_DATA_DIR → ~/.epoch →
        // bundled), but every source yields a positive, finite factor.
        let factor = resolve_global_correction_factor();
        assert!(factor.is_finite());
        assert!(factor > 0.0);
    }

    #[test]
    fn resolves_token_time_default_calibration_for_unknown_models() {
        let tps = resolve_token_time_calibration_tps("unknown-model", true)
            .expect("bundled default token-time calibration resolves");

        assert!(tps.is_finite());
        assert!(tps > 75.0);
    }

    #[test]
    fn skips_token_time_default_calibration_when_not_requested() {
        assert_eq!(
            resolve_token_time_calibration_tps("unknown-model", false),
            None
        );
    }

    #[test]
    fn resolves_reference_correction_factor_with_typescript_priority_order() {
        let db = bundled_reference_database().expect("bundled reference database parses");

        // Complexity-aware factors win over tool/task factors.
        assert_eq!(
            reference_correction_factor_from_db(
                &db,
                TaskType::Feature,
                Some("reference_class_estimate"),
                Some(4.0),
            ),
            1.0,
        );
        // Without a complexity match, the reference_class_estimate tool factor wins.
        assert_eq!(
            reference_correction_factor_from_db(
                &db,
                TaskType::Feature,
                Some("reference_class_estimate"),
                None,
            ),
            0.51,
        );
        // Without a tool match, fall back to the aggregate task-type factor.
        assert_eq!(
            reference_correction_factor_from_db(&db, TaskType::Design, None, None),
            0.59,
        );
    }

    #[test]
    fn parses_bundled_supplementary_and_reference_databases() {
        let supplementary =
            bundled_supplementary_database().expect("bundled supplementary data parses");
        let reference = bundled_reference_database().expect("bundled reference data parses");

        assert!(supplementary.get("modelCalibration").is_some());
        assert!(supplementary.get("referenceClassBaselines").is_some());
        assert!(reference.get("toolExecutionBenchmarks").is_some());
        assert!(reference.get("taskTypeCorrectionFactors").is_some());
    }
}
