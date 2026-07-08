use chrono::Utc;
use epoch_contract::{
    BatchActualEntry, CpmTask, ESTIMATE_HOUR_FIELDS, EstimateRecord, MonteCarloTask,
    ReasoningDepth, ScopeSignal, TaskType, TimeUnit, ToolError, tool_names,
};
use epoch_core::{
    analytics::{
        HistoricalRecord, calibrate_estimates, compute_accuracy_trend, get_scope_guide,
        infer_scope_from_complexity, reference_class_estimate,
        reference_class_estimate_with_correction_factor,
    },
    calendar::{add_business_days, count_business_days},
    cocomo::{cocomo_validate, cocomo_validate_ground_truth},
    cost::{
        CompareModelsParams, ModelSort, TokenCostParams, compare_models, has_model_profile,
        token_cost_estimate_with_calibration, token_time_bridge_with_calibration,
    },
    estimation::{
        CocomoParams, SprintForecastParams, cocomo_estimate, critical_path, monte_carlo_sim,
        pert_estimate, sprint_forecast,
    },
    feedback::{CalibrationFilters, FeedbackStore},
    profiles::{DeveloperProfile, developer_profile},
    risk::{CalibrationRecord, ScheduleRiskParams, schedule_risk},
    temporal::{
        add_days, convert_timezone, diff_dates, format_elapsed, get_current_time, parse_duration,
    },
};
use epoch_data::{
    resolve_global_correction_factor, resolve_reference_correction_factor,
    resolve_token_time_calibration_tps,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub type ToolValueResult = Result<Value, ToolError>;

#[derive(Debug, Clone, Default)]
pub struct RustToolDispatcher {
    feedback: FeedbackStore,
    next_feedback_id: u64,
}

impl RustToolDispatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn persistent_from_env() -> std::io::Result<Self> {
        FeedbackStore::from_epoch_data_dir().map(Self::with_feedback_store)
    }

    pub fn with_feedback_store(feedback: FeedbackStore) -> Self {
        let next_feedback_id = next_feedback_id(&feedback);
        Self {
            feedback,
            next_feedback_id,
        }
    }

    pub fn feedback_store(&self) -> &FeedbackStore {
        &self.feedback
    }

    pub fn dispatch(&mut self, tool_name: &str, input: Value) -> ToolValueResult {
        let data = match tool_name {
            "get_current_time" => self.dispatch_get_current_time(&input)?,
            "convert_timezone" => self.dispatch_convert_timezone(&input)?,
            "parse_duration" => self.dispatch_parse_duration(&input)?,
            "time_math" => self.dispatch_time_math(&input)?,
            "add_business_days" => self.dispatch_add_business_days(&input)?,
            "count_business_days" => self.dispatch_count_business_days(&input)?,
            "pert_estimate" => self.dispatch_pert_estimate(&input)?,
            "cocomo_estimate" => self.dispatch_cocomo_estimate(&input)?,
            "sprint_forecast" => self.dispatch_sprint_forecast(&input)?,
            "critical_path" => self.dispatch_critical_path(&input)?,
            "monte_carlo_schedule" => self.dispatch_monte_carlo_schedule(&input)?,
            "reference_class_estimate" => self.dispatch_reference_class_estimate(&input)?,
            "calibrate_estimates" => self.dispatch_calibrate_estimates(&input)?,
            "token_time_bridge" => self.dispatch_token_time_bridge(&input)?,
            "token_cost_estimate" => self.dispatch_token_cost_estimate(&input)?,
            "compare_models" => self.dispatch_compare_models(&input)?,
            "accuracy_trend" => self.dispatch_accuracy_trend(&input)?,
            "schedule_risk" => self.dispatch_schedule_risk(&input)?,
            "cocomo_validate" => self.dispatch_cocomo_validate(&input)?,
            "cocomo_ground_truth" => self.dispatch_cocomo_ground_truth(&input)?,
            "record_actual" => self.dispatch_record_actual(&input)?,
            "get_pending_estimates" => self.dispatch_get_pending_estimates(&input)?,
            "batch_record_actuals" => self.dispatch_batch_record_actuals(&input)?,
            "feedback_health" => to_value(self.feedback.health_report())?,
            _ => return Err(unknown_tool_error(tool_name)),
        };

        self.record_feedback_candidate(tool_name, input, data)
    }

    fn dispatch_get_current_time(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let timezone = optional_string(object, &["timezone"])?.unwrap_or_else(|| "UTC".to_string());
        to_value(get_current_time(&timezone)?)
    }

    fn dispatch_convert_timezone(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let timestamp = required_string(object, &["timestamp"])?;
        let target_tz = required_string(object, &["target_tz", "targetTz"])?;
        to_value(convert_timezone(&timestamp, &target_tz)?)
    }

    fn dispatch_parse_duration(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let duration = required_string(object, &["duration_string", "durationString"])?;
        to_value(parse_duration(&duration)?)
    }

    fn dispatch_time_math(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let operation = required_string(object, &["operation"])?;
        let operands = operands_object(object.get("operands"))?;

        match operation.as_str() {
            "add_days" => {
                let date = required_string(
                    &operands,
                    &["start_date", "date", "from_date", "startDate", "fromDate"],
                )?;
                let days = required_i64(&operands, &["days"])?;
                to_value(add_days(&date, days))
            }
            "add_business_days" => {
                let start = required_string(
                    &operands,
                    &["start_date", "date", "from_date", "startDate", "fromDate"],
                )?;
                let days = required_i64(&operands, &["days"])?;
                let country =
                    optional_string(&operands, &["country"])?.unwrap_or_else(|| "US".to_string());
                to_value(add_business_days(&start, days, &country)?)
            }
            "diff" => {
                let start = required_string(
                    &operands,
                    &["start_date", "date", "from_date", "startDate", "fromDate"],
                )?;
                let end = required_string(
                    &operands,
                    &["end_date", "to_date", "endDate", "toDate", "end"],
                )?;
                to_value(diff_dates(&start, &end)?)
            }
            "convert_tz" => {
                let timestamp = required_string(&operands, &["timestamp"])?;
                let target_tz = required_string(&operands, &["target_tz", "targetTz"])?;
                to_value(convert_timezone(&timestamp, &target_tz)?)
            }
            "parse_nl" => {
                let duration = required_string(&operands, &["duration_string", "durationString"])?;
                to_value(parse_duration(&duration)?)
            }
            "format_duration" => {
                let milliseconds = required_i64(&operands, &["milliseconds"])?;
                to_value(format_elapsed(milliseconds))
            }
            _ => Err(ToolError::new(
                format!("Unknown time_math operation: {operation}"),
                "Use one of: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.",
            )),
        }
    }

    fn dispatch_add_business_days(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let start = required_string(object, &["start_date", "startDate"])?;
        let days = required_i64(object, &["days"])?;
        let country = optional_string(object, &["country"])?.unwrap_or_else(|| "US".to_string());
        to_value(add_business_days(&start, days, &country)?)
    }

    fn dispatch_count_business_days(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let start = required_string(object, &["start_date", "startDate"])?;
        let end = required_string(object, &["end_date", "endDate"])?;
        let country = optional_string(object, &["country"])?.unwrap_or_else(|| "US".to_string());
        to_value(count_business_days(&start, &end, &country)?)
    }

    fn dispatch_pert_estimate(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let optimistic = required_f64(object, &["optimistic"])?;
        let most_likely = required_f64(object, &["most_likely", "mostLikely"])?;
        let pessimistic = required_f64(object, &["pessimistic"])?;
        let unit = parse_time_unit(optional_string(object, &["unit"])?.as_deref())?;
        let mut data = to_value(pert_estimate(optimistic, most_likely, pessimistic, unit)?)?;

        let ai_ratio = ai_native_ratio(object)?;
        let profile = developer_profile(ai_ratio, resolve_global_correction_factor());
        let expected = data
            .get("expected")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        if let Some(out) = data.as_object_mut() {
            out.insert(
                "developerProfile".to_string(),
                profile_value(&profile, &["mode", "correctionFactor"]),
            );
            out.insert(
                "adjustedEstimate".to_string(),
                json!(round2(expected * profile.correction_factor)),
            );
        }

        // Cross-check against the reference class for AI-native workflows, mirroring
        // the TypeScript dispatcher (src/dispatcher/tool-registry.ts). Only read
        // task_type when the AI ratio qualifies, matching the TS guard.
        let cross_check_task_type = if ai_ratio >= 0.7 {
            optional_string(object, &["task_type", "taskType"])?
        } else {
            None
        };
        if let Some(task_type_raw) = cross_check_task_type {
            let task_type = parse_task_type(Some(&task_type_raw))?;
            let complexity = if expected <= 1.0 {
                1.0
            } else if expected <= 4.0 {
                2.0
            } else if expected <= 8.0 {
                3.0
            } else if expected <= 20.0 {
                4.0
            } else {
                5.0
            };
            let scope = infer_scope_from_complexity(complexity);
            let records = self.historical_records(CalibrationFilters {
                task_type: Some(task_type),
                ..CalibrationFilters::default()
            });
            let reference = reference_class_estimate(&records, task_type, 3.0, Some(scope), true);
            let reference_estimate = round2(reference.corrected_estimate);
            if let Some(out) = data.as_object_mut() {
                out.insert(
                    "referenceClassCrossCheck".to_string(),
                    json!({
                        "estimate": reference_estimate,
                        "scope": scope.as_str(),
                        "baselineSource": reference.baseline_source,
                        "sampleSize": reference.sample_size,
                    }),
                );
                if reference_estimate < expected * 0.5 {
                    out.insert(
                        "recommendation".to_string(),
                        json!(format!(
                            "For AI-native {} work, reference_class_estimate ({reference_estimate}h) is typically more accurate than PERT ({expected}h). AI agents finish local-prep tasks 3-10x faster than PERT pessimistic scenarios suggest.",
                            task_type.as_str()
                        )),
                    );
                }
            }
        }

        Ok(data)
    }

    fn dispatch_cocomo_estimate(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        // Zod clamps iterative_cycles to [0.5, 10.0] before the handler
        // normalizes literal cycle counts (> 2) into a multiplier.
        let iterative_cycles = enforce_bounds(
            optional_f64(object, &["iterative_cycles", "iterativeCycles"])?.unwrap_or(1.0),
            &["iterative_cycles", "iterativeCycles"],
            Some(0.5),
            Some(10.0),
        )?;
        let iterative_cycles = if iterative_cycles > 2.0 {
            1.0 + iterative_cycles.min(10.0) * 0.1
        } else {
            iterative_cycles
        };

        let mut data = to_value(cocomo_estimate(CocomoParams {
            kloc: required_f64(object, &["kloc"])?,
            reasoning_complexity: cocomo_factor(
                object,
                &["reasoning_complexity", "reasoningComplexity"],
            )?,
            context_completeness: cocomo_factor(
                object,
                &["context_completeness", "contextCompleteness"],
            )?,
            transformation_impact: cocomo_factor(
                object,
                &["transformation_impact", "transformationImpact"],
            )?,
            iterative_cycles,
            human_oversight: cocomo_factor(object, &["human_oversight", "humanOversight"])?,
        })?)?;

        let profile =
            developer_profile(ai_native_ratio(object)?, resolve_global_correction_factor());
        if let Some(out) = data.as_object_mut() {
            out.insert(
                "developerProfile".to_string(),
                profile_value(&profile, &["mode", "correctionFactor"]),
            );
        }
        Ok(data)
    }

    fn dispatch_sprint_forecast(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let mut data = to_value(sprint_forecast(SprintForecastParams {
            backlog_points: required_f64(object, &["backlog_points", "backlogPoints"])?,
            velocity_history: required_f64_array(object, &["velocity_history", "velocityHistory"])?,
            sprint_length_days: optional_f64(object, &["sprint_length_days", "sprintLengthDays"])?
                .unwrap_or(14.0),
            hours_per_sprint: optional_f64(object, &["hours_per_sprint", "hoursPerSprint"])?
                .unwrap_or(300.0),
        })?)?;

        let profile =
            developer_profile(ai_native_ratio(object)?, resolve_global_correction_factor());
        if let Some(out) = data.as_object_mut() {
            out.insert(
                "developerProfile".to_string(),
                profile_value(
                    &profile,
                    &["mode", "sprintVelocityPoints", "correctionFactor"],
                ),
            );
        }
        Ok(data)
    }

    fn dispatch_critical_path(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        to_value(critical_path(required_cpm_tasks(object, &["tasks"])?)?)
    }

    fn dispatch_monte_carlo_schedule(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let tasks = required_monte_carlo_tasks(object, &["tasks"])?;
        // Zod enforces `tasks.min(1)`; the core returns a placeholder result
        // (isError: false) for an empty list, so guard it at dispatch.
        if tasks.is_empty() {
            return Err(empty_array_error(&["tasks"]));
        }
        let iterations = optional_usize(object, &["iterations"])?.unwrap_or(10_000);
        if !(1..=100_000).contains(&iterations) {
            return Err(range_error(&["iterations"], "between 1 and 100000"));
        }
        let seed = optional_i64(object, &["seed"])?;
        to_value(monte_carlo_sim(tasks, iterations, seed))
    }

    fn dispatch_reference_class_estimate(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let task_type =
            parse_task_type(Some(&required_string(object, &["task_type", "taskType"])?))?;
        // Strict `z.number().min(1).max(5)` (no coercion), defaulting to 3.
        let complexity = match optional_f64_strict(object, &["complexity"])? {
            Some(value) => enforce_bounds(value, &["complexity"], Some(1.0), Some(5.0))?,
            None => 3.0,
        };
        let scope = parse_scope(optional_string(object, &["scope"])?.as_deref())?;
        let team_id = optional_string(object, &["team_id", "teamId"])?;
        let records = self.historical_records(CalibrationFilters {
            team_id,
            task_type: Some(task_type),
            ..CalibrationFilters::default()
        });
        let ai_native = ai_native_bool(object)?;
        let result = reference_class_estimate_with_correction_factor(
            &records,
            task_type,
            complexity,
            scope,
            ai_native,
            Some(resolve_reference_correction_factor(
                task_type,
                Some("reference_class_estimate"),
                Some(complexity),
            )),
        );
        let raw_estimate = result.raw_estimate;
        let mut data = to_value(result)?;

        let profile =
            developer_profile(ai_native_ratio(object)?, resolve_global_correction_factor());
        let note = if records.len() >= 5 {
            format!(
                "Based on {} historical records for \"{}\" tasks.",
                records.len(),
                task_type.as_str()
            )
        } else {
            "Using reference database correction factors. Submit actuals via /v1/feedback/record-actual to improve accuracy.".to_string()
        };
        if let Some(out) = data.as_object_mut() {
            if let Some(scope_guide) = get_scope_guide(task_type) {
                out.insert("scopeGuide".to_string(), json!(scope_guide));
            }
            out.insert(
                "developerProfile".to_string(),
                profile_value(
                    &profile,
                    &[
                        "mode",
                        "estimationMape",
                        "underestimationBias",
                        "correctionFactor",
                    ],
                ),
            );
            out.insert(
                "adjustedEstimate".to_string(),
                json!(round2(raw_estimate * profile.correction_factor)),
            );
            out.insert("note".to_string(), json!(note));
        }
        Ok(data)
    }

    fn dispatch_calibrate_estimates(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let team_id = required_string(object, &["team_id", "teamId"])?;
        let period_days = optional_u32(object, &["period_days", "periodDays"])?.unwrap_or(90);
        let minimum_samples =
            optional_usize(object, &["minimum_samples", "minimumSamples"])?.unwrap_or(10);
        let records = self.historical_records(CalibrationFilters {
            team_id: Some(team_id.clone()),
            window_days: Some(i64::from(period_days)),
            ..CalibrationFilters::default()
        });
        to_value(calibrate_estimates(
            &team_id,
            period_days,
            minimum_samples,
            &records,
            resolve_global_correction_factor(),
        ))
    }

    fn dispatch_token_time_bridge(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let params = token_params(object)?;
        let calibration_tps =
            resolve_token_time_calibration_tps(&params.model, !has_model_profile(&params.model));
        to_value(token_time_bridge_with_calibration(&params, calibration_tps))
    }

    fn dispatch_token_cost_estimate(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let params = token_params(object)?;
        let calibration_tps =
            resolve_token_time_calibration_tps(&params.model, !has_model_profile(&params.model));
        to_value(token_cost_estimate_with_calibration(
            params,
            calibration_tps,
        ))
    }

    fn dispatch_compare_models(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        to_value(compare_models(CompareModelsParams {
            tokens: enforce_positive(required_f64(object, &["tokens"])?, &["tokens"])?,
            tool_calls: optional_u32(object, &["tool_calls", "toolCalls"])?.unwrap_or(0),
            reasoning_depth: parse_reasoning_depth(
                optional_string(object, &["reasoning_depth", "reasoningDepth"])?.as_deref(),
            )?,
            sort_by: parse_model_sort(optional_string(object, &["sort_by", "sortBy"])?.as_deref())?,
        }))
    }

    fn dispatch_accuracy_trend(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let team_id = optional_string(object, &["team_id", "teamId"])?;
        let records = self.historical_records(CalibrationFilters {
            team_id,
            ..CalibrationFilters::default()
        });
        to_value(compute_accuracy_trend(
            &records,
            optional_usize(object, &["window_size", "windowSize"])?.or(Some(50)),
        ))
    }

    fn dispatch_schedule_risk(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let task_type = optional_string(object, &["task_type", "taskType"])?;
        let team_id = optional_string(object, &["team_id", "teamId"])?;
        let task_type_filter = task_type
            .as_deref()
            .map(|raw| parse_task_type(Some(raw)))
            .transpose()?;
        let records = self.risk_records(CalibrationFilters {
            team_id,
            task_type: task_type_filter,
            ..CalibrationFilters::default()
        });
        to_value(schedule_risk(ScheduleRiskParams {
            estimated_hours: required_f64(object, &["estimated_hours", "estimatedHours"])?,
            task_type,
            ai_native: ai_native_ratio(object)?,
            // Strict `z.number().min(1).max(5)` (no coercion), optional.
            complexity: optional_f64_strict(object, &["complexity"])?
                .map(|value| enforce_bounds(value, &["complexity"], Some(1.0), Some(5.0)))
                .transpose()?,
            records,
        }))
    }

    fn dispatch_cocomo_validate(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let filter = optional_string_array(object, &["dataset_filter", "datasetFilter"])?;
        let calibration = epoch_data::bundled_cocomo_calibration().map_err(data_error)?;
        to_value(cocomo_validate(
            &calibration.datasets,
            Some(&calibration.derived_factors.cocomo_basic),
            filter.as_deref(),
        )?)
    }

    fn dispatch_cocomo_ground_truth(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let filter = optional_string_array(object, &["dataset_filter", "datasetFilter"])?;
        let datasets = epoch_data::bundled_cocomo_datasets().map_err(data_error)?;
        to_value(cocomo_validate_ground_truth(
            &datasets,
            filter.as_deref(),
            resolve_global_correction_factor(),
        )?)
    }

    fn dispatch_record_actual(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let estimate_id = required_string(object, &["estimate_id", "estimateId"])?;
        // Strict `z.number().positive()` (no string/boolean coercion).
        let actual_hours = enforce_positive(
            required_f64_strict(object, &["actual_hours", "actualHours"])?,
            &["actual_hours"],
        )?;
        let notes = optional_string(object, &["notes"])?;
        self.feedback
            .record_actual_detailed(
                estimate_id.clone(),
                actual_hours,
                notes,
                Utc::now().to_rfc3339(),
            )
            .map_err(|reason| {
                ToolError::new(
                    format!("Failed to record actual for estimate {estimate_id}: {reason:?}."),
                    "Check estimate_id and actual_hours values.",
                )
            })?;

        Ok(json!({
            "recorded": true,
            "estimate_id": estimate_id,
            "actual_hours": actual_hours,
            "message": "Actual recorded. Correction factors update after more feedback accumulates."
        }))
    }

    fn dispatch_get_pending_estimates(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let limit = optional_usize(object, &["limit"])?.unwrap_or(20);
        let pending = self.feedback.pending_estimates(limit);
        let estimates = pending
            .iter()
            .rev()
            .take(10)
            .rev()
            .map(|record| {
                json!({
                    "id": record.estimate.id,
                    "tool": record.estimate.tool,
                    "inputs": record.estimate.inputs,
                    "estimatedAt": record.estimate.estimated_at,
                })
            })
            .collect::<Vec<_>>();
        let summary = if pending.is_empty() {
            "No pending estimates — all recent estimates have actuals recorded.".to_string()
        } else {
            format!(
                "{} estimates awaiting actuals. Use record_actual with an estimate ID and the real hours spent to close the feedback loop.",
                pending.len()
            )
        };

        Ok(json!({
            "count": pending.len(),
            "summary": summary,
            "estimates": estimates,
        }))
    }

    fn dispatch_batch_record_actuals(&mut self, input: &Value) -> ToolValueResult {
        let object = object(input)?;
        let entries = required_batch_entries(object, &["entries"])?;
        // Zod enforces `entries.min(1).max(500)`.
        if entries.is_empty() {
            return Err(empty_array_error(&["entries"]));
        }
        if entries.len() > 500 {
            return Err(range_error(&["entries"], "at most 500 entries"));
        }
        let result = self
            .feedback
            .batch_record_actuals(&entries, Utc::now().to_rfc3339());
        if result.succeeded == 0 && result.failed > 0 {
            return Err(ToolError::new(
                format!("All {} entries failed to record.", result.total),
                "Check estimate IDs, avoid duplicates, and ensure actual_hours are positive.",
            ));
        }
        to_value(result)
    }

    fn record_feedback_candidate(
        &mut self,
        tool_name: &str,
        input: Value,
        mut data: Value,
    ) -> ToolValueResult {
        let Some(output) = data.as_object() else {
            return Ok(data);
        };
        if !has_hour_estimate(output) {
            return Ok(data);
        }

        self.next_feedback_id += 1;
        let estimate_id = format!("rust-estimate-{}", self.next_feedback_id);
        self.feedback
            .record_estimate(EstimateRecord {
                id: estimate_id.clone(),
                tool: tool_name.to_string(),
                inputs: value_object_to_btree(input.as_object()),
                outputs: value_object_to_btree(Some(output)),
                estimated_at: Utc::now().to_rfc3339(),
                source: None,
            })
            .map_err(|reason| {
                ToolError::new(
                    format!("Failed to record feedback estimate for {tool_name}: {reason:?}."),
                    "Check EPOCH_DATA_DIR permissions or retry with a writable data directory.",
                )
            })?;

        if let Some(output) = data.as_object_mut() {
            output.insert("feedbackRef".to_string(), Value::String(estimate_id));
        }
        Ok(data)
    }

    fn historical_records(&self, filters: CalibrationFilters) -> Vec<HistoricalRecord> {
        self.feedback
            .calibration_data(filters)
            .into_iter()
            .map(|record| HistoricalRecord {
                task_type: record.task_type,
                estimated_hours: record.estimated_hours,
                actual_hours: record.actual_hours,
                team_id: record.team_id,
                tool: record.tool,
                complexity: record.complexity,
                completed_at: Some(record.completed_at),
            })
            .collect()
    }

    fn risk_records(&self, filters: CalibrationFilters) -> Vec<CalibrationRecord> {
        self.feedback
            .calibration_data(filters)
            .into_iter()
            .map(|record| CalibrationRecord {
                task_type: Some(record.task_type.as_str().to_string()),
                estimated_hours: record.estimated_hours,
                actual_hours: record.actual_hours,
            })
            .collect()
    }
}

