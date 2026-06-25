use epoch_contract::{
    CocomoResult, EffortMultipliers, PertResult, RiskLevel, SpeedupCategory, SprintConfidence,
    SprintForecastResult, TimeUnit, ToolError, UrgencyCategory,
};

#[derive(Debug, Clone)]
pub struct SprintForecastParams {
    pub backlog_points: f64,
    pub velocity_history: Vec<f64>,
    pub sprint_length_days: f64,
    pub hours_per_sprint: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct CocomoParams {
    pub kloc: f64,
    pub reasoning_complexity: f64,
    pub context_completeness: f64,
    pub transformation_impact: f64,
    pub iterative_cycles: f64,
    pub human_oversight: f64,
}

pub fn pert_estimate(
    optimistic: f64,
    most_likely: f64,
    pessimistic: f64,
    unit: TimeUnit,
) -> Result<PertResult, ToolError> {
    if !all_finite(&[optimistic, most_likely, pessimistic])
        || !(optimistic > 0.0 && optimistic <= most_likely && most_likely <= pessimistic)
    {
        return Err(ToolError::new(
            format!(
                "PERT values must satisfy 0 < optimistic <= most_likely <= pessimistic. Got optimistic={optimistic}, most_likely={most_likely}, pessimistic={pessimistic}."
            ),
            "Provide three positive estimates where optimistic is smallest and pessimistic is largest.",
        ));
    }

    let expected = (optimistic + 4.0 * most_likely + pessimistic) / 6.0;
    let std_dev = (pessimistic - optimistic) / 6.0;
    let variance = std_dev * std_dev;
    let expected_hours = unit.to_hours(expected);

    if !all_finite(&[expected, std_dev, variance, expected_hours]) {
        return Err(ToolError::new(
            "Computation produced invalid result.",
            "Ensure all inputs are finite numbers and optimistic < mostLikely < pessimistic.",
        ));
    }

    let expected = round2(expected);
    let std_deviation = round2(std_dev);
    let variance = round2(variance);
    let confidence_95 = [
        round2((expected - 2.0 * std_dev).max(0.0)),
        round2(expected + 2.0 * std_dev),
    ];
    let confidence_99 = [
        round2((expected - 3.0 * std_dev).max(0.0)),
        round2(expected + 3.0 * std_dev),
    ];
    let urgency_category = UrgencyCategory::from_hours(expected_hours);

    Ok(PertResult {
        optimistic,
        most_likely,
        pessimistic,
        expected,
        variance,
        std_deviation,
        confidence_95,
        confidence_99,
        unit,
        urgency_category,
        risk_level: compute_pert_risk_level(optimistic, most_likely, pessimistic),
        human_readable: format!(
            "Expected: {} {}. 95% confidence: {} to {} {}. 99% confidence: {} to {} {}.",
            format_number(expected),
            unit.as_str(),
            format_number(confidence_95[0]),
            format_number(confidence_95[1]),
            unit.as_str(),
            format_number(confidence_99[0]),
            format_number(confidence_99[1]),
            unit.as_str(),
        ),
    })
}

pub fn sprint_forecast(params: SprintForecastParams) -> Result<SprintForecastResult, ToolError> {
    let SprintForecastParams {
        backlog_points,
        velocity_history,
        sprint_length_days,
        hours_per_sprint,
    } = params;

    if velocity_history.is_empty() {
        return Err(ToolError::new(
            "velocity_history cannot be empty. Provide at least one sprint's velocity.",
            "Pass an array of story points completed per past sprint.",
        ));
    }

    for (index, velocity) in velocity_history.iter().enumerate() {
        if !velocity.is_finite() || *velocity < 0.0 {
            return Err(ToolError::new(
                format!(
                    "velocity_history[{index}] is invalid: {velocity}. Each velocity must be a non-negative finite number."
                ),
                "Provide non-negative numeric velocity values for each sprint.",
            ));
        }
    }

    if !backlog_points.is_finite() || backlog_points <= 0.0 {
        return Err(ToolError::new(
            "backlog_points must be positive.",
            "Provide a positive number for backlog_points.",
        ));
    }

    let average_velocity =
        velocity_history.iter().copied().sum::<f64>() / velocity_history.len() as f64;

    if average_velocity <= 0.0 {
        return Err(ToolError::new(
            format!(
                "Average velocity is 0 across {} sprint(s). Cannot forecast with zero velocity — the backlog will never clear.",
                velocity_history.len()
            ),
            "Include sprints with positive velocity, or estimate velocity from team capacity.",
        ));
    }

    let required_sprints = backlog_points / average_velocity;
    let conversion_factor = hours_per_sprint / average_velocity;
    let total_hours = backlog_points * conversion_factor;

    if !all_finite(&[required_sprints, conversion_factor, total_hours]) {
        return Err(ToolError::new(
            "Sprint forecast produced non-finite result. Check inputs for Infinity or extreme values.",
            "Use reasonable values for backlog_points, hours_per_sprint, and velocity_history.",
        ));
    }

    let (optimistic_sprints, pessimistic_sprints, velocity_cv) = if velocity_history.len() > 1 {
        let variance = velocity_history
            .iter()
            .map(|velocity| (velocity - average_velocity).powi(2))
            .sum::<f64>()
            / (velocity_history.len() as f64 - 1.0);
        let std_velocity = variance.sqrt();
        let velocity_cv = round2(std_velocity / average_velocity);
        (
            backlog_points / (average_velocity + std_velocity),
            backlog_points / (average_velocity - std_velocity).max(0.1),
            velocity_cv,
        )
    } else {
        (required_sprints * 0.75, required_sprints * 1.5, 0.0)
    };

    Ok(SprintForecastResult {
        backlog_points,
        average_velocity: round1(average_velocity),
        required_sprints: round1(required_sprints),
        optimistic_sprints: round1(optimistic_sprints),
        pessimistic_sprints: round1(pessimistic_sprints),
        hours_per_point: round2(conversion_factor),
        total_hours: round1(total_hours),
        completion_days: (required_sprints * sprint_length_days).round() as i64,
        sprint_length_days,
        confidence: compute_sprint_confidence(velocity_history.len(), velocity_cv),
        velocity_cv,
        estimated_token_cost: round2(total_hours * 50_000.0),
    })
}

pub fn cocomo_estimate(params: CocomoParams) -> Result<CocomoResult, ToolError> {
    let CocomoParams {
        kloc,
        reasoning_complexity,
        context_completeness,
        transformation_impact,
        iterative_cycles,
        human_oversight,
    } = params;

    if !kloc.is_finite() || kloc <= 0.0 {
        return Err(ToolError::new(
            "KLOC must be positive.",
            "Provide a positive value for kloc (thousands of lines of code).",
        ));
    }

    if kloc > 1e9 {
        return Err(ToolError::new(
            format!("KLOC value {kloc} is too large — computation would overflow."),
            "Provide a kloc value under 1,000,000,000.",
        ));
    }

    let multiplier_product = reasoning_complexity
        * context_completeness
        * transformation_impact
        * iterative_cycles
        * human_oversight;
    let person_months_nominal = 2.94 * kloc.powf(1.10) * multiplier_product;

    let llm_overhead = 1.0 + (iterative_cycles - 1.0) * 0.15;
    let ai_speedup_divisor = (12.0 / llm_overhead).max(3.0);
    let person_months_llm_adjusted = person_months_nominal / ai_speedup_divisor;

    if !all_finite(&[
        multiplier_product,
        person_months_nominal,
        person_months_llm_adjusted,
        ai_speedup_divisor,
    ]) {
        return Err(ToolError::new(
            "COCOMO computation produced invalid result.",
            "Ensure kloc and all rating multipliers are finite positive numbers.",
        ));
    }

    let ai_speedup = round1(person_months_nominal / person_months_llm_adjusted);
    let speedup_category = if ai_speedup < 5.0 {
        SpeedupCategory::Moderate
    } else if ai_speedup < 10.0 {
        SpeedupCategory::Significant
    } else {
        SpeedupCategory::Extreme
    };

    Ok(CocomoResult {
        kloc,
        person_months_nominal: round1(person_months_nominal),
        person_months_llm_adjusted: round1(person_months_llm_adjusted),
        effort_multipliers: EffortMultipliers {
            reasoning_complexity,
            context_completeness,
            transformation_impact,
            iterative_cycles,
            human_oversight,
            product: round3(multiplier_product),
        },
        assumptions: vec![
            "Based on COCOMO II Post-Architecture model (A=2.94, B=1.10).".to_string(),
            "LLM productivity factor derived from empirical agent benchmarks.".to_string(),
            "Cost drivers scaled for LLM-assisted workflows.".to_string(),
            "Adjust for your team's actual velocity.".to_string(),
        ],
        ai_speedup,
        speedup_category,
    })
}

fn all_finite(values: &[f64]) -> bool {
    values.iter().all(|value| value.is_finite())
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

fn compute_pert_risk_level(optimistic: f64, most_likely: f64, pessimistic: f64) -> RiskLevel {
    let spread = (pessimistic - optimistic) / most_likely;
    if spread < 1.0 {
        RiskLevel::Low
    } else if spread < 2.0 {
        RiskLevel::Medium
    } else {
        RiskLevel::High
    }
}

fn compute_sprint_confidence(sprint_count: usize, cv: f64) -> SprintConfidence {
    if sprint_count <= 2 {
        SprintConfidence::Low
    } else if sprint_count <= 5 {
        if cv < 0.3 {
            SprintConfidence::Medium
        } else {
            SprintConfidence::Low
        }
    } else if cv < 0.3 {
        SprintConfidence::High
    } else if cv < 0.5 {
        SprintConfidence::Medium
    } else {
        SprintConfidence::Low
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CocomoParams, SprintForecastParams, cocomo_estimate, pert_estimate, sprint_forecast,
    };
    use epoch_contract::{RiskLevel, SpeedupCategory, SprintConfidence, TimeUnit, UrgencyCategory};
    use serde_json::json;

    #[test]
    fn computes_pert_values_and_serializes_ts_shape() {
        let result =
            pert_estimate(2.0, 4.0, 12.0, TimeUnit::Hours).expect("PERT estimate succeeds");

        assert_eq!(result.expected, 5.0);
        assert_eq!(result.std_deviation, 1.67);
        assert_eq!(result.variance, 2.78);
        assert_eq!(result.confidence_95, [1.67, 8.33]);
        assert_eq!(result.confidence_99, [0.0, 10.0]);
        assert_eq!(result.urgency_category, UrgencyCategory::Medium);
        assert_eq!(result.risk_level, RiskLevel::High);
        assert!(result.human_readable.contains("Expected: 5 hours."));

        let serialized = serde_json::to_value(&result).expect("serializes");
        assert_eq!(serialized["mostLikely"], json!(4.0));
        assert_eq!(serialized["stdDeviation"], json!(1.67));
        assert_eq!(serialized["confidence95"], json!([1.67, 8.33]));
        assert_eq!(serialized["urgencyCategory"], json!("medium"));
        assert_eq!(serialized["riskLevel"], json!("high"));
    }

    #[test]
    fn rejects_invalid_pert_ordering() {
        let err =
            pert_estimate(10.0, 5.0, 15.0, TimeUnit::Hours).expect_err("invalid ordering fails");
        assert!(err.message.contains("optimistic=10"));
    }

    #[test]
    fn categorizes_pert_urgency_and_risk() {
        let short = pert_estimate(0.5, 1.0, 1.5, TimeUnit::Hours).expect("short succeeds");
        let medium = pert_estimate(4.0, 8.0, 16.0, TimeUnit::Hours).expect("medium succeeds");
        let long = pert_estimate(40.0, 80.0, 160.0, TimeUnit::Hours).expect("long succeeds");
        let low_risk = pert_estimate(3.0, 4.0, 5.0, TimeUnit::Hours).expect("low succeeds");

        assert_eq!(short.urgency_category, UrgencyCategory::Short);
        assert_eq!(medium.urgency_category, UrgencyCategory::Medium);
        assert_eq!(long.urgency_category, UrgencyCategory::Long);
        assert_eq!(low_risk.risk_level, RiskLevel::Low);
    }

    #[test]
    fn forecasts_sprints_from_velocity_history() {
        let result = sprint_forecast(SprintForecastParams {
            backlog_points: 100.0,
            velocity_history: vec![20.0, 25.0, 22.0, 23.0],
            sprint_length_days: 14.0,
            hours_per_sprint: 300.0,
        })
        .expect("forecast succeeds");

        assert_eq!(result.average_velocity, 22.5);
        assert_eq!(result.required_sprints, 4.4);
        assert_eq!(result.optimistic_sprints, 4.1);
        assert_eq!(result.pessimistic_sprints, 4.9);
        assert_eq!(result.hours_per_point, 13.33);
        assert_eq!(result.total_hours, 1333.3);
        assert_eq!(result.completion_days, 62);
        assert_eq!(result.confidence, SprintConfidence::Medium);
        assert_eq!(result.estimated_token_cost, 66_666_666.67);
    }

    #[test]
    fn handles_single_velocity_and_rejects_bad_velocity() {
        let result = sprint_forecast(SprintForecastParams {
            backlog_points: 30.0,
            velocity_history: vec![10.0],
            sprint_length_days: 14.0,
            hours_per_sprint: 100.0,
        })
        .expect("single velocity succeeds");

        assert_eq!(result.required_sprints, 3.0);
        assert_eq!(result.optimistic_sprints, 2.3);
        assert_eq!(result.pessimistic_sprints, 4.5);
        assert_eq!(result.velocity_cv, 0.0);
        assert_eq!(result.confidence, SprintConfidence::Low);

        let err = sprint_forecast(SprintForecastParams {
            backlog_points: 30.0,
            velocity_history: vec![10.0, -5.0],
            sprint_length_days: 14.0,
            hours_per_sprint: 100.0,
        })
        .expect_err("negative velocity fails");
        assert!(err.message.contains("velocity_history[1]"));
    }

    #[test]
    fn computes_cocomo_llm_adjusted_effort() {
        let result = cocomo_estimate(CocomoParams {
            kloc: 10.0,
            reasoning_complexity: 1.0,
            context_completeness: 1.0,
            transformation_impact: 1.0,
            iterative_cycles: 1.0,
            human_oversight: 1.0,
        })
        .expect("COCOMO succeeds");

        assert_eq!(result.kloc, 10.0);
        assert_eq!(result.person_months_nominal, 37.0);
        assert_eq!(result.person_months_llm_adjusted, 3.1);
        assert_eq!(result.effort_multipliers.product, 1.0);
        assert_eq!(result.ai_speedup, 12.0);
        assert_eq!(result.speedup_category, SpeedupCategory::Extreme);
        assert_eq!(result.assumptions.len(), 4);

        let serialized = serde_json::to_value(&result).expect("serializes");
        assert_eq!(serialized["personMonthsNominal"], json!(37.0));
        assert_eq!(serialized["personMonthsLlmAdjusted"], json!(3.1));
        assert_eq!(
            serialized["effortMultipliers"]["reasoning_complexity"],
            json!(1.0)
        );
        assert_eq!(serialized["aiSpeedup"], json!(12.0));
    }

    #[test]
    fn rejects_impossible_cocomo_values_and_classifies_speedup() {
        let err = cocomo_estimate(CocomoParams {
            kloc: 0.0,
            reasoning_complexity: 1.0,
            context_completeness: 1.0,
            transformation_impact: 1.0,
            iterative_cycles: 1.0,
            human_oversight: 1.0,
        })
        .expect_err("zero kloc fails");
        assert_eq!(err.message, "KLOC must be positive.");

        let result = cocomo_estimate(CocomoParams {
            kloc: 10.0,
            reasoning_complexity: 1.0,
            context_completeness: 1.0,
            transformation_impact: 1.0,
            iterative_cycles: 10.0,
            human_oversight: 1.0,
        })
        .expect("high cycles succeeds");
        assert_eq!(result.speedup_category, SpeedupCategory::Significant);
        assert!(result.ai_speedup >= 5.0 && result.ai_speedup < 10.0);
    }
}
