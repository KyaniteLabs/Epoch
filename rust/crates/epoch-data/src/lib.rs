use epoch_contract::{CocomoBasicCoefficients, CocomoDataset};
use serde::{Deserialize, Serialize, de::Error as _};
use serde_json::Value;
use std::collections::BTreeMap;

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

pub fn crate_label() -> &'static str {
    "epoch-data"
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_cocomo_basic_coefficients, bundled_cocomo_calibration, bundled_reference_database,
        bundled_supplementary_database, crate_label,
    };
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
        let ground_truth = cocomo_validate_ground_truth(&calibration.datasets, None)
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