pub fn dispatch_stateless(tool_name: &str, input: Value) -> ToolValueResult {
    RustToolDispatcher::new().dispatch(tool_name, input)
}

fn unknown_tool_error(tool_name: &str) -> ToolError {
    let available = tool_names();
    ToolError::new(
        format!("Unknown tool: \"{tool_name}\"."),
        format!("Available tools: {}", available.join(", ")),
    )
}

fn object(input: &Value) -> Result<&Map<String, Value>, ToolError> {
    input.as_object().ok_or_else(|| {
        ToolError::new(
            "Tool input must be a JSON object.",
            "Pass key-value JSON matching the selected tool schema.",
        )
    })
}

fn operands_object(value: Option<&Value>) -> Result<Map<String, Value>, ToolError> {
    match value {
        Some(Value::Object(object)) => Ok(object.clone()),
        Some(Value::String(raw)) => serde_json::from_str::<Map<String, Value>>(raw).map_err(|_| {
            ToolError::new(
                "operands must be a JSON object or stringified JSON object.",
                "Pass operands as an object such as {\"start_date\":\"2026-05-01\",\"days\":3}.",
            )
        }),
        Some(_) | None => Ok(Map::new()),
    }
}

fn get<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| object.get(*key))
}

fn required_string(object: &Map<String, Value>, keys: &[&str]) -> Result<String, ToolError> {
    optional_string(object, keys)?.ok_or_else(|| missing(keys, "string"))
}

