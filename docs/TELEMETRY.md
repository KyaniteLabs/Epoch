# Telemetry Documentation

**Last updated:** May 5, 2026

## Purpose

Epoch telemetry collects anonymized estimate/actual pairs to improve estimation accuracy for all users. When enough data flows through the system, the self-improvement engine can produce better correction factors, tighter confidence intervals, and more accurate reference class baselines.

Telemetry is **OFF by default** and requires explicit opt-in via `epoch telemetry enable`.

## Data Schema

### AnonymizedRecord

Each individual record in a telemetry submission contains only these fields:

```json
{
  "task_type": "feature",
  "complexity": 3,
  "tool": "pert_estimate",
  "estimated_hours": 8.5,
  "actual_hours": 12.0,
  "ratio": 1.41,
  "date": "2026-05-01"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task_type` | `string` | yes | Category of work: `feature`, `bugfix`, `refactor`, `migration`, `infrastructure`, `documentation`, `testing`, `design` |
| `complexity` | `number \| null` | yes | Complexity rating (1-5). Null if not provided. |
| `tool` | `string` | yes | Epoch tool name that generated the estimate |
| `estimated_hours` | `number` | yes | Original estimated hours |
| `actual_hours` | `number` | yes | Actual hours recorded via `record_actual` |
| `ratio` | `number` | yes | `actual_hours / estimated_hours` -- the estimation accuracy ratio |
| `date` | `string` | yes | Date in `YYYY-MM-DD` format only. Time-of-day is stripped. |

### SubmissionPayload

The full payload sent to the telemetry endpoint. Epoch emits `schema_version: 2`; receivers also accept `schema_version: 1` (payloads without the four agent-qualification fields below) for backward compatibility:

```json
{
  "schema_version": 2,
  "installation_id": "550e8400-e29b-41d4-a716-446655440000",
  "epoch_version": "0.3.1",
  "records": [
    { "task_type": "feature", "complexity": 3, "tool": "pert_estimate", "estimated_hours": 8.5, "actual_hours": 12.0, "ratio": 1.41, "date": "2026-05-01" }
  ],
  "generated_at": "2026-05-01T12:00:00Z",
  "client_name": "claude-code",
  "client_version": "1.2.3",
  "transport": "stdio",
  "runtime_hint": "mcp"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `number` | Schema version for forward compatibility. Epoch emits `2`; `1` (no agent-qualification fields) still accepted by receivers. |
| `installation_id` | `string` | Random UUID for deduplication. Cannot identify a person. |
| `epoch_version` | `string` | Semantic version of the Epoch instance. |
| `records` | `AnonymizedRecord[]` | Array of anonymized estimate/actual pairs. |
| `generated_at` | `string` | ISO-8601 timestamp of when the payload was generated. |
| `client_name` | `string \| null` | (v2) MCP client name from `clientInfo`, e.g. `"claude-code"`. `null` for CLI/HTTP callers or clients that don't report `clientInfo`. |
| `client_version` | `string \| null` | (v2) MCP client version from `clientInfo`. `null` when unavailable. |
| `transport` | `string \| null` | (v2) `"stdio"`, `"http"`, or `null`. Identifies which Epoch surface generated the batch. |
| `runtime_hint` | `string` | (v2) Coarse classification of the calling runtime (e.g. `"mcp"`, `"cli"`) derived from the above, not free text. |

**Agent qualification, not agent identification:** the v2 fields exist so agent-driven usage is counted as first-class in aggregate accuracy statistics (an MCP client that reports its `clientInfo` is not lumped in with anonymous CLI usage) — they do not add any new per-user identifying signal beyond what `installation_id` already carries.

## What Is Stripped

The following fields from your local data are **never** included in telemetry:

| Stripped field | Reason |
|----------------|--------|
| `estimateId` | Could correlate records across submissions |
| `source` | May contain project names |
| `notes` | Free-text, may contain sensitive information |
| `teamId` | Could identify teams or organizations |
| All free-text fields | Risk of containing sensitive information |
| Time-of-day from timestamps | Reduces identifiability; only YYYY-MM-DD is kept |

## How It Works

The telemetry pipeline runs entirely locally until you explicitly enable transmission:

```
Local JSONL files (estimates.jsonl + feedback.jsonl)
  |
  v
