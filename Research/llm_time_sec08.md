# 8. Evaluation, Quality Assurance, and Production Deployment

A time-estimation MCP server that produces inaccurate or insecure results is worse than no server at all. This chapter defines the evaluation framework, security posture, and deployment patterns required to move from prototype to production.

### 8.1 Evaluation Framework

#### 8.1.1 Accuracy Metrics for Duration Prediction and Software Effort Estimation

Evaluating a time-estimation tool requires metrics from two disciplines: statistical forecasting and software engineering.

For point forecasts, the Mean Absolute Error ($\text{MAE}$) is the standard metric for median estimation goals because it is robust to outliers [^3^]. The Mean Absolute Percentage Error ($\text{MAPE}$) is common in practice but becomes numerically unstable when actual durations approach zero [^4^] — a concern where quick fixes coexist with multi-hour refactoring. The Root Mean Squared Error ($\text{RMSE}$) is preferable when large misses must be penalized more heavily, but it is scale-sensitive [^3^].

For software effort estimation, the literature converges on Mean Magnitude of Relative Error ($\text{MMRE}$) and PRED(25), the percentage of estimates within 25% of actual. A systematic review of twenty-eight primary studies establishes MMRE $\leq 0.25$ as the acceptable threshold for production models [^5^]. Ensemble techniques consistently outperform solo techniques by 10–15% on both metrics [^5^], directly supporting the multi-heuristic architecture from preceding chapters. A time-estimation server should report confidence intervals alongside point estimates — a range ("2–4 hours, 80% confidence") is more actionable than a single number.

#### 8.1.2 MCP-Specific Metrics: Task Completion Speed and Tool Reliability

Beyond raw accuracy, the MCP ecosystem has developed operational metrics that capture how effectively an agent uses external tools. The Twilio MCP-TE Benchmark evaluates AI coding agents under a rigorous Control-vs.-Treatment methodology, measuring Duration, API Calls, Interactions, Tokens, Cache activity, Cost, and Success Rate [^1^]. In controlled tests with Claude 3.7 Sonnet, MCP-enabled agents reduced average task duration from 62.54 seconds to 49.68 seconds ($-20.56$%) and API calls from 10.27 to 8.29 ($-19.26$%), while pushing success rate from 92.31% to 100% [^1^]. These figures establish the performance envelope a well-designed server should target.

Production observability frameworks define three metric tiers [^2^]: performance/reliability, resource efficiency, and application-specific quality. Within this taxonomy, four agent-specific metrics are particularly relevant. Task Success Rate (TSR) should reach 85–95% for mature systems [^2^]. Turns-to-Completion (TTC) has an optimal range of 2–5 turns; tasks requiring more than seven turns exhibit 60% higher abandonment rates [^2^]. Tool Hallucination Rate — the frequency of invalid tool invocations — should stay between 2% and 8% [^2^]. Self-Correction Rate, the proportion of failed calls successfully retried, should reach 70–80% [^2^]. A server that produces malformed duration strings will directly degrade these metrics.

#### 8.1.3 Temporal Reasoning Benchmarks: Academic Validation Standards

Academic benchmarks prevent overfitting to internal test suites. TimeBench covers ten tasks across symbolic, commonsense, and event temporal reasoning [^6^]. GPT-4 ranked first in sixteen of nineteen metrics and outperformed GPT-3.5 by 14.7%, yet still exhibits a 19% gap from human performance [^6^]. Even the best model fails on roughly one in five temporal questions that humans handle correctly.

Google's "Test of Time" benchmark isolates memorization from reasoning [^7^]. LLMs show stable performance on duration calculations — suggesting true algorithmic competence — but day-of-week performance drops dramatically for dates beyond 2050, revealing reliance on memorized patterns [^7^]. Duration estimation is reasoning-stable; calendar lookups should be delegated to deterministic tools.

TempoBench evaluates multi-step temporal and causal reasoning with formally verifiable ground truth [^8^]. The KAIST framework achieved a 21.7% improvement in detecting temporal hallucinations [^9^]. Most relevant to deployment, the TicToc benchmark reveals "temporal blindness": without timestamps, models perform near-random (marginally exceeding 55% alignment); with timestamps, the best models peak below 65% [^10^]. Post-training with Direct Preference Optimization shows massive improvement potential, but as of early 2026 no model has crossed the 65% threshold [^10^].