fn optional_string(
    object: &Map<String, Value>,
    keys: &[&str],
) -> Result<Option<String>, ToolError> {
    match get(object, keys) {
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(Value::Number(value)) => Ok(Some(value.to_string())),
        Some(Value::Bool(value)) => Ok(Some(value.to_string())),
        Some(Value::Null) | None => Ok(None),
        Some(_) => Err(wrong_type(keys, "string")),
    }
}

fn required_f64(object: &Map<String, Value>, keys: &[&str]) -> Result<f64, ToolError> {
    optional_f64(object, keys)?.ok_or_else(|| missing(keys, "number"))
}

/// Coercing number reader — mirrors Zod `z.coerce.number()`, which runs
/// `Number(value)` before validating. That accepts numeric strings and
/// booleans (true => 1, false => 0). Use the `_strict` variant below for
/// fields declared as a plain `z.number()`, which reject strings/booleans.
fn optional_f64(object: &Map<String, Value>, keys: &[&str]) -> Result<Option<f64>, ToolError> {
    let Some(value) = get(object, keys) else {
        return Ok(None);
    };
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(raw) => raw.parse::<f64>().ok(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => return Ok(None),
        _ => None,
    };
    parsed
        .filter(|value| value.is_finite())
        .map(Some)
        .ok_or_else(|| wrong_type(keys, "finite number"))
}

