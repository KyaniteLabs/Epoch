// ---------------------------------------------------------------------------
// Developer profiles — AI-native / human / hybrid gradient interpolation.
//
// Mirrors the TypeScript `getDeveloperProfileGradient()` (`src/lib/profiles.ts`).
// `ai_ratio`: 0.0 = fully human, 1.0 = fully AI-native, 0.5 = equal mix. All
// fields interpolate linearly between the two anchor points.
//
// The human anchor values are the bundled-data medians from
// `data/supplementary-database.json` (which equal the TypeScript fallbacks):
// feature-dev 14d, bugfix 72h, velocity 35pts, estimation MAPE 25%.
// TypeScript divides the bundled `underestimationRate` value (0.575) by 100
// while building this profile, so the wire-compatible human anchor is 0.00575.
// The AI-native anchor is the fixed empirical constant set. Only the correction
// factor depends on the resolved global correction factor
// (`epoch_data::resolve_global_correction_factor()`), passed in so this crate
// stays free of filesystem/data dependencies.
// ---------------------------------------------------------------------------

/// Human anchor (fully human, `ai_ratio = 0.0`).
const HUMAN_FEATURE_DEV_TIME_DAYS: f64 = 14.0;
const HUMAN_BUGFIX_TIME_HOURS: f64 = 72.0;
const HUMAN_SPRINT_VELOCITY_POINTS: f64 = 35.0;
const HUMAN_ESTIMATION_MAPE: f64 = 25.0;
const HUMAN_UNDERESTIMATION_BIAS: f64 = 0.00575;
const HUMAN_CORRECTION_FACTOR: f64 = 1.8;

/// AI-native anchor (fully AI-native, `ai_ratio = 1.0`).
const AI_FEATURE_DEV_TIME_DAYS: f64 = 0.72;
const AI_BUGFIX_TIME_HOURS: f64 = 6.15;
const AI_SPRINT_VELOCITY_POINTS: f64 = 80.0;
const AI_ESTIMATION_MAPE: f64 = 15.0;
const AI_UNDERESTIMATION_BIAS: f64 = 0.2;

/// Floor applied to the AI-native correction factor, matching the TypeScript
/// `Math.max(0.1, getGlobalCorrectionFactor())`.
const MIN_CORRECTION_FACTOR: f64 = 0.1;

#[derive(Debug, Clone, PartialEq)]
pub struct DeveloperProfile {
    pub mode: &'static str,
    pub ai_ratio: f64,
    pub feature_dev_time_days: f64,
    pub bugfix_time_hours: f64,
    pub sprint_velocity_points: f64,
    pub estimation_mape: f64,
    pub underestimation_bias: f64,
    pub correction_factor: f64,
}

/// Compute the developer profile for a given AI ratio and resolved global
/// correction factor.
pub fn developer_profile(ai_ratio: f64, global_correction_factor: f64) -> DeveloperProfile {
    let clamped = ai_ratio.clamp(0.0, 1.0);
    let mode = if clamped >= 1.0 {
        "ai_native"
    } else if clamped <= 0.0 {
        "human"
    } else {
        "hybrid"
    };
    let ai_correction_factor = global_correction_factor.max(MIN_CORRECTION_FACTOR);

    DeveloperProfile {
        mode,
        ai_ratio: clamped,
        feature_dev_time_days: round2(lerp(
            HUMAN_FEATURE_DEV_TIME_DAYS,
            AI_FEATURE_DEV_TIME_DAYS,
            clamped,
        )),
        bugfix_time_hours: round2(lerp(HUMAN_BUGFIX_TIME_HOURS, AI_BUGFIX_TIME_HOURS, clamped)),
        sprint_velocity_points: round1(lerp(
            HUMAN_SPRINT_VELOCITY_POINTS,
            AI_SPRINT_VELOCITY_POINTS,
            clamped,
        )),
        estimation_mape: round1(lerp(HUMAN_ESTIMATION_MAPE, AI_ESTIMATION_MAPE, clamped)),
        underestimation_bias: round3(lerp(
            HUMAN_UNDERESTIMATION_BIAS,
            AI_UNDERESTIMATION_BIAS,
            clamped,
        )),
        correction_factor: round2(lerp(HUMAN_CORRECTION_FACTOR, ai_correction_factor, clamped)),
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::developer_profile;

    #[test]
    fn ai_native_anchor_uses_global_correction_factor() {
        let profile = developer_profile(1.0, 1.0);
        assert_eq!(profile.mode, "ai_native");
        assert_eq!(profile.correction_factor, 1.0);
        assert_eq!(profile.sprint_velocity_points, 80.0);
        assert_eq!(profile.estimation_mape, 15.0);
        assert_eq!(profile.underestimation_bias, 0.2);
    }

    #[test]
    fn human_anchor_is_independent_of_global_factor() {
        let profile = developer_profile(0.0, 1.0);
        assert_eq!(profile.mode, "human");
        assert_eq!(profile.correction_factor, 1.8);
        assert_eq!(profile.sprint_velocity_points, 35.0);
        assert_eq!(profile.estimation_mape, 25.0);
        assert_eq!(profile.underestimation_bias, 0.006);
    }

    #[test]
    fn hybrid_interpolates_correction_factor() {
        // lerp(1.8, 1.0, 0.5) = 1.4
        let profile = developer_profile(0.5, 1.0);
        assert_eq!(profile.mode, "hybrid");
        assert_eq!(profile.correction_factor, 1.4);
        assert_eq!(profile.underestimation_bias, 0.103);
        // lerp(1.8, 1.07, 0.5) = 1.435 -> 1.44
        let bundled = developer_profile(0.5, 1.07);
        assert_eq!(bundled.correction_factor, 1.44);
    }

    #[test]
    fn correction_factor_respects_floor() {
        // global factor below the floor clamps to 0.1 before interpolating.
        let profile = developer_profile(1.0, 0.0);
        assert_eq!(profile.correction_factor, 0.1);
    }
}