**Table 8.1: Evaluation Metrics Summary for Time-Estimation MCP Servers**

| Metric Category | Metric | Formula / Definition | Target Threshold | Primary Use Case |
|---|---|---|---|---|
| Statistical forecasting | MAE | $\frac{1}{n} \sum |\hat{y}_i - y_i|$ | Minimize; scale-dependent | Median duration estimation [^3^] |
| Statistical forecasting | MAPE | $\frac{100}{n} \sum |\frac{y_i - \hat{y}_i}{y_i}|$ | $< 25\%$ for stable values | Relative error comparison [^4^] |
| Statistical forecasting | RMSE | $\sqrt{\frac{1}{n} \sum (\hat{y}_i - y_i)^2}$ | Minimize; penalizes large misses | Large-miss-sensitive forecasts [^3^] |
| Software effort estimation | MMRE | $\frac{1}{n} \sum |\frac{\hat{y}_i - y_i}{y_i}|$ | $\leq 0.25$ | Effort model acceptability [^5^] |
| Software effort estimation | PRED(25) | % of estimates within 25% of actual | $\geq 60\%$ | Practical usability threshold [^5^] |
| MCP operational | Task Success Rate (TSR) | % of tasks completed successfully | 85–95% | Production north-star metric [^2^] |
| MCP operational | Turns-to-Completion (TTC) | Median tool-call turns per task | 2–5 turns | Interaction efficiency [^2^] |
| MCP operational | Tool Hallucination Rate | % of invalid tool invocations | 2–8% | Tool schema alignment [^2^] |
| MCP operational | Self-Correction Rate | % of failed calls successfully retried | 70–80% | Agent resilience [^2^] |
| Temporal reasoning | TimeBench overall | 19 sub-task accuracy scores | Benchmark vs. GPT-4 baseline | General temporal competence [^6^] |
| Temporal reasoning | TicToc alignment | Normalized temporal alignment rate | $< 65\%$ current ceiling | Temporal blindness detection [^10^] |

Table 8.1 spans three evaluation layers — statistical accuracy, operational efficiency, and reasoning validity — and no single metric is sufficient. A server with low MAE but TTC $= 12$ and TSR $= 60$% is accurate yet unusable. The recommended protocol runs all metrics in CI/CD, fails the build on threshold violations, and tracks week-over-week deltas. The Twilio MCP-TE methodology provides a ready-made harness for operational metrics [^1^], while academic benchmarks can be integrated as nightly regression tests.

### 8.2 Safety and Security Controls

#### 8.2.1 OWASP MCP Top 10: Path Traversal, Injection, and Indirect Prompt Attacks

The MCP ecosystem's rapid growth has outpaced its security maturity. A study of 2,614 implementations found that 82% use file system operations prone to Path Traversal (CWE-22), 67% to Code Injection (CWE-94), and 34% to Command Injection (CWE-78) [^21^]. These are the statistical default, not edge cases. A scan of 8,000+ public servers found 36.7% with SSRF vulnerabilities, 43% with unsafe command execution, and 41% in the official registry with zero authentication [^25^]. Indirect prompt injection further expands the attack surface: malicious instructions embedded in processed content trigger vulnerable tools without user intent [^24^].

OWASP has published an MCP Top 10 (v0.1) organizing these risks: Token Mismanagement; Privilege Escalation; Tool Poisoning; Supply Chain Attacks; Command Injection; Intent Flow Subversion; Insufficient Authentication; Lack of Audit and Telemetry; Shadow MCP Servers; and Context Injection [^23^]. For a time-estimation server, the most relevant categories are Command Injection, Context Injection (if user descriptions are passed unescaped to downstream APIs), and Insufficient Authentication.