/// Strict number reader — mirrors Zod `z.number()` (no coercion): only a JSON
/// number is accepted; strings and booleans are rejected as wrong types.
fn required_f64_strict(object: &Map<String, Value>, keys: &[&str]) -> Result<f64, ToolError> {
    optional_f64_strict(object, keys)?.ok_or_else(|| missing(keys, "number"))
}

fn optional_f64_strict(
    object: &Map<String, Value>,
    keys: &[&str],
) -> Result<Option<f64>, ToolError> {
    match get(object, keys) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|value| value.is_finite())
            .map(Some)
            .ok_or_else(|| wrong_type(keys, "finite number")),
        Some(_) => Err(wrong_type(keys, "number")),
    }
}

/// Inclusive range guard mirroring Zod `.min()` / `.max()`.
fn enforce_bounds(
    value: f64,
    keys: &[&str],
    min: Option<f64>,
    max: Option<f64>,
) -> Result<f64, ToolError> {
    if let Some(min) = min
        && value < min
    {
        return Err(range_error(
            keys,
            &format!("greater than or equal to {min}"),
        ));
    }
    if let Some(max) = max
        && value > max
    {
        return Err(range_error(keys, &format!("less than or equal to {max}")));
    }
    Ok(value)
}

/// Exclusive positivity guard mirroring Zod `.positive()` (> 0).
fn enforce_positive(value: f64, keys: &[&str]) -> Result<f64, ToolError> {
    if value > 0.0 {
        Ok(value)
    } else {
        Err(range_error(keys, "greater than 0"))
    }
}

