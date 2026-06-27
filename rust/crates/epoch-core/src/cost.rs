use epoch_contract::{
    ConfidenceLevel, ModelComparison, ModelComparisonEntry, QualityTier, ReasoningDepth,
    TokenCostBreakdown, TokenCostEstimate, TokenTimeBreakdown, TokenTimeMapping, UrgencyCategory,
};

const FALLBACK_COST_INPUT: f64 = 3.0;
const FALLBACK_COST_OUTPUT: f64 = 15.0;
const AVG_TOOL_CALL_TOKENS: f64 = 200.0;
const PROMPT_RATIO: f64 = 0.3;

#[derive(Debug, Clone)]
pub struct TokenCostParams {
    pub tokens: f64,
    pub model: String,
    pub tool_calls: u32,
    pub reasoning_depth: ReasoningDepth,
}

#[derive(Debug, Clone)]
pub struct CompareModelsParams {
    pub tokens: f64,
    pub tool_calls: u32,
    pub reasoning_depth: ReasoningDepth,
    pub sort_by: ModelSort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSort {
    Cost,
    Time,
}

impl ModelSort {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cost => "cost",
            Self::Time => "time",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ModelProfile {
    model: &'static str,
    tokens_per_second: f64,
    reasoning_overhead_ms: f64,
    tool_call_latency_ms: f64,
    cost_input: f64,
    cost_output: f64,
}

const MODEL_PROFILES: &[ModelProfile] = &[
    ModelProfile {
        model: "claude-3.5-haiku-20241022",
        tokens_per_second: 100.0,
        reasoning_overhead_ms: 145.0,
        tool_call_latency_ms: 200.0,
        cost_input: 0.8,
        cost_output: 4.0,
    },
    ModelProfile {
        model: "claude-opus-4-20250514",
        tokens_per_second: 55.0,
        reasoning_overhead_ms: 360.0,
        tool_call_latency_ms: 200.0,
        cost_input: 15.0,
        cost_output: 75.0,
    },
    ModelProfile {
        model: "claude-sonnet-4-20250514",
        tokens_per_second: 72.0,
        reasoning_overhead_ms: 205.0,
        tool_call_latency_ms: 200.0,
        cost_input: 3.0,
        cost_output: 15.0,
    },
    ModelProfile {
        model: "deepseek-v3",
        tokens_per_second: 97.0,
        reasoning_overhead_ms: 410.0,
        tool_call_latency_ms: 200.0,
        cost_input: 0.28,
        cost_output: 0.42,
    },
    ModelProfile {
        model: "gemini-2.0-flash",
        tokens_per_second: 230.0,
        reasoning_overhead_ms: 90.0,
        tool_call_latency_ms: 200.0,
        cost_input: 0.1,
        cost_output: 0.4,
    },
    ModelProfile {
        model: "gemini-2.5-pro",
        tokens_per_second: 68.0,
        reasoning_overhead_ms: 280.0,
        tool_call_latency_ms: 200.0,
        cost_input: 1.25,
        cost_output: 10.0,
    },
    ModelProfile {
        model: "gpt-4-turbo",
        tokens_per_second: 27.5,
        reasoning_overhead_ms: 1405.0,
        tool_call_latency_ms: 200.0,
        cost_input: 10.0,
        cost_output: 30.0,
    },
    ModelProfile {
        model: "gpt-4o",
        tokens_per_second: 85.0,
        reasoning_overhead_ms: 155.0,
        tool_call_latency_ms: 200.0,
        cost_input: 2.5,
        cost_output: 10.0,
    },
    ModelProfile {
        model: "gpt-4o-mini",
        tokens_per_second: 180.0,
        reasoning_overhead_ms: 130.0,
        tool_call_latency_ms: 200.0,
        cost_input: 0.15,
        cost_output: 0.6,
    },
    ModelProfile {
        model: "llama-3.1-405b",
        tokens_per_second: 30.0,
        reasoning_overhead_ms: 300.0,
        tool_call_latency_ms: 200.0,
        cost_input: 3.0,
        cost_output: 3.0,
    },
    ModelProfile {
        model: "llama-3.1-70b",
        tokens_per_second: 100.0,
        reasoning_overhead_ms: 100.0,
        tool_call_latency_ms: 200.0,
        cost_input: 0.88,
        cost_output: 0.88,
    },
    ModelProfile {
        model: "mistral-large",
        tokens_per_second: 42.6,
        reasoning_overhead_ms: 730.0,
        tool_call_latency_ms: 200.0,
        cost_input: 2.0,
        cost_output: 6.0,
    },
];

pub fn token_time_bridge(params: &TokenCostParams) -> TokenTimeMapping {
    let profile = find_model_profile(&params.model);
    let generation_time_seconds = params.tokens / profile.tokens_per_second;
    let tool_overhead_seconds = (params.tool_calls as f64 * profile.tool_call_latency_ms) / 1000.0;
    let reasoning_seconds =
        (profile.reasoning_overhead_ms / 1000.0) * params.reasoning_depth.multiplier();
    let total_seconds = generation_time_seconds + tool_overhead_seconds + reasoning_seconds;
    let estimated_minutes = round1(total_seconds / 60.0);
    let confidence = if is_known_model(&params.model) {
        ConfidenceLevel::Likely
    } else {
        ConfidenceLevel::Optimistic
    };
    let time_label = if estimated_minutes >= 60.0 {
        format!("{} hours", format_number(round1(estimated_minutes / 60.0)))
    } else {
        format!("{} minutes", format_number(estimated_minutes))
    };

    TokenTimeMapping {
        tokens: params.tokens,
        model: params.model.clone(),
        estimated_seconds: total_seconds.round(),
        estimated_minutes,
        confidence,
        urgency: UrgencyCategory::from_hours(total_seconds / 3600.0),
        breakdown: TokenTimeBreakdown {
            prompt_tokens: (params.tokens * PROMPT_RATIO).round(),
            completion_tokens: (params.tokens * (1.0 - PROMPT_RATIO)).round(),
            tool_overhead_seconds: round2(tool_overhead_seconds),
        },
        human_readable: format!(
            "Approximately {time_label} for {} tokens with {} ({} reasoning, {} tool calls). Confidence: {}.",
            format_locale_number(params.tokens),
            params.model,
            params.reasoning_depth.as_str(),
            params.tool_calls,
            confidence.as_str(),
        ),
        estimated_token_cost: round2((total_seconds / 3600.0) * 50_000.0),
    }
}

pub fn token_cost_estimate(params: TokenCostParams) -> TokenCostEstimate {
    let time_mapping = token_time_bridge(&params);
    let profile = find_model_profile(&params.model);
    let (cost_input, cost_output) = if is_known_model(&params.model) {
        (profile.cost_input, profile.cost_output)
    } else {
        (FALLBACK_COST_INPUT, FALLBACK_COST_OUTPUT)
    };
    let prompt_tokens = time_mapping.breakdown.prompt_tokens;
    let completion_tokens = time_mapping.breakdown.completion_tokens;

    if !prompt_tokens.is_finite() || !completion_tokens.is_finite() {
        return TokenCostEstimate {
            tokens: params.tokens,
            model: params.model.clone(),
            estimated_seconds: 0.0,
            estimated_minutes: 0.0,
            estimated_cost: 0.0,
            cost_breakdown: TokenCostBreakdown {
                input_cost: 0.0,
                output_cost: 0.0,
                tool_call_overhead_cost: 0.0,
            },
            time_breakdown: time_mapping.breakdown,
            confidence: time_mapping.confidence,
            urgency: time_mapping.urgency,
            human_readable: format!(
                "Cost estimate unavailable for {} — calibration data issue.",
                params.model
            ),
        };
    }

    let input_cost = round4((prompt_tokens * cost_input) / 1_000_000.0);
    let output_cost = round4((completion_tokens * cost_output) / 1_000_000.0);
    let tool_call_overhead_cost =
        round4((params.tool_calls as f64 * AVG_TOOL_CALL_TOKENS * cost_output) / 1_000_000.0);
    let estimated_cost = round4(input_cost + output_cost + tool_call_overhead_cost);

    TokenCostEstimate {
        tokens: params.tokens,
        model: params.model.clone(),
        estimated_seconds: time_mapping.estimated_seconds,
        estimated_minutes: time_mapping.estimated_minutes,
        estimated_cost,
        cost_breakdown: TokenCostBreakdown {
            input_cost,
            output_cost,
            tool_call_overhead_cost,
        },
        time_breakdown: time_mapping.breakdown,
        confidence: time_mapping.confidence,
        urgency: time_mapping.urgency,
        human_readable: format!(
            "~{} min, ~${} for {} tokens with {} ({} reasoning, {} tool calls)",
            format_number(round1(time_mapping.estimated_minutes)),
            format_number(estimated_cost),
            format_integerish(params.tokens),
            params.model,
            params.reasoning_depth.as_str(),
            params.tool_calls,
        ),
    }
}

pub fn compare_models(params: CompareModelsParams) -> ModelComparison {
    let mut models = MODEL_PROFILES
        .iter()
        .map(|profile| {
            let time_mapping = token_time_bridge(&TokenCostParams {
                tokens: params.tokens,
                model: profile.model.to_string(),
                tool_calls: params.tool_calls,
                reasoning_depth: params.reasoning_depth,
            });
            // TS `compareModels` sums the RAW per-component costs and rounds the
            // total once — unlike `token_cost_estimate`, which rounds each
            // component first. Reusing the latter double-rounds and diverges by
            // a cent fraction, so compute the cost the same way TS does here.
            let prompt_tokens = time_mapping.breakdown.prompt_tokens;
            let completion_tokens = time_mapping.breakdown.completion_tokens;
            let input_cost = prompt_tokens * profile.cost_input / 1_000_000.0;
            let output_cost = completion_tokens * profile.cost_output / 1_000_000.0;
            let tool_call_overhead_cost =
                params.tool_calls as f64 * AVG_TOOL_CALL_TOKENS * profile.cost_output / 1_000_000.0;
            let estimated_cost = round4(input_cost + output_cost + tool_call_overhead_cost);
            ModelComparisonEntry {
                model: profile.model.to_string(),
                estimated_seconds: time_mapping.estimated_seconds,
                estimated_minutes: time_mapping.estimated_minutes,
                estimated_cost,
                cost_available: true,
                quality_tier: quality_tier(profile.model),
                tokens_per_second: profile.tokens_per_second,
            }
        })
        .collect::<Vec<_>>();

    match params.sort_by {
        ModelSort::Time => {
            models.sort_by(|left, right| left.estimated_seconds.total_cmp(&right.estimated_seconds))
        }
        ModelSort::Cost => models.sort_by(|left, right| {
            match (left.estimated_cost == 0.0, right.estimated_cost == 0.0) {
                (true, false) => std::cmp::Ordering::Greater,
                (false, true) => std::cmp::Ordering::Less,
                _ => left.estimated_cost.total_cmp(&right.estimated_cost),
            }
        }),
    }

    let mut rows = vec![
        "Model                          | Time (min) | Cost ($)  | Tier".to_string(),
        "-------------------------------|------------|-----------|--------".to_string(),
    ];
    rows.extend(models.iter().map(|entry| {
        format!(
            "{:<30}| {:>10} | {:>9.4} | {}",
            entry.model,
            format_number(entry.estimated_minutes),
            entry.estimated_cost,
            entry.quality_tier.as_str(),
        )
    }));

    ModelComparison {
        tokens: params.tokens,
        models,
        sort_by: params.sort_by.as_str().to_string(),
        human_readable: rows.join("\n"),
    }
}

fn find_model_profile(model: &str) -> ModelProfile {
    MODEL_PROFILES
        .iter()
        .copied()
        .find(|profile| profile.model == model)
        .unwrap_or(ModelProfile {
            model: "_fallback",
            tokens_per_second: 75.0,
            reasoning_overhead_ms: 2500.0,
            tool_call_latency_ms: 500.0,
            cost_input: FALLBACK_COST_INPUT,
            cost_output: FALLBACK_COST_OUTPUT,
        })
}

fn is_known_model(model: &str) -> bool {
    MODEL_PROFILES.iter().any(|profile| profile.model == model)
}

fn quality_tier(model: &str) -> QualityTier {
    match model {
        "claude-3.5-haiku-20241022" | "gpt-4o-mini" | "gemini-2.0-flash" | "llama-3.1-70b" => {
            QualityTier::Fast
        }
        "claude-opus-4-20250514" | "gpt-4-turbo" => QualityTier::Premium,
        _ => QualityTier::Standard,
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        return format!("{value:.0}");
    }

    let mut out = format!("{value:.4}");
    while out.contains('.') && out.ends_with('0') {
        out.pop();
    }
    if out.ends_with('.') {
        out.pop();
    }
    out
}

fn format_integerish(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        format_number(value)
    }
}

fn format_locale_number(value: f64) -> String {
    let rounded = (value * 1000.0).round() / 1000.0;
    let raw = if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        let mut out = format!("{rounded:.3}");
        while out.contains('.') && out.ends_with('0') {
            out.pop();
        }
        if out.ends_with('.') {
            out.pop();
        }
        out
    };

