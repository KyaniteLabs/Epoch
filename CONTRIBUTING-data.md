# Contributing Data to Epoch

Epoch's estimation accuracy improves with real-world data. Community contributions directly make the tool better for everyone by grounding our models in observed outcomes rather than theoretical assumptions.

Whether you have a handful of sprint records or months of estimation data, your contribution helps calibrate the models that power `reference_class_estimate`, `calibrate_estimates`, `schedule_risk`, `cocomo_validate`, `token_cost_estimate`, and `compare_models`.

## Why Your Data Matters

Epoch's estimation accuracy scales with the diversity and volume of real-world data. Research shows that expert estimation accuracy does NOT improve with experience alone (Cao 2022) — but self-correcting systems like Epoch can buck this trend when fed enough ground truth.

Every contribution helps:
- **10 estimation records** → improves reference class correction factors for that task type
- **50 estimation records** → enables statistically significant accuracy trends
- **5 COCOMO projects** → strengthens the validation dataset
- **Model benchmarks** → keeps pricing and performance data current as providers update models

Our goal: build the most accurate open-source estimation database, powered by the community.

## What Data We Collect

| Type | Description |
|------|-------------|
| **Estimation Records** | Estimated vs actual hours for tasks. This is the most impactful data type. |
| **Model Calibration** | LLM performance benchmarks including tokens/sec, latency, and pricing observations. |
| **COCOMO Projects** | Historical project data: KLOC, effort, team size, and duration. |
| **Sprint Velocity** | Sprint completion data: story points completed, team size, sprint duration. |

## Privacy and Anonymization

**This is non-negotiable.** We will reject any PR that contains personally identifiable information.

**Never include:**
- Real names or email addresses
- Company names
- Project names that reveal clients or business details
- Any data that could identify an individual

**Do include:**
- Anonymized team IDs (e.g., `team-alpha`, `team-bravo`)
- Generic task descriptions (e.g., `REST API endpoint`, `login form refactor`)
- Numeric metrics only

**Additional safeguards:**
- All data is aggregated. Individual records are never exposed in reports.
- Use a `contributor_id` as a pseudonym (e.g., a hash of your GitHub username).
- We will reject any PR that contains PII.

## How to Submit

### 1. Fork the repo

Standard GitHub fork workflow.

### 2. Create a data file

Place your file in `data/community/` using this naming convention:

```
data/community/<your-contributor-id>-<type>.json
```

For example:
- `data/community/jdoe-estimation.json`
- `data/community/teamalpha-cocomo.json`
- `data/community/anondev-velocity.json`

### 3. Structure your file

Each file must include a `_schema` field identifying the data type, a human-readable `description`, and a `records` array.

**Estimation Record example:**

```json
{
  "_schema": "estimation-record",
  "description": "Sprint estimation data from webapp project, Q1 2025",
  "records": [
    {
      "estimated_hours": 16,
      "actual_hours": 24,
      "task_type": "feature",
      "complexity": 3,
      "team_size": 4,
      "model_used": "claude-sonnet-4-20250514",
      "tokens_used": 45000,
      "timestamp": "2025-03-15T10:00:00Z"
    }
  ]
}
```

**Model Calibration example:**

```json
{
  "_schema": "model-calibration",
  "description": "Benchmark runs on GPT-4o and Claude Sonnet, Feb 2025",
  "records": [
    {
      "model": "gpt-4o",
      "tokens_per_second": 85,
      "latency_p50_ms": 320,
      "latency_p95_ms": 1200,
      "input_price_per_1m": 2.50,
      "output_price_per_1m": 10.00,
      "timestamp": "2025-02-10T14:30:00Z"
    }
  ]
}
```

**COCOMO Project example:**

```json
{
  "_schema": "cocomo-project",
  "description": "Backend service projects from 2023-2024",
  "records": [
    {
      "kloc": 12.5,
      "effort_person_months": 18,
      "team_size": 5,
      "duration_months": 6,
      "project_type": "web-backend",
      "timestamp": "2024-06-01T00:00:00Z"
    }
  ]
}
```

**Sprint Velocity example:**

```json
{
  "_schema": "sprint-velocity",
  "description": "Sprint history for mobile app team, H2 2024",
  "records": [
    {
      "sprint_points_planned": 40,
      "sprint_points_completed": 34,
      "team_size": 6,
      "sprint_duration_days": 14,
      "timestamp": "2024-09-15T00:00:00Z"
    }
  ]
}
```

### 4. Validate locally

Run the validation script before opening a PR:

```bash
node scripts/validate-community-data.mjs
```

This checks your file against the schemas in `data/schemas/` and reports any issues.

### 5. Open a Pull Request

Use this title format:

```
data: add <type> from <contributor-id>
```

For example: `data: add estimation records from jdoe`

### 6. CI validation

CI will automatically validate your data against our schemas. If checks pass, a maintainer will review and merge.

## Minimum Requirements

To ensure statistical usefulness, each data type has a minimum record count:

| Data Type | Minimum Records |
|-----------|----------------|
| Estimation records | 10 records |
| Model calibration | 1 complete benchmark |
| COCOMO projects | 5 projects |
| Sprint velocity | 5 sprints |

## Data Impact

Here is how contributed data flows through the system:

1. **Submitted** via Pull Request to `data/community/`
2. **Validated** by CI against schemas in `data/schemas/`
3. **Merged** into the community dataset
4. **Loaded** at runtime by `supplementary-data.ts`
5. **Applied** to improve these tools:
   - `reference_class_estimate` -- better historical analogues
   - `calibrate_estimates` -- tighter team-specific calibration
   - `schedule_risk` -- more accurate risk distributions
   - `cocomo_validate` -- richer validation datasets
   - `token_cost_estimate` -- up-to-date pricing and throughput
   - `compare_models` -- real-world model performance comparisons

## Schema Reference

Each data type has a corresponding schema file in `data/schemas/`:

- `data/schemas/estimation-record.json` -- Estimation records
- `data/schemas/model-calibration.json` -- Model calibration benchmarks
- `data/schemas/cocomo-project.json` -- COCOMO project data
- `data/schemas/sprint-velocity.json` -- Sprint velocity data

Refer to these schemas for the full list of required and optional fields.

## License

By contributing data, you agree that it will be used under the project's MIT license. The data itself is contributed as anonymous, aggregated metrics with no individual attribution.
