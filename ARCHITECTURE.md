# Epoch architecture

## Parts and flow

```text
no args -> stdio MCP adapter --+
CLI subcommand ---------------+-> dispatcher/registry -> schemas + domain algorithms
REST tool route -------------+                     -> ToolResult / transport envelope
                                                   -> local telemetry + estimate/tool-call ledger
record_actual / batch -> matched feedback -> calibration/self-improvement -> user reference DB
explicit telemetry opt-in -> anonymized export/submit -> receiver validation/storage
```

[src/index.ts](src/index.ts) selects HTTP via `EPOCH_TRANSPORT=http`, CLI when arguments are present, or stdio MCP otherwise. It also exports library functions. [MCP entry](src/entries/mcp.ts) registers tools, guards malformed/pre-initialize JSON-RPC and installs signal-time flush handling. [CLI entry](src/entries/cli.ts) formats results and includes management/import/export commands beyond the tool catalog.

[Dispatcher](src/dispatcher/index.ts) invokes registry handlers, records timings/inputs, appends estimation results or non-estimation tool-call records, and notifies self-improvement. A computed estimate whose ledger append fails returns a storage error rather than a phantom feedback reference. Domain modules separate temporal, estimation, analytics, cost/risk and feedback logic; transport success and calibrated real-world accuracy remain different claims.

Local stores normally live under `~/.epoch`, with `EPOCH_DATA_DIR` overrides for most paths. Reference DB loading specifically falls through configured data dir → real HOME user DB → bundled/dev/build paths when a candidate is absent. **Set both an isolated HOME and EPOCH_DATA_DIR for verification**; setting only the latter can still read an existing user's reference data. Updating learned reference data writes user storage rather than the bundled source file.

[HTTP entry](src/entries/http.ts) exposes health, discovery/OpenAPI, tool execution, feedback and telemetry receipt routes. Default binding is `127.0.0.1`; CORS requires configured origins, body size is bounded and rate limiting exists. There is no built-in authentication middleware. A non-loopback bind or proxy deployment therefore needs a separately reviewed access boundary; CORS is not authentication.

## Risky paths and failure signatures

- **Units/calibration:** person-month effort, working hours, wall time and token execution time are not interchangeable. Thin, legacy or biased corpora and dated price/profile data can produce precise-looking but untrustworthy schedules/costs. Preserve assumptions, provenance and exclusions.
- **Persistence/concurrency:** ordinary dispatched calls write files and feedback needs stable references. Disk/permissions failures can make computation fail at persistence; buffered telemetry needs shutdown flush. Migrations/import/self-improve paths may rewrite or archive data: inspect before execution, never run them as harmless docs checks.
- **Exposure/privacy:** task inputs, local Git history, ledgers and exports can be sensitive. Telemetry opt-in/config overrides alter the outbound boundary. Do not infer permission to share from “anonymous” wording or from a health response.
- **Transport drift:** tool registry, schemas, CLI options, REST docs and bundled data can disagree independently. Check actual discovery/results; no-argument invocation starts MCP, not help. Even ordinary CLI startup can persist a first-run nudge unless quiet/otherwise suppressed.
- **False proof:** receiver acceptance is not task validity, an actual-record join is not causal evidence of model productivity, and an interval label is not empirical coverage. Frozen evaluation corpora and public benchmark summaries have distinct inclusion rules.

## Bounded docs verification and rollback

Actual isolated CLI discovery returned 26 tools and PERT help ran; 36 estimation behavior tests passed. HOME/data were isolated and remote telemetry disabled. No build (`clean: true`), migrations, data deletion, import, Git mining, telemetry submission, receiver install or deployment ran. No user-side recording/full integration or estimate-accuracy acceptance is claimed. Docs rollback is reverting the commit; it does not reset an operator's learned history.