    let (sign, unsigned) = raw
        .strip_prefix('-')
        .map_or(("", raw.as_str()), |value| ("-", value));
    let (whole, fraction) = unsigned
        .split_once('.')
        .map_or((unsigned, None), |(whole, fraction)| {
            (whole, Some(fraction))
        });
    let mut grouped_reversed = String::new();
    for (index, ch) in whole.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped_reversed.push(',');
        }
        grouped_reversed.push(ch);
    }
    let grouped = grouped_reversed.chars().rev().collect::<String>();

    match fraction {
        Some(fraction) if !fraction.is_empty() => format!("{sign}{grouped}.{fraction}"),
        _ => format!("{sign}{grouped}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CompareModelsParams, ModelSort, TokenCostParams, compare_models, token_cost_estimate,
        token_time_bridge,
    };
    use epoch_contract::{ConfidenceLevel, QualityTier, ReasoningDepth, UrgencyCategory};
    use serde_json::json;

    #[test]
    fn estimates_time_and_cost_for_known_model() {
        let result = token_cost_estimate(TokenCostParams {
            tokens: 10_000.0,
            model: "claude-sonnet-4-20250514".to_string(),
            tool_calls: 2,
            reasoning_depth: ReasoningDepth::Moderate,
        });

        assert_eq!(result.tokens, 10_000.0);
        assert_eq!(result.model, "claude-sonnet-4-20250514");
        assert!(result.estimated_cost > 0.0);
        assert!(result.cost_breakdown.input_cost >= 0.0);
        assert!(result.cost_breakdown.output_cost >= 0.0);
        assert!(result.cost_breakdown.tool_call_overhead_cost >= 0.0);
        assert!(result.estimated_seconds > 0.0);
        assert!(result.human_readable.contains("claude-sonnet-4-20250514"));
        assert!(result.human_readable.contains("moderate"));

        let serialized = serde_json::to_value(&result).expect("serializes");
        assert_eq!(serialized["estimatedCost"], json!(0.12));
        assert_eq!(serialized["costBreakdown"]["inputCost"], json!(0.009));
        assert_eq!(serialized["timeBreakdown"]["promptTokens"], json!(3000.0));
        assert_eq!(serialized["confidence"], json!("likely"));
    }

    #[test]
    fn falls_back_for_unknown_model_and_scales_costs() {
        let unknown = token_cost_estimate(TokenCostParams {
            tokens: 10_000.0,
            model: "unknown-model".to_string(),
            tool_calls: 0,
            reasoning_depth: ReasoningDepth::Shallow,
        });
        assert!(unknown.estimated_cost > 0.0);
        assert_eq!(unknown.confidence, ConfidenceLevel::Optimistic);

        let small = token_cost_estimate(TokenCostParams {
            tokens: 1_000.0,
            model: "gpt-4o".to_string(),
            tool_calls: 0,
            reasoning_depth: ReasoningDepth::Shallow,
        });
        let large = token_cost_estimate(TokenCostParams {
            tokens: 10_000.0,
            model: "gpt-4o".to_string(),
            tool_calls: 0,
            reasoning_depth: ReasoningDepth::Shallow,
        });
        assert!(large.estimated_cost > small.estimated_cost);
    }

    #[test]
    fn tool_calls_add_overhead_cost_and_time() {
        let no_tools = token_cost_estimate(TokenCostParams {
            tokens: 5_000.0,
            model: "gpt-4o".to_string(),
            tool_calls: 0,
            reasoning_depth: ReasoningDepth::Shallow,
        });
        let with_tools = token_cost_estimate(TokenCostParams {
            tokens: 5_000.0,
            model: "gpt-4o".to_string(),
            tool_calls: 10,
            reasoning_depth: ReasoningDepth::Shallow,
        });

        assert!(with_tools.estimated_cost > no_tools.estimated_cost);
        assert!(
            with_tools.cost_breakdown.tool_call_overhead_cost
                > no_tools.cost_breakdown.tool_call_overhead_cost
        );
        assert!(with_tools.estimated_seconds >= no_tools.estimated_seconds + 2.0);
    }

    #[test]
    fn token_time_bridge_preserves_breakdown_and_urgency() {
        let result = token_time_bridge(&TokenCostParams {
            tokens: 25_000.0,
            model: "gpt-4o-mini".to_string(),
            tool_calls: 1,
            reasoning_depth: ReasoningDepth::Shallow,
        });

        assert_eq!(
            result.breakdown.prompt_tokens + result.breakdown.completion_tokens,
            25_000.0
        );
        assert!(matches!(
            result.urgency,
            UrgencyCategory::Short | UrgencyCategory::Medium | UrgencyCategory::Long
        ));
        assert_eq!(result.confidence, ConfidenceLevel::Likely);
    }

    #[test]
    fn token_time_bridge_formats_token_count_like_typescript_locale() {
        let result = token_time_bridge(&TokenCostParams {
            tokens: 1_200.0,
            model: "gpt-4o-mini".to_string(),
            tool_calls: 0,
            reasoning_depth: ReasoningDepth::Shallow,
        });

        assert!(result.human_readable.contains("1,200 tokens"));
    }

    #[test]
    fn compares_models_by_cost_and_time() {
        let by_cost = compare_models(CompareModelsParams {
            tokens: 10_000.0,
            tool_calls: 2,
            reasoning_depth: ReasoningDepth::Moderate,
            sort_by: ModelSort::Cost,
        });
        assert_eq!(by_cost.models.len(), 12);
        assert_eq!(by_cost.tokens, 10_000.0);
        assert_eq!(by_cost.sort_by, "cost");
        for pair in by_cost.models.windows(2) {
            if pair[0].estimated_cost != 0.0 && pair[1].estimated_cost != 0.0 {
                assert!(pair[1].estimated_cost >= pair[0].estimated_cost);
            }
        }

        let by_time = compare_models(CompareModelsParams {
            tokens: 10_000.0,
            tool_calls: 2,
            reasoning_depth: ReasoningDepth::Moderate,
            sort_by: ModelSort::Time,
        });
        assert_eq!(by_time.sort_by, "time");
        for pair in by_time.models.windows(2) {
            assert!(pair[1].estimated_seconds >= pair[0].estimated_seconds);
        }
    }

    #[test]
    fn comparison_assigns_tiers_and_formats_table() {
        let result = compare_models(CompareModelsParams {
            tokens: 10_000.0,
            tool_calls: 0,
            reasoning_depth: ReasoningDepth::Shallow,
            sort_by: ModelSort::Cost,
        });

        assert!(
            result
                .models
                .iter()
                .any(|entry| entry.quality_tier == QualityTier::Fast)
        );
        assert!(
            result
                .models
                .iter()
                .any(|entry| entry.quality_tier == QualityTier::Standard)
        );
        assert!(
            result
                .models
                .iter()
                .any(|entry| entry.quality_tier == QualityTier::Premium)
        );
        assert!(result.human_readable.contains("Model"));
        assert!(result.human_readable.contains("Time (min)"));
        assert!(result.human_readable.contains("Cost ($)"));
        assert!(result.human_readable.lines().count() >= 14);
    }

    #[test]
    fn premium_model_costs_more_than_fast_model() {
        let premium = token_cost_estimate(TokenCostParams {
            tokens: 100_000.0,
            model: "claude-opus-4-20250514".to_string(),
            tool_calls: 0,
            reasoning_depth: ReasoningDepth::Moderate,
        });
        let fast = token_cost_estimate(TokenCostParams {
            tokens: 100_000.0,
            model: "gemini-2.0-flash".to_string(),
            tool_calls: 0,
            reasoning_depth: ReasoningDepth::Moderate,
        });
        assert!(premium.estimated_cost > fast.estimated_cost);
    }
}