Extract matched estimate/actual pairs
  |
  v
Anonymize (strip identifying fields, truncate dates to YYYY-MM-DD)
  |
  v
Batch into SubmissionPayload (max 100 records)
  |
  v
Sign with HMAC-SHA256 (keyed by installation_id)
  |
  v
POST to configurable endpoint via HTTPS
```

### HMAC-SHA256 Signing

Every telemetry submission includes an `X-Epoch-Signature` header containing an HMAC-SHA256 signature of the JSON payload, keyed by the `installation_id`. This:

- Proves the data came from a real Epoch instance
- Prevents tampering during transmission
- Does **not** reveal any identity information (the `installation_id` is a random UUID)

The server can verify the signature using the `installation_id` from the payload.

## CLI Commands

### `epoch telemetry enable`

Opts in to telemetry with informed consent. The command:

1. Displays exactly what data will be shared
2. Shows a sample of the anonymized data
3. Asks for explicit confirmation
4. Optionally saves the receiver URL from `--endpoint`
5. Saves the opt-in setting to `~/.epoch/config.json`

Use `--endpoint <url>` when you already know the receiver:

```bash
epoch telemetry enable --endpoint https://your-server.example.com/v1/telemetry
```

### `epoch telemetry disable`

Opts out of telemetry. Stops all data transmission. Previously sent data is not affected (see deletion below).

Can also be triggered via environment variable: `EPOCH_TELEMETRY=0`

### `epoch telemetry preview`

Shows exactly what anonymized data would be sent if telemetry were enabled. This command does **not** transmit any data. Use it to verify what will be shared before opting in.

### `epoch telemetry status`

Displays current telemetry configuration:

- Whether telemetry is enabled or disabled
- Endpoint URL
- Whether the endpoint is usable or still unset/placeholder
- Number of records queued for next submission
- Timestamp of last successful submission
- Installation ID

### `epoch telemetry set-endpoint`

Configures the telemetry receiver without changing the opt-in setting:

```bash
epoch telemetry set-endpoint --endpoint https://your-server.example.com/v1/telemetry
```

Endpoints must use HTTPS, except localhost receivers used for local development.

### `epoch telemetry submit`

Submits the queued anonymized records to the configured endpoint:

```bash
epoch telemetry submit
```

You can also set the endpoint immediately before submitting:

```bash
epoch telemetry submit --endpoint https://your-server.example.com/v1/telemetry
```

Successful submissions update `lastSubmissionAt` and `totalRecordsSubmitted` in `epoch telemetry status`. Failed submissions leave records queued locally.

### `epoch telemetry export`

Writes all anonymized data to a JSON file on disk. The output file contains the same `SubmissionPayload` format that would be sent to the endpoint. This is useful for:

- Reviewing your data
- Contributing to the community dataset via PR
- Keeping a personal backup

### `epoch telemetry delete-data`

Provides instructions for deleting your data:

1. Local data: `rm -rf ~/.epoch/` removes all local files
2. Server-side data: Contact via GitHub Issues (see [PRIVACY.md](./PRIVACY.md))

### `epoch share-data`

Exports anonymized data formatted for community contribution to the Epoch GitHub repository.

```bash
epoch share-data --description "Anonymized Epoch usage export" --validate
```

The export produces a file with this structure:

```json
{
  "_schema": "estimation-record",
  "description": "...",
  "records": [
    {
      "estimated_hours": 8,
      "actual_hours": 12,
      "task_type": "feature",
      "complexity": 3,
      "timestamp": "2026-05-24T00:00:00Z"
    }
  ]
}
```

**What is included:** task type, complexity (1-5), estimated hours, actual hours, date-only timestamp.

**What is NOT included:** No notes, source names, team IDs, project names, estimate IDs, tool names, ratios, or time-of-day.

Use `--validate` to verify the export against the community data schema before submitting.

See [CONTRIBUTING-data.md](../CONTRIBUTING-data.md) for the community contribution workflow.

### `epoch data where`

Shows local Epoch data file locations. Read-only, no network calls, no telemetry submission.

### `epoch data status`

Shows local Epoch data status: file counts, feedback match rate, telemetry configuration, reference database health, and role hints.

## Rate Limits

Telemetry submissions are rate-limited to prevent accidental data flooding:

| Limit | Value |
|-------|-------|
| Max submissions per hour | 1 |
| Max records per submission | 100 |
| Max payload size | 1 MB |

If a submission fails, it is not retried automatically. Records remain in the local queue for the next scheduled submission.

## Server-Side Promises

When using the default Kyanite Labs endpoint, the following guarantees apply:

| Promise | Implementation |
|---------|---------------|
| No IP logging | Server does not record client IP addresses |
| No cross-correlation | Telemetry data is never joined with other data sources |
| Aggregation after 90 days | Raw records are aggregated into statistical summaries after 90 days |
| Self-hostable | The endpoint is a simple HTTP API; you can run your own |

## Self-Hosting

You can run your own telemetry endpoint to keep all data within your infrastructure. The API contract is minimal:

### Endpoint Contract

```
POST /v1/telemetry
Content-Type: application/json
X-Epoch-Signature: <HMAC-SHA256 of body, keyed by installation_id>
X-Epoch-Version: <epoch_version from payload>
```

**Request body:** `SubmissionPayload` (see schema above)

**Expected responses:**

| Status | Meaning |
|--------|---------|
| `200 OK` | Accepted. Body: `{ "accepted": <record_count>, "deduplicated": <count> }` |
| `400 Bad Request` | Invalid payload or schema version mismatch |
| `429 Too Many Requests` | Rate limit exceeded. Body: `{ "retry_after_seconds": <seconds> }` |

Epoch's built-in HTTP server includes a local receiver for this contract:

```bash
EPOCH_TRANSPORT=http EPOCH_PORT=3099 node dist/index.js
epoch telemetry set-endpoint --endpoint http://localhost:3099/v1/telemetry
epoch telemetry submit
```

The built-in receiver verifies the signature and writes three local files:

- `~/.epoch/telemetry-records.jsonl` — shared anonymized records plus `received_at`
- `~/.epoch/telemetry-record-keys.jsonl` — receiver-local SHA-256 dedupe keys
- `~/.epoch/telemetry-receipts.jsonl` — aggregate receipts with accepted/deduplicated counts

The shared records file contains only anonymized telemetry fields: `task_type`, `complexity`, `tool`, `estimated_hours`, `actual_hours`, `ratio`, `date`, and `received_at`. It does not store installation IDs, notes, project names, source text, team IDs, or dedupe keys.

**Verification steps (server-side):**

1. Parse the JSON body
2. Compute HMAC-SHA256 of the raw body using `installation_id` from the payload as the key
3. Compare with `X-Epoch-Signature` header (constant-time comparison)
4. Validate `schema_version` is supported
5. Deduplicate records by a receiver-local hash of `(installation_id, record)`
6. Store anonymized records and aggregate receipts

### Configuring a custom endpoint

```bash
# Set via CLI while enabling telemetry
epoch telemetry enable --endpoint https://your-server.example.com/v1/telemetry

# Or set/update independently
epoch telemetry set-endpoint --endpoint https://your-server.example.com/v1/telemetry

# Or set in config.json directly
# ~/.epoch/config.json:
# { "telemetry": { "enabled": true, "endpoint": "https://your-server.example.com/v1/telemetry" } }
```

## Environment Variables

| Variable | Values | Description |
|----------|--------|-------------|
| `EPOCH_TELEMETRY` | `0` or `1` | Overrides config file. `0` disables telemetry, `1` enables it (requires prior consent). |
| `EPOCH_TELEMETRY_ENDPOINT` | URL | Overrides the configured telemetry receiver endpoint for status/submission. |

The environment variable takes precedence over the config file setting.

## Privacy

For full privacy details, see [PRIVACY.md](./PRIVACY.md).