fn range_error(keys: &[&str], constraint: &str) -> ToolError {
    ToolError::new(
        format!("Field {} must be {constraint}.", keys[0]),
        format!("Pass {} as a number {constraint}.", keys[0]),
    )
}

fn empty_array_error(keys: &[&str]) -> ToolError {
    ToolError::new(
        format!("{} must contain at least 1 element.", keys[0]),
        format!("Pass a non-empty array for {}.", keys[0]),
    )
}

/// COCOMO cost-driver multiplier: coerced number defaulting to 1.0, clamped to
/// the Zod `[0.5, 2.0]` band.
fn cocomo_factor(object: &Map<String, Value>, keys: &[&str]) -> Result<f64, ToolError> {
    enforce_bounds(
        optional_f64(object, keys)?.unwrap_or(1.0),
        keys,
        Some(0.5),
        Some(2.0),
    )
}

fn required_i64(object: &Map<String, Value>, keys: &[&str]) -> Result<i64, ToolError> {
    optional_i64(object, keys)?.ok_or_else(|| missing(keys, "integer"))
}

fn optional_i64(object: &Map<String, Value>, keys: &[&str]) -> Result<Option<i64>, ToolError> {
    let Some(value) = get(object, keys) else {
        return Ok(None);
    };
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value.round() as i64))
            .map(Some)
            .ok_or_else(|| wrong_type(keys, "integer")),
        Value::String(raw) => raw
            .parse::<f64>()
            .map(|value| Some(value.round() as i64))
            .map_err(|_| wrong_type(keys, "integer")),
        Value::Null => Ok(None),
        _ => Err(wrong_type(keys, "integer")),
    }
}

fn optional_u32(object: &Map<String, Value>, keys: &[&str]) -> Result<Option<u32>, ToolError> {
    optional_i64(object, keys)?
        .map(|value| {
            u32::try_from(value).map_err(|_| {
                ToolError::new(
                    "Integer must be non-negative and fit u32.",
                    "Pass a smaller positive integer.",
                )
            })
        })
        .transpose()
}

fn optional_usize(object: &Map<String, Value>, keys: &[&str]) -> Result<Option<usize>, ToolError> {
    optional_i64(object, keys)?
        .map(|value| {
            usize::try_from(value).map_err(|_| {
                ToolError::new("Integer must be non-negative.", "Pass a positive integer.")
            })
        })
        .transpose()
}

fn required_f64_array(object: &Map<String, Value>, keys: &[&str]) -> Result<Vec<f64>, ToolError> {
    let Some(Value::Array(values)) = get(object, keys) else {
        return Err(missing(keys, "number array"));
    };
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            match value {
                Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
                Value::String(raw) => raw.parse::<f64>().ok().filter(|value| value.is_finite()),
                _ => None,
            }
            .ok_or_else(|| {
                ToolError::new(
                    format!("{}[{index}] must be a finite number.", keys[0]),
                    "Pass an array of numeric values.",
                )
            })
        })
        .collect()
}

fn optional_string_array(
    object: &Map<String, Value>,
    keys: &[&str],
) -> Result<Option<Vec<String>>, ToolError> {
    let Some(value) = get(object, keys) else {
        return Ok(None);
    };
    match value {
        Value::Array(values) => values
            .iter()
            .map(|value| match value {
                Value::String(raw) => Ok(raw.clone()),
                Value::Number(number) => Ok(number.to_string()),
                _ => Err(wrong_type(keys, "string array")),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Value::String(raw) => Ok(Some(vec![raw.clone()])),
        Value::Null => Ok(None),
        _ => Err(wrong_type(keys, "string array")),
    }
}

fn required_cpm_tasks(
    input_object: &Map<String, Value>,
    keys: &[&str],
) -> Result<Vec<CpmTask>, ToolError> {
    let Some(Value::Array(tasks)) = get(input_object, keys) else {
        return Err(missing(keys, "task array"));
    };
    tasks
        .iter()
        .enumerate()
        .map(|(index, task)| {
            let task = object(task).map_err(|_| wrong_task(index))?;
            Ok(CpmTask {
                name: required_string(task, &["name"])?,
                duration: required_f64(task, &["duration"])?,
                predecessors: optional_string_array(task, &["predecessors"])?.unwrap_or_default(),
            })
        })
        .collect()
}

fn required_monte_carlo_tasks(
    input_object: &Map<String, Value>,
    keys: &[&str],
) -> Result<Vec<MonteCarloTask>, ToolError> {
    let Some(Value::Array(tasks)) = get(input_object, keys) else {
        return Err(missing(keys, "task array"));
    };
    tasks
        .iter()
        .enumerate()
        .map(|(index, task)| {
            let task = object(task).map_err(|_| wrong_task(index))?;
            Ok(MonteCarloTask {
                name: required_string(task, &["name"])?,
                optimistic: required_f64(task, &["optimistic"])?,
                most_likely: required_f64(task, &["most_likely", "mostLikely"])?,
                pessimistic: required_f64(task, &["pessimistic"])?,
            })
        })
        .collect()
}

fn required_batch_entries(
    input_object: &Map<String, Value>,
    keys: &[&str],
) -> Result<Vec<BatchActualEntry>, ToolError> {
    let Some(Value::Array(entries)) = get(input_object, keys) else {
        return Err(missing(keys, "entry array"));
    };
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let entry = object(entry).map_err(|_| {
                ToolError::new(
                    format!("entries[{index}] must be an object."),
                    "Pass entries as {estimate_id, actual_hours, notes?}.",
                )
            })?;
            Ok(BatchActualEntry {
                estimate_id: required_string(entry, &["estimate_id", "estimateId"])?,
                // Strict `z.number().positive()` per-entry.
                actual_hours: enforce_positive(
                    required_f64_strict(entry, &["actual_hours", "actualHours"])?,
                    &["actual_hours"],
                )?,
                notes: optional_string(entry, &["notes"])?,
            })
        })
        .collect()
}