Production-grade servers should implement five safety controls from the Harness MCP v2 server [^26^]: confirmation for writes via MCP elicitation, fail-closed deletes, read-only mode for shared environments, secrets safety (metadata only), and rate limiting with backoff. MCP tool annotations shipped in the 2025-03-26 revision provide a "risk vocabulary" (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) [^27^]. The specification treats these as untrusted hints with pessimistic defaults: a tool with no annotations is assumed potentially destructive, non-idempotent, and open-world [^27^]. A time-estimation server should set `readOnlyHint: true`, `destructiveHint: false`, and `idempotentHint: true` to signal safe speculative invocation.

#### 8.2.2 Authentication Patterns: API Keys, OAuth 2.0, and mTLS

Three dominant authentication patterns exist for MCP servers [^39^]. API key authentication via `Authorization: Bearer <token>` is adequate for internal deployments but requires `timingSafeCompare` to prevent timing attacks [^39^]. OAuth 2.0 is required for multi-tenant environments; the MCP specification mandates OAuth 2.1 for Streamable HTTP transports [^23^][^40^]. Mutual TLS (mTLS) is the pattern of choice for zero-trust environments [^39^]. A layered production pattern combines all three: mTLS at transport, OAuth for user-delegated scopes, and API keys for health-check endpoints.

#### 8.2.3 Rate Limiting: Per-Session and Per-Tool Quotas

AI agents generate load patterns fundamentally different from human users. During normal operation, an agent can issue fifty or more rapid sequential tool calls as it explores a solution space [^38^]. A naive per-IP rate limit designed for human consumers will throttle legitimate agent behavior or permit abusive bursts.

Effective rate limiting operates on two dimensions: per-session limits tracking individual conversations, and per-tool limits restricting expensive operations independently [^38^]. The recommended JSON-RPC error response uses code `-32029` with a `retryAfter` field, allowing the agent to implement exponential backoff [^38^]. Token-based quotas that limit actual compute usage (input plus output tokens) are preferable to raw request counts because they align cost with resource consumption [^38^]. For a time-estimation server, per-tool limits should be strictest on external API calls (calendar services, project-management platforms) and most permissive on stateless calculations (duration arithmetic, timezone conversion).

**Table 8.2: Security Controls Checklist for Production MCP Deployment**

| Control Domain | Control | Implementation Pattern | Verification Method | Priority |
|---|---|---|---|---|
| Input validation | Schema enforcement | Pydantic / Zod with `strict_input_validation` [^31^] | Fuzz test with 1,000 malformed inputs | Critical |
| Input validation | Path traversal prevention | Canonicalize paths; reject `../` sequences | Static analysis + penetration test | Critical |
| Input validation | Injection sanitization | Parameterized queries; never shell-join user input | CWE-78/94 scan (target: 0 findings) | Critical |
| Authentication | Internal / dev | API key via `Authorization: Bearer`; `timingSafeCompare` [^39^] | Token replay + brute-force test | High |
| Authentication | Multi-tenant | OAuth 2.1 with PKCE; scope-limited tokens [^40^] | OAuth conformance test suite | High |
| Authentication | Zero-trust | mTLS with certificate rotation [^39^] | Certificate pinning verification | High |
| Authorization | Tiered approval | Auto-approve read-only (1–10 pts); multi-party for >100 pts [^28^] | Role-based access matrix review | High |
| Rate limiting | Per-session | Session-keyed token bucket; 60 req/min baseline [^38^] | Load test with 100 concurrent agents | High |
| Rate limiting | Per-tool | Tool-category quotas; strictest on external API calls [^38^] | Monitor `retryAfter` response rate | High |
| Rate limiting | Token quota | Limit by input + output tokens, not request count [^38^] | Cost-correlation audit | Medium |
| Safety controls | Write confirmation | MCP elicitation for all destructive operations [^26^] | Automated workflow test | Critical |
| Safety controls | Fail-closed defaults | Return safe state on unhandled exceptions [^26^] | Chaos engineering: inject random faults | High |
| Safety controls | Read-only mode | Environment-flagged read-only for shared deployments [^26^] | Functional test: attempt write, verify rejection | High |
| Safety controls | Tool annotations | Set `readOnlyHint`, `destructiveHint`, `idempotentHint` [^27^] | Schema validation on `tools/list` response | Medium |
| Observability | Structured logging | Log to stderr (stdio) or MCP notifications (HTTP); never stdout [^41^] | Log injection test | High |
| Observability | Audit telemetry | Log every tool call with arguments hash, result code, latency [^23^] | 30-day retention compliance check | High |
| Supply chain | Dependency scanning | Scan all SDK dependencies; pin to stable versions [^22^] | Snyk zero-critical policy | High |
| Supply chain | SDK vulnerability | Monitor CVE feeds (e.g., CVE-2025-49596 for Inspector) [^35^] | Automated CVE alerting within 24 h | Critical |

