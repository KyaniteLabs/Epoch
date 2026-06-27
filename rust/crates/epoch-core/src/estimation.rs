use epoch_contract::{
    CocomoResult, CpmResult, CpmTask, EffortMultipliers, MonteCarloResult, MonteCarloTask,
    PertResult, RiskEvent, RiskLevel, SpeedupCategory, SprintConfidence, SprintForecastResult,
    TimeUnit, ToolError, UrgencyCategory,
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

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
    if !(all_finite(&[optimistic, most_likely, pessimistic])
        && optimistic > 0.0
        && optimistic <= most_likely
        && most_likely <= pessimistic)
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

    // Match the TypeScript guard, which only checks `expected` and `stdDev`.
    // With an extreme pessimistic value the variance (std_dev^2) can overflow
    // to a non-finite value while expected/std_dev stay finite; TS accepts that
    // case and serializes the non-finite variance as JSON null, so Rust must
    // too rather than rejecting an input the TS server handles.
    if !all_finite(&[expected, std_dev]) {
        return Err(ToolError::new(
            "Computation produced invalid result.",
            "Ensure all inputs are finite numbers and optimistic < mostLikely < pessimistic.",
        ));
    }

    let rounded_expected = round2(expected);
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
        expected: rounded_expected,
        variance,
        std_deviation,
        confidence_95,
        confidence_99,
        unit,
        urgency_category,
        risk_level: compute_pert_risk_level(optimistic, most_likely, pessimistic),
        human_readable: format!(
            "Expected: {} {}. 95% confidence: {} to {} {}. 99% confidence: {} to {} {}.",
            format_number(rounded_expected),
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

pub fn critical_path(tasks: Vec<CpmTask>) -> Result<CpmResult, ToolError> {
    if tasks.is_empty() {
        return Err(ToolError::new(
            "Task list must not be empty.",
            "Provide at least one task for critical path analysis.",
        ));
    }

    let mut seen = BTreeSet::new();
    let mut task_map = BTreeMap::new();
    for task in &tasks {
        if !seen.insert(task.name.clone()) {
            return Err(ToolError::new(
                format!("Duplicate task name: \"{}\".", task.name),
                "Each task must have a unique name.",
            ));
        }

        if !task.duration.is_finite() || task.duration <= 0.0 {
            return Err(ToolError::new(
                format!(
                    "Task \"{}\" has invalid duration: {}.",
                    task.name, task.duration
                ),
                "Each task must have a positive, finite duration.",
            ));
        }

        task_map.insert(task.name.clone(), task.clone());
    }

    for task in &tasks {
        if task.predecessors.iter().any(|name| name == &task.name) {
            return Err(ToolError::new(
                format!("Task \"{}\" references itself as a predecessor.", task.name),
                "Remove self-references from predecessor lists.",
            ));
        }

        for predecessor in &task.predecessors {
            if !task_map.contains_key(predecessor) {
                return Err(ToolError::new(
                    format!(
                        "Unknown predecessor \"{predecessor}\" in task \"{}\".",
                        task.name
                    ),
                    "Ensure all predecessor names match task names exactly.",
                ));
            }
        }
    }

    let sorted = topological_sort(&tasks);
    if sorted.len() != tasks.len() {
        return Err(ToolError::new(
            "Circular dependency detected in task graph.",
            "Remove cycles from task predecessor chains.",
        ));
    }

    let mut earliest_start = BTreeMap::new();
    let mut earliest_finish = BTreeMap::new();

    for name in &sorted {
        let Some(task) = task_map.get(name) else {
            continue;
        };
        let adjusted_duration = task.duration * merge_bias(task);
        let start = if task.predecessors.is_empty() {
            0.0
        } else {
            task.predecessors
                .iter()
                .filter_map(|predecessor| earliest_finish.get(predecessor).copied())
                .fold(0.0, f64::max)
        };
        earliest_start.insert(name.clone(), start);
        earliest_finish.insert(name.clone(), start + adjusted_duration);
    }

    let total_duration = earliest_finish.values().copied().fold(0.0, f64::max);

    let mut latest_start = BTreeMap::new();
    let mut latest_finish = BTreeMap::new();

    for name in sorted.iter().rev() {
        let Some(task) = task_map.get(name) else {
            continue;
        };
        let adjusted_duration = task.duration * merge_bias(task);
        let successors: Vec<&CpmTask> = tasks
            .iter()
            .filter(|candidate| {
                candidate
                    .predecessors
                    .iter()
                    .any(|predecessor| predecessor == name)
            })
            .collect();
        let finish = if successors.is_empty() {
            total_duration
        } else {
            successors
                .iter()
                .filter_map(|successor| latest_start.get(&successor.name).copied())
                .fold(f64::INFINITY, f64::min)
        };
        latest_finish.insert(name.clone(), finish);
        latest_start.insert(name.clone(), finish - adjusted_duration);
    }

    let mut slack_per_task = BTreeMap::new();
    let mut critical_path = Vec::new();
    let mut total_merge_bias = 0.0;

    for name in &sorted {
        let Some(task) = task_map.get(name) else {
            continue;
        };
        let slack = round2(
            latest_start.get(name).copied().unwrap_or(0.0)
                - earliest_start.get(name).copied().unwrap_or(0.0),
        );
        slack_per_task.insert(name.clone(), slack);
        if slack <= 0.01 {
            critical_path.push(name.clone());
        }
        if task.predecessors.len() > 2 {
            total_merge_bias += 0.05 * (task.predecessors.len() as f64 - 2.0);
        }
    }

    Ok(CpmResult {
        critical_path,
        slack_per_task,
        total_duration: round2(total_duration),
        merge_bias_adjustment: round2(total_merge_bias),
        estimated_hours: round2(total_duration * 8.0),
        estimated_token_cost: round2(total_duration * 8.0 * 50_000.0),
    })
}

pub fn monte_carlo_sim(
    tasks: Vec<MonteCarloTask>,
    iterations: usize,
    seed: Option<i64>,
) -> MonteCarloResult {
    if tasks.is_empty() {
        return monte_carlo_error(
            "Task list must not be empty.",
            "Error: Provide at least one task for Monte Carlo simulation.",
        );
    }

    if iterations == 0 {
        return monte_carlo_error(
            "Iterations must be >= 1.",
            "Error: Iterations must be a positive number.",
        );
    }

    for task in &tasks {
        if !(all_finite(&[task.optimistic, task.most_likely, task.pessimistic])
            && task.optimistic <= task.most_likely
            && task.most_likely <= task.pessimistic)
        {
            return MonteCarloResult {
                p10: "0".to_string(),
                p50: "0".to_string(),
                p80: "0".to_string(),
                p95: "0".to_string(),
                estimated_hours: 0.0,
                estimated_cost: 0.0,
                converged: false,
                critical_path_probability: 0.0,
                risk_events: vec![RiskEvent {
                    description: format!(
                        "Invalid estimates for task \"{}\": optimistic ({}) must be <= mostLikely ({}) <= pessimistic ({}).",
                        task.name, task.optimistic, task.most_likely, task.pessimistic
                    ),
                    probability: 1.0,
                    impact_days: 0,
                }],
                human_readable: format!(
                    "Error: Task \"{}\" has invalid PERT estimates.",
                    task.name
                ),
            };
        }
    }

    let mut rng = SeededRandom::new(seed.unwrap_or(42));
    let mut durations = Vec::with_capacity(iterations);
    let mut task_overruns: BTreeMap<String, usize> = BTreeMap::new();
    let mut quarter_runs = Vec::new();
    let mut three_quarter_runs = Vec::new();
    let checkpoint_1 = ((iterations as f64) * 0.25).floor() as usize;
    let checkpoint_2 = ((iterations as f64) * 0.75).floor() as usize;

    for index in 0..iterations {
        let mut total = 0.0;
        for task in &tasks {
            let sampled = triangular_sample(
                task.optimistic,
                task.most_likely,
                task.pessimistic,
                &mut rng,
            );
            total += sampled;
            let expected = (task.optimistic + 4.0 * task.most_likely + task.pessimistic) / 6.0;
            if sampled > expected * 1.5 {
                *task_overruns.entry(task.name.clone()).or_default() += 1;
            }
        }
        durations.push(total);
        if index == checkpoint_1 {
            quarter_runs.extend_from_slice(&durations);
        }
        if index == checkpoint_2 {
            three_quarter_runs.extend_from_slice(&durations);
        }
    }

    durations.sort_by(|left, right| left.total_cmp(right));

    let p10 = percentile(&durations, iterations, 0.1);
    let p50 = percentile(&durations, iterations, 0.5);
    let p80 = percentile(&durations, iterations, 0.8);
    let p95 = percentile(&durations, iterations, 0.95);

    let mut overrun_entries: Vec<(String, usize)> = task_overruns.into_iter().collect();
    overrun_entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let risk_events = overrun_entries
        .into_iter()
        .take(5)
        .map(|(task, count)| RiskEvent {
            description: format!(
                "Task \"{task}\" exceeded 1.5x PERT expected in {}% of simulations",
                (count as f64 / iterations as f64 * 100.0).round() as i64
            ),
            probability: round2(count as f64 / iterations as f64),
            impact_days: (p95 - p50).round() as i64,
        })
        .collect::<Vec<_>>();

    quarter_runs.sort_by(|left, right| left.total_cmp(right));
    three_quarter_runs.sort_by(|left, right| left.total_cmp(right));
    let early_p50 = if quarter_runs.is_empty() {
        p50
    } else {
        quarter_runs[(quarter_runs.len() as f64 * 0.5).floor() as usize]
    };
    let late_p50 = if three_quarter_runs.is_empty() {
        p50
    } else {
        three_quarter_runs[(three_quarter_runs.len() as f64 * 0.5).floor() as usize]
    };
    let converged = if p50 > 0.0 {
        (early_p50 - late_p50).abs() / p50 < 0.10
    } else {
        true
    };

    let critical_path_probability = round2(
        durations
            .iter()
            .filter(|duration| **duration <= p80)
            .count() as f64
            / iterations as f64,
    );
    let estimated_hours = round2(p50 * 8.0);
    let estimated_cost = round2(p50 * 8.0 * 50_000.0);
    let p10_string = format_number(round2(p10));
    let p50_string = format_number(round2(p50));
    let p80_string = format_number(round2(p80));
    let p95_string = format_number(round2(p95));

    MonteCarloResult {
        p10: p10_string.clone(),
        p50: p50_string.clone(),
        p80: p80_string,
        p95: p95_string.clone(),
        estimated_hours,
        estimated_cost,
        critical_path_probability,
        converged,
        risk_events,
        human_readable: format!(
            "Monte Carlo simulation ({iterations} iterations): Optimistic (p10): {p10_string} days. Median (p50): {p50_string} days. Conservative (p95): {p95_string} days. Probability of meeting p80 target: {}%.",
            (critical_path_probability * 100.0).round() as i64
        ),
    }
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

fn merge_bias(task: &CpmTask) -> f64 {
    if task.predecessors.len() > 2 {
        1.0 + 0.05 * (task.predecessors.len() as f64 - 2.0)
    } else {
        1.0
    }
}

fn topological_sort(tasks: &[CpmTask]) -> Vec<String> {
    let mut in_degree = BTreeMap::new();
    let mut adjacency = BTreeMap::<String, Vec<String>>::new();

    for task in tasks {
        in_degree.insert(task.name.clone(), task.predecessors.len());
        adjacency.insert(task.name.clone(), Vec::new());
    }

    for task in tasks {
        for predecessor in &task.predecessors {
            if let Some(list) = adjacency.get_mut(predecessor) {
                list.push(task.name.clone());
            }
        }
    }

    let mut queue = VecDeque::new();
    for task in tasks {
        if in_degree.get(&task.name).copied().unwrap_or(0) == 0 {
            queue.push_back(task.name.clone());
        }
    }

    let mut result = Vec::new();
    while let Some(current) = queue.pop_front() {
        result.push(current.clone());
        for next in adjacency.get(&current).into_iter().flatten() {
            if let Some(previous) = in_degree.get(next).copied() {
                let new_degree = previous.saturating_sub(1);
                in_degree.insert(next.clone(), new_degree);
                if new_degree == 0 {
                    queue.push_back(next.clone());
                }
            }
        }
    }

    result
}

fn monte_carlo_error(description: &str, human_readable: &str) -> MonteCarloResult {
    MonteCarloResult {
        p10: "0".to_string(),
        p50: "0".to_string(),
        p80: "0".to_string(),
        p95: "0".to_string(),
        estimated_hours: 0.0,
        estimated_cost: 0.0,
        converged: false,
        critical_path_probability: 0.0,
        risk_events: vec![RiskEvent {
            description: description.to_string(),
            probability: 1.0,
            impact_days: 0,
        }],
        human_readable: human_readable.to_string(),
    }
}

fn percentile(durations: &[f64], iterations: usize, percentile: f64) -> f64 {
    let index = (((iterations as f64) * percentile).floor() as usize).min(durations.len() - 1);
    durations[index]
}

struct SeededRandom {
    state: i64,
}

impl SeededRandom {
    fn new(seed: i64) -> Self {
        let mut state = seed % 2_147_483_647;
        if state <= 0 {
            state += 2_147_483_646;
        }
        Self { state }
    }

    fn next(&mut self) -> f64 {
        self.state = (self.state * 16_807) % 2_147_483_647;
        (self.state - 1) as f64 / 2_147_483_646.0
    }
}

fn triangular_sample(min: f64, mode: f64, max: f64, rng: &mut SeededRandom) -> f64 {
    if max == min {
        return min;
    }

    let sample = rng.next();
    let mode_fraction = (mode - min) / (max - min);
    if sample < mode_fraction {
        min + (sample * (max - min) * (mode - min)).sqrt()
    } else {
        max - ((1.0 - sample) * (max - min) * (max - mode)).sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CocomoParams, SprintForecastParams, cocomo_estimate, critical_path, monte_carlo_sim,
        pert_estimate, sprint_forecast,
    };
    use epoch_contract::{
        CpmTask, MonteCarloTask, RiskLevel, SpeedupCategory, SprintConfidence, TimeUnit,
        UrgencyCategory,
    };
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
    fn pert_confidence_bounds_use_unrounded_expected_value() {
        let result =
            pert_estimate(2.0, 5.0, 10.0, TimeUnit::Hours).expect("PERT estimate succeeds");

        assert_eq!(result.expected, 5.33);
        assert_eq!(result.std_deviation, 1.33);
        assert_eq!(result.confidence_95, [2.67, 8.0]);
        assert_eq!(result.confidence_99, [1.33, 9.33]);
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

    #[test]
    fn computes_critical_path_for_linear_and_parallel_graphs() {
        let linear = critical_path(vec![
            cpm_task("A", 3.0, &[]),
            cpm_task("B", 5.0, &["A"]),
            cpm_task("C", 2.0, &["B"]),
        ])
        .expect("linear graph succeeds");
        assert_eq!(linear.total_duration, 10.0);
        assert_eq!(linear.critical_path, vec!["A", "B", "C"]);

        let parallel = critical_path(vec![
            cpm_task("A", 3.0, &[]),
            cpm_task("B", 5.0, &["A"]),
            cpm_task("C", 2.0, &["A"]),
            cpm_task("D", 1.0, &["B", "C"]),
        ])
        .expect("parallel graph succeeds");
        assert_eq!(parallel.total_duration, 9.0);
        assert!(parallel.critical_path.contains(&"A".to_string()));
        assert!(parallel.critical_path.contains(&"B".to_string()));
        assert!(parallel.slack_per_task["C"] > 0.0);
        assert_eq!(parallel.estimated_hours, 72.0);
        assert_eq!(parallel.estimated_token_cost, 3_600_000.0);

        let serialized = serde_json::to_value(&parallel).expect("serializes");
        assert_eq!(serialized["critical_path"], json!(["A", "B", "D"]));
        assert_eq!(serialized["estimatedHours"], json!(72.0));
        assert_eq!(serialized["estimatedTokenCost"], json!(3_600_000.0));
    }

    #[test]
    fn rejects_invalid_critical_path_graphs_and_applies_merge_bias() {
        assert!(critical_path(Vec::new()).is_err());
        assert!(
            critical_path(vec![cpm_task("A", 3.0, &["UNKNOWN"])])
                .expect_err("unknown predecessor fails")
                .message
                .contains("Unknown predecessor")
        );
        assert!(
            critical_path(vec![cpm_task("A", 3.0, &[]), cpm_task("A", 5.0, &[])])
                .expect_err("duplicate task fails")
                .message
                .contains("Duplicate")
        );
        assert!(
            critical_path(vec![cpm_task("A", 3.0, &["B"]), cpm_task("B", 5.0, &["A"])])
                .expect_err("cycle fails")
                .message
                .contains("Circular")
        );
        assert!(
            critical_path(vec![cpm_task("A", 3.0, &["A"])])
                .expect_err("self reference fails")
                .message
                .contains("itself")
        );
        assert!(
            critical_path(vec![cpm_task("A", 0.0, &[])])
                .expect_err("zero duration fails")
                .message
                .contains("invalid duration")
        );

        let biased = critical_path(vec![
            cpm_task("A", 2.0, &[]),
            cpm_task("B", 2.0, &[]),
            cpm_task("C", 2.0, &[]),
            cpm_task("D", 3.0, &["A", "B", "C"]),
        ])
        .expect("biased graph succeeds");
        assert_eq!(biased.merge_bias_adjustment, 0.05);
        assert_eq!(biased.total_duration, 5.15);
    }

    #[test]
    fn monte_carlo_is_seeded_and_serializes_ts_shape() {
        let tasks = vec![
            monte_task("A", 2.0, 4.0, 8.0),
            monte_task("B", 1.0, 3.0, 7.0),
        ];
        let run1 = monte_carlo_sim(tasks.clone(), 1000, Some(42));
        let run2 = monte_carlo_sim(tasks, 1000, Some(42));

        assert_eq!(run1.p50, run2.p50);
        assert_eq!(run1.p95, run2.p95);
        assert!(run1.estimated_hours > 0.0);
        assert!(run1.estimated_cost > 0.0);
        assert!(run1.critical_path_probability >= 0.0);
        assert!(run1.critical_path_probability <= 1.0);

        let serialized = serde_json::to_value(&run1).expect("serializes");
        assert!(serialized["estimatedHours"].as_f64().unwrap() > 0.0);
        assert!(serialized["estimatedCost"].as_f64().unwrap() > 0.0);
        assert!(serialized["criticalPathProbability"].as_f64().unwrap() >= 0.0);
        assert!(serialized["riskEvents"].is_array());
    }

    #[test]
    fn monte_carlo_orders_percentiles_and_reports_risks() {
        let result = monte_carlo_sim(
            vec![
                monte_task("A", 2.0, 5.0, 12.0),
                monte_task("B", 3.0, 6.0, 15.0),
            ],
            5000,
            Some(99),
        );

        let p10 = result.p10.parse::<f64>().expect("p10 number");
        let p50 = result.p50.parse::<f64>().expect("p50 number");
        let p80 = result.p80.parse::<f64>().expect("p80 number");
        let p95 = result.p95.parse::<f64>().expect("p95 number");
        assert!(p10 <= p50);
        assert!(p50 <= p80);
        assert!(p80 <= p95);
        assert!((result.estimated_hours - p50 * 8.0).abs() < 1.0);
        assert!((result.estimated_cost - result.estimated_hours * 50_000.0).abs() < 1000.0);

        let risky = monte_carlo_sim(vec![monte_task("Risky", 1.0, 2.0, 20.0)], 5000, Some(42));
        assert!(!risky.risk_events.is_empty());
        assert!(risky.risk_events[0].description.contains("Risky"));
    }

    #[test]
    fn monte_carlo_returns_error_results_for_bad_inputs() {
        let empty = monte_carlo_sim(Vec::new(), 1000, Some(42));
        assert_eq!(empty.p50, "0");
        assert!(empty.human_readable.contains("at least one task"));

        let zero_iterations = monte_carlo_sim(vec![monte_task("Task", 1.0, 3.0, 8.0)], 0, Some(42));
        assert_eq!(zero_iterations.p50, "0");
        assert!(
            zero_iterations.risk_events[0]
                .description
                .contains("Iterations")
        );

        let bad = monte_carlo_sim(vec![monte_task("Bad", 10.0, 5.0, 20.0)], 1000, Some(42));
        assert_eq!(bad.p50, "0");
        assert!(bad.risk_events[0].description.contains("Invalid estimates"));

        let single = monte_carlo_sim(vec![monte_task("Solo", 2.0, 5.0, 10.0)], 1, Some(42));
        assert_eq!(single.p10, single.p50);
        assert_eq!(single.p50, single.p95);
    }

    #[test]
    fn monte_carlo_reports_convergence_for_high_iteration_count() {
        let result = monte_carlo_sim(vec![monte_task("Task", 2.0, 5.0, 10.0)], 50_000, Some(42));
        assert!(result.converged);
    }

    fn cpm_task(name: &str, duration: f64, predecessors: &[&str]) -> CpmTask {
        CpmTask {
            name: name.to_string(),
            duration,
            predecessors: predecessors.iter().map(|value| value.to_string()).collect(),
        }
    }

    fn monte_task(
        name: &str,
        optimistic: f64,
        most_likely: f64,
        pessimistic: f64,
    ) -> MonteCarloTask {
        MonteCarloTask {
            name: name.to_string(),
            optimistic,
            most_likely,
            pessimistic,
        }
    }
}