fn token_params(object: &Map<String, Value>) -> Result<TokenCostParams, ToolError> {
    Ok(TokenCostParams {
        tokens: enforce_positive(required_f64(object, &["tokens"])?, &["tokens"])?,
        model: required_string(object, &["model"])?,
        tool_calls: optional_u32(object, &["tool_calls", "toolCalls"])?.unwrap_or(0),
        reasoning_depth: parse_reasoning_depth(
            optional_string(object, &["reasoning_depth", "reasoningDepth"])?.as_deref(),
        )?,
    })
}

fn parse_time_unit(raw: Option<&str>) -> Result<TimeUnit, ToolError> {
    match raw.unwrap_or("hours") {
        "hours" => Ok(TimeUnit::Hours),
        "days" => Ok(TimeUnit::Days),
        "weeks" => Ok(TimeUnit::Weeks),
        "months" => Ok(TimeUnit::Months),
        other => Err(ToolError::new(
            format!("Invalid time unit: {other}."),
            "Use one of: hours, days, weeks, months.",
        )),
    }
}

fn parse_task_type(raw: Option<&str>) -> Result<TaskType, ToolError> {
    match raw.unwrap_or("feature") {
        "feature" => Ok(TaskType::Feature),
        "bugfix" => Ok(TaskType::Bugfix),
        "refactor" => Ok(TaskType::Refactor),
        "migration" => Ok(TaskType::Migration),
        "infrastructure" => Ok(TaskType::Infrastructure),
        "documentation" => Ok(TaskType::Documentation),
        "testing" => Ok(TaskType::Testing),
        "design" => Ok(TaskType::Design),
        other => Err(ToolError::new(
            format!("Invalid task_type: {other}."),
            "Use one of: feature, bugfix, refactor, migration, infrastructure, documentation, testing, design.",
        )),
    }
}

fn parse_scope(raw: Option<&str>) -> Result<Option<ScopeSignal>, ToolError> {
    match raw {
        None => Ok(None),
        Some("small") => Ok(Some(ScopeSignal::Small)),
        Some("medium") => Ok(Some(ScopeSignal::Medium)),
        Some("large") => Ok(Some(ScopeSignal::Large)),
        Some("xl") => Ok(Some(ScopeSignal::Xl)),
        Some(other) => Err(ToolError::new(
            format!("Invalid scope: {other}."),
            "Use one of: small, medium, large, xl.",
        )),
    }
}

fn parse_reasoning_depth(raw: Option<&str>) -> Result<ReasoningDepth, ToolError> {
    match raw.unwrap_or("moderate") {
        "shallow" => Ok(ReasoningDepth::Shallow),
        "moderate" => Ok(ReasoningDepth::Moderate),
        "deep" => Ok(ReasoningDepth::Deep),
        other => Err(ToolError::new(
            format!("Invalid reasoning_depth: {other}."),
            "Use one of: shallow, moderate, deep.",
        )),
    }
}

fn parse_model_sort(raw: Option<&str>) -> Result<ModelSort, ToolError> {
    match raw.unwrap_or("cost") {
        "cost" => Ok(ModelSort::Cost),
        "time" => Ok(ModelSort::Time),
        other => Err(ToolError::new(
            format!("Invalid sort_by: {other}."),
            "Use cost or time.",
        )),
    }
}

fn ai_native_ratio(object: &Map<String, Value>) -> Result<f64, ToolError> {
    match get(object, &["ai_native", "aiNative"]) {
        Some(Value::Bool(value)) => Ok(if *value { 1.0 } else { 0.0 }),
        Some(Value::Number(number)) => number
            .as_f64()
            .map(|value| value.clamp(0.0, 1.0))
            .ok_or_else(|| wrong_type(&["ai_native"], "number or boolean")),
        Some(Value::String(raw)) => raw
            .parse::<f64>()
            .map(|value| value.clamp(0.0, 1.0))
            .map_err(|_| wrong_type(&["ai_native"], "number or boolean")),
        Some(Value::Null) | None => Ok(1.0),
        Some(_) => Err(wrong_type(&["ai_native"], "number or boolean")),
    }
}

fn ai_native_bool(object: &Map<String, Value>) -> Result<bool, ToolError> {
    Ok(ai_native_ratio(object)? >= 0.7)
}

fn to_value<T: Serialize>(value: T) -> ToolValueResult {
    serde_json::to_value(value).map_err(|error| {
        ToolError::new(
            format!("Failed to serialize tool result: {error}."),
            "Report this serialization failure with the tool input that caused it.",
        )
    })
}