Table 8.2 distills the security analysis into an actionable checklist. Controls marked Critical address risks that are both prevalent — the 82% path-traversal rate and the systemic RCE vulnerability affecting 150 million-plus downloads [^21^][^22^] — and consequential if exploited. Each control is paired with a verification method; security posture is only as good as the tests that validate it.

### 8.3 Production Deployment Patterns

#### 8.3.1 Local Deployment: stdio Transport with Package Managers

Local deployment is the entry point for most MCP servers. The stdio transport runs the server as a child process of the host application, communicating over stdin/stdout with approximately one millisecond of round-trip latency and no authentication overhead [^36^]. In Python, the canonical pattern uses `uv run` to execute the server module directly from its `pyproject.toml` definition [^32^]. In TypeScript, the equivalent uses `npx` to execute a published npm package [^30^]. Docker containerization provides reproducibility: a multi-stage build compiles dependencies in an isolated layer and copies only the runtime artifact into a slim final image. The stdio transport has a critical constraint: the server must never write non-JSON-RPC data to stdout, because extraneous output corrupts the protocol stream [^41^]. All logging must go to stderr or to MCP's structured logging notifications.

#### 8.3.2 Remote Deployment: Streamable HTTP with Load Balancing

Remote deployment uses the Streamable HTTP transport, which replaced the deprecated SSE transport in March 2025 [^36^]. Streamable HTTP uses a single endpoint with POST requests and optional SSE streaming [^36^]. Latency ranges from 10–100 milliseconds, and the transport natively supports OAuth 2.1 [^36^].

For production at scale, the MCP specification recommends stateless mode for horizontal scaling [^23^]. Stateless mode sacrifices server-initiated capabilities — sampling, progress notifications, and subscriptions — in exchange for perfect load-balancer compatibility [^23^]. For a time-estimation server that primarily answers synchronous queries, this tradeoff is favorable. If asynchronous features are required, a hybrid architecture routes stateful sessions to pinned backends via session affinity.

Health-check endpoints should verify both the transport layer (TCP connectivity) and the application layer (a lightweight `tools/list` call confirming schema enumeration). The `mcp-proxy` utility bridges stdio servers to HTTP without code modification [^37^].

#### 8.3.3 Monitoring and Observability: Structured Logging and Telemetry

Observability must satisfy two audiences: the AI client, which needs concise results, and the human operator, which needs diagnostic detail. In stdio mode, all diagnostic output goes to stderr; in HTTP mode, the server emits JSON-RPC notifications for logging events [^41^]. The cardinal rule is that stdout is reserved exclusively for the JSON-RPC protocol stream [^41^]. Violating this rule produces cryptic errors because the client rejects malformed frames before they reach application-level handlers.

Tool-call duration tracking is essential for two reasons. First, the server must factor its own latency into estimates: if `estimate_task_duration` takes 400 milliseconds, that overhead should be reflected in downstream estimates. Second, duration telemetry reveals regressions. The recommended telemetry schema records: tool name, arguments hash (for privacy), timestamps, result code, and cache hit/miss status.

Estimation accuracy telemetry closes the feedback loop between prediction and reality. When a coding agent receives "3 hours, confidence 75%", the telemetry system should later record the actual wall-clock duration. This actual-vs.-estimated delta feeds the MMRE and PRED(25) metrics in Table 8.1 and provides the training signal for reference-class forecasting models. Without this closed loop, the server cannot learn from its mistakes, and the compound fracture of architectural limitation, bias replication, and methodology breakdown identified in Chapter 1 will persist indefinitely.