/// Build the developer-profile enrichment object from the requested camelCase
/// field subset, mirroring the per-tool shapes in the TypeScript dispatcher.
fn profile_value(profile: &DeveloperProfile, fields: &[&str]) -> Value {
    let mut map = Map::new();
    for field in fields {
        let value = match *field {
            "mode" => json!(profile.mode),
            "correctionFactor" => json!(profile.correction_factor),
            "sprintVelocityPoints" => json!(profile.sprint_velocity_points),
            "estimationMape" => json!(profile.estimation_mape),
            "underestimationBias" => json!(profile.underestimation_bias),
            _ => continue,
        };
        map.insert((*field).to_string(), value);
    }
    Value::Object(map)
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn data_error(error: serde_json::Error) -> ToolError {
    ToolError::new(
        format!("Failed to load bundled data: {error}."),
        "Ensure bundled Epoch data files are valid JSON.",
    )
}

fn has_hour_estimate(output: &Map<String, Value>) -> bool {
    ESTIMATE_HOUR_FIELDS
        .iter()
        .any(|field| output.get(*field).is_some_and(Value::is_number))
}

fn value_object_to_btree(object: Option<&Map<String, Value>>) -> BTreeMap<String, Value> {
    object
        .into_iter()
        .flat_map(|object| object.iter())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn next_feedback_id(feedback: &FeedbackStore) -> u64 {
    feedback
        .estimates()
        .iter()
        .filter_map(|estimate| estimate.id.strip_prefix("rust-estimate-"))
        .filter_map(|suffix| suffix.parse::<u64>().ok())
        .max()
        .unwrap_or(0)
}

fn missing(keys: &[&str], expected: &str) -> ToolError {
    ToolError::new(
        format!("Missing required {expected} field: {}.", keys[0]),
        format!("Pass {} as a {expected}.", keys[0]),
    )
}

fn wrong_type(keys: &[&str], expected: &str) -> ToolError {
    ToolError::new(
        format!("Field {} must be a {expected}.", keys[0]),
        format!("Pass {} as a {expected}.", keys[0]),
    )
}

fn wrong_task(index: usize) -> ToolError {
    ToolError::new(
        format!("tasks[{index}] must be an object."),
        "Pass each task as an object with the required fields.",
    )
}

#[cfg(test)]
mod tests {
    use super::{RustToolDispatcher, dispatch_stateless};
    use epoch_contract::{ToolError, tool_names};
    use epoch_core::feedback::FeedbackStore;
    use serde_json::{Value, json};
    use std::fs;

    #[test]
    fn rejects_unknown_tools_with_available_list() {
        let error = dispatch_stateless("missing_tool", json!({})).expect_err("unknown tool fails");

        assert!(error.message.contains("Unknown tool"));
        assert!(
            error
                .retry_hint
                .expect("retry hint")
                .contains("get_current_time")
        );
    }

    // ---------------------------------------------------------------------
    // Adversarial parity with the TypeScript Zod schemas. Each case mirrors a
    // `scripts/rust-adversarial-contract.ts` diff: malformed input the TS
    // dispatcher rejects must also be rejected here, and input TS accepts must
    // be accepted, so the Rust-replaces-TypeScript promotion stays compatible.
    // ---------------------------------------------------------------------

    fn reject(tool: &str, args: Value) -> ToolError {
        dispatch_stateless(tool, args).expect_err("expected adversarial input to be rejected")
    }

    #[test]
    fn strict_number_fields_reject_string_coercion() {
        // record_actual.actual_hours and schedule_risk.complexity are plain
        // `z.number()` in TS (no coercion): strings must be rejected.
        reject(
            "record_actual",
            json!({ "estimate_id": "abc", "actual_hours": "5" }),
        );
        reject(
            "schedule_risk",
            json!({ "estimated_hours": 8, "complexity": "3" }),
        );
    }

    #[test]
    fn numeric_range_bounds_match_zod() {
        // cocomo reasoning_complexity max 2.0
        reject(
            "cocomo_estimate",
            json!({ "kloc": 2, "reasoning_complexity": 99 }),
        );
        // monte_carlo iterations max 100000
        reject(
            "monte_carlo_schedule",
            json!({
                "tasks": [{ "name": "A", "optimistic": 1, "most_likely": 2, "pessimistic": 4 }],
                "iterations": 100001,
            }),
        );
        // schedule_risk complexity max 5
        reject(
            "schedule_risk",
            json!({ "estimated_hours": 8, "complexity": 50 }),
        );
        // token_cost tokens must be positive
        reject(
            "token_cost_estimate",
            json!({ "tokens": -1000, "model": "gpt-4o-mini" }),
        );
        // reference_class complexity min 1
        reject(
            "reference_class_estimate",
            json!({ "task_type": "feature", "complexity": 0 }),
        );
    }

    #[test]
    fn empty_arrays_are_rejected() {
        // The cores return placeholder/no-op results for these, so the guard
        // lives in the dispatcher to match Zod `.min(1)`.
        reject(
            "monte_carlo_schedule",
            json!({ "tasks": [], "iterations": 100 }),
        );
        reject("batch_record_actuals", json!({ "entries": [] }));
    }

    #[test]
    fn coerced_number_fields_accept_boolean_like_zod() {
        // pert uses `z.coerce.number()`, which coerces true => 1.0.
        let mut dispatcher = RustToolDispatcher::new();
        let result = dispatcher
            .dispatch(
                "pert_estimate",
                json!({ "optimistic": 1, "most_likely": true, "pessimistic": 4 }),
            )
            .expect("boolean most_likely coerces to 1.0");
        assert_eq!(result["mostLikely"], 1.0);
    }

    #[test]
    fn pert_tolerates_overflowing_variance_like_typescript() {
        // TS only finite-checks expected/stdDev, accepting an extreme
        // pessimistic value whose variance overflows; the dispatch must not
        // reject it.
        let mut dispatcher = RustToolDispatcher::new();
        let result = dispatcher
            .dispatch(
                "pert_estimate",
                json!({ "optimistic": 1, "most_likely": 2, "pessimistic": 1e308 }),
            )
            .expect("extreme pessimistic is accepted");
        // Non-finite variance serializes to JSON null, matching TS.
        assert!(result.get("variance").is_some_and(Value::is_null));
    }

    #[test]
    fn dispatches_temporal_and_time_math_tools() {
        let mut dispatcher = RustToolDispatcher::new();

        let now = dispatcher
            .dispatch("get_current_time", json!({ "timezone": "UTC" }))
            .expect("current time dispatches");
        assert!(now.get("iso").is_some());
        assert!(now.get("feedbackRef").is_none());

        let parsed = dispatcher
            .dispatch("parse_duration", json!({ "duration_string": "2h30m" }))
            .expect("duration parses");
        assert_eq!(parsed["totalSeconds"], 9000.0);

        let added = dispatcher
            .dispatch(
                "time_math",
                json!({
                    "operation": "add_business_days",
                    "operands": { "startDate": "2026-06-19", "days": 1, "country": "US" }
                }),
            )
            .expect("time_math dispatches");
        assert_eq!(added["endDate"], "2026-06-22");
    }

    #[test]
    fn dispatches_estimates_and_records_feedback_refs() {
        let mut dispatcher = RustToolDispatcher::new();

        let result = dispatcher
            .dispatch(
                "pert_estimate",
                json!({
                    "optimistic": 2,
                    "most_likely": 5,
                    "pessimistic": 10,
                    "unit": "hours",
                    "task_type": "feature"
                }),
            )
            .expect("pert dispatches");

        assert_eq!(result["expected"], 5.33);
        assert_eq!(result["feedbackRef"], "rust-estimate-1");
        assert_eq!(dispatcher.feedback_store().estimates().len(), 1);

        let pending = dispatcher
            .dispatch("get_pending_estimates", json!({}))
            .expect("pending dispatches");
        assert_eq!(pending["count"], 1);
        assert_eq!(pending["estimates"][0]["id"], "rust-estimate-1");

        let recorded = dispatcher
            .dispatch(
                "record_actual",
                json!({ "estimate_id": "rust-estimate-1", "actual_hours": 6 }),
            )
            .expect("actual records");
        assert_eq!(recorded["recorded"], true);

        let health = dispatcher
            .dispatch("feedback_health", json!({}))
            .expect("health dispatches");
        assert_eq!(health["totalEstimates"], 1);
        assert_eq!(health["totalActuals"], 1);

        let empty_pending = dispatcher
            .dispatch("get_pending_estimates", json!({}))
            .expect("empty pending dispatches");
        assert_eq!(empty_pending["count"], 0);
        assert_eq!(
            empty_pending["summary"],
            "No pending estimates — all recent estimates have actuals recorded."
        );
    }

    #[test]
    fn persistent_dispatcher_appends_feedback_jsonl_records() {
        let dir = temp_data_dir("dispatcher");
        let store = FeedbackStore::from_data_dir(&dir).expect("persistent store");
        let mut dispatcher = RustToolDispatcher::with_feedback_store(store);

        let result = dispatcher
            .dispatch(
                "pert_estimate",
                json!({
                    "optimistic": 1,
                    "most_likely": 2,
                    "pessimistic": 4,
                    "task_type": "bugfix"
                }),
            )
            .expect("estimate dispatches");
        let estimate_id = result["feedbackRef"].as_str().expect("feedback ref");
        assert_eq!(estimate_id, "rust-estimate-1");

        dispatcher
            .dispatch(
                "record_actual",
                json!({ "estimate_id": estimate_id, "actual_hours": 2.5 }),
            )
            .expect("actual records");

        let estimates = fs::read_to_string(dir.join("estimates.jsonl")).expect("estimates file");
        assert!(estimates.contains(r#""id":"rust-estimate-1""#));
        assert!(estimates.contains(r#""estimatedAt":"#));
        let actuals = fs::read_to_string(dir.join("feedback.jsonl")).expect("actuals file");
        assert!(actuals.contains(r#""estimateId":"rust-estimate-1""#));
        assert!(actuals.contains(r#""actualHours":2.5"#));

        fs::remove_dir_all(dir).expect("cleanup temp data dir");
    }

    #[test]
    fn dispatches_cost_analytics_risk_and_validation_tools() {
        let mut dispatcher = RustToolDispatcher::new();

        let token_time = dispatcher
            .dispatch(
                "token_time_bridge",
                json!({ "tokens": 1200, "model": "gpt-4o-mini", "reasoning_depth": "shallow" }),
            )
            .expect("token time dispatches");
        assert!(token_time["estimatedSeconds"].as_f64().expect("seconds") > 0.0);

        let compare = dispatcher
            .dispatch(
                "compare_models",
                json!({ "tokens": 1200, "sort_by": "time" }),
            )
            .expect("compare dispatches");
        assert!(compare["models"].as_array().expect("models").len() > 5);

        let reference = dispatcher
            .dispatch(
                "reference_class_estimate",
                json!({ "task_type": "bugfix", "complexity": 2, "scope": "small" }),
            )
            .expect("reference class dispatches");
        assert!(reference["correctedEstimate"].as_f64().expect("estimate") > 0.0);

        let risk = dispatcher
            .dispatch(
                "schedule_risk",
                json!({ "estimated_hours": 12, "task_type": "feature" }),
            )
            .expect("risk dispatches");
        assert_eq!(risk["estimatedHours"], 12.0);

        let validate = dispatcher
            .dispatch("cocomo_validate", json!({ "dataset_filter": ["NASA93"] }))
            .expect("cocomo validate dispatches");
        assert_eq!(validate["projectsEvaluated"], 93);

        let ground_truth = dispatcher
            .dispatch(
                "cocomo_ground_truth",
                json!({ "dataset_filter": ["NASA93"] }),
            )
            .expect("cocomo ground truth dispatches");
        assert_eq!(ground_truth["projectsEvaluated"], 93);
    }

    #[test]
    fn all_registered_tools_have_a_dispatch_path() {
        let mut dispatcher = RustToolDispatcher::new();
        let samples = sample_inputs();

        for tool_name in tool_names() {
            let input = samples
                .get(tool_name.as_str())
                .unwrap_or_else(|| panic!("missing sample input for {tool_name}"))
                .clone();
            dispatcher
                .dispatch(&tool_name, input)
                .unwrap_or_else(|error| panic!("{tool_name} failed: {error:?}"));
        }
    }

    fn sample_inputs() -> std::collections::BTreeMap<&'static str, Value> {
        std::collections::BTreeMap::from([
            ("get_current_time", json!({ "timezone": "UTC" })),
            (
                "convert_timezone",
                json!({ "timestamp": "2026-06-24T12:00:00Z", "target_tz": "America/Los_Angeles" }),
            ),
            ("parse_duration", json!({ "duration_string": "1h" })),
            (
                "time_math",
                json!({ "operation": "diff", "operands": { "start_date": "2026-06-24", "end_date": "2026-06-25" } }),
            ),
            (
                "add_business_days",
                json!({ "start_date": "2026-06-24", "days": 2 }),
            ),
            (
                "count_business_days",
                json!({ "start_date": "2026-06-24", "end_date": "2026-06-30" }),
            ),
            (
                "pert_estimate",
                json!({ "optimistic": 1, "most_likely": 2, "pessimistic": 4 }),
            ),
            ("cocomo_estimate", json!({ "kloc": 2 })),
            (
                "sprint_forecast",
                json!({ "backlog_points": 20, "velocity_history": [8, 10, 9] }),
            ),
            (
                "critical_path",
                json!({ "tasks": [{ "name": "A", "duration": 1, "predecessors": [] }] }),
            ),
            (
                "monte_carlo_schedule",
                json!({ "tasks": [{ "name": "A", "optimistic": 1, "most_likely": 2, "pessimistic": 4 }], "iterations": 10 }),
            ),
            (
                "reference_class_estimate",
                json!({ "task_type": "feature", "complexity": 3 }),
            ),
            ("calibrate_estimates", json!({ "team_id": "team-a" })),
            (
                "token_time_bridge",
                json!({ "tokens": 1000, "model": "gpt-4o-mini" }),
            ),
            (
                "token_cost_estimate",
                json!({ "tokens": 1000, "model": "gpt-4o-mini" }),
            ),
            ("compare_models", json!({ "tokens": 1000 })),
            ("accuracy_trend", json!({})),
            ("schedule_risk", json!({ "estimated_hours": 8 })),
            ("cocomo_validate", json!({ "dataset_filter": ["NASA93"] })),
            (
                "cocomo_ground_truth",
                json!({ "dataset_filter": ["NASA93"] }),
            ),
            (
                "record_actual",
                json!({ "estimate_id": "rust-estimate-1", "actual_hours": 2 }),
            ),
            ("get_pending_estimates", json!({})),
            (
                "batch_record_actuals",
                json!({ "entries": [{ "estimate_id": "rust-estimate-2", "actual_hours": 3 }] }),
            ),
            ("feedback_health", json!({})),
        ])
    }

    fn temp_data_dir(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "epoch-rust-dispatcher-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now()
                .timestamp_nanos_opt()
                .expect("timestamp nanos")
        ))
    }
}
