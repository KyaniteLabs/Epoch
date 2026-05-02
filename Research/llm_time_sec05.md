# 5. Architecture: Designing a Time Estimation MCP Server

The preceding chapters established why LLM coding agents fail at time estimation: the problem is a compound fracture of architectural limitations, replicated human cognitive biases, and domain-specific estimation breakdowns. The evidence also pointed to a clear gap—no existing MCP server or tool combines clock time, calendar mathematics, software estimation algorithms, and historical data integration into a single system. This chapter translates those research findings into an architectural blueprint. The goal is not to make LLMs "better at time" through training or prompting tricks, but to build an external estimation infrastructure that makes time *legible* to LLMs through structured, requestable representations.

## 5.1 Design Philosophy and Core Principles

Any architecture for a time estimation MCP server must be grounded in the empirical findings from the research phase. Four principles emerged as non-negotiable constraints on the design.

### 5.1.1 Make Time Legible to LLMs, Not Make LLMs Better at Time

The most important design decision is a reframing of the problem itself. Research Insight 5 established that the fix is not improving the LLM's internal temporal reasoning, but making time information externally legible in formats the LLM can already process [^5^]. This distinction is subtle but architecturally decisive.

LLMs excel at discrete, token-aligned temporal tasks—before/after relations, event ordering, turn-based negotiation—because these map to sequence-ordering problems that self-attention handles well [^1^]. They fail catastrophically at continuous, wall-clock temporal tasks—elapsed time tracking, duration estimation, real-time deadline management—because continuous time tracking requires accumulation and counting, operations that self-attention is theoretically incapable of performing [^1^]. Any attempt to "train" an LLM to track elapsed time architecturally runs into this theoretical ceiling.

The Toolformer paper from Meta AI (NeurIPS 2023) provided the foundational evidence for this approach: LLMs can teach themselves to use external tools via simple APIs, achieving substantially improved zero-shot performance without sacrificing core language modeling abilities [^286^]. The calendar tool in Toolformer specifically addressed "unawareness of the progression of time," which the authors listed as one of several inherent limitations of language models that could not be resolved through scale alone [^296^].

The architectural implication is direct: the MCP server should not attempt to teach the LLM temporal reasoning. Instead, it should expose time as structured data that the LLM can *request* but never needs to *calculate*. When an agent needs to know "how many business days until the sprint deadline," it calls a tool. The server performs the calculation using `workalendar` for holiday-aware arithmetic, `pendulum` for timezone-safe date math, and returns a structured result. The LLM reads the answer; it does not compute it. This pattern—external delegation of continuous-time operations—mirrors how we give humans calculators: the cognitive work is offloaded, not taught.

### 5.1.2 Categorical Outputs Alongside Numeric

Research Insight 4 revealed a counterintuitive but robust finding: qualitative urgency cues outperform explicit numeric countdowns for improving LLM behavior under time pressure [^4^]. In the UPenn negotiation study, the condition with qualitative urgency reminders ("Deadline approaching—act with urgency") achieved higher deal-closure rates than the condition with explicit numeric countdowns ("137 seconds left") [^4^]. The researchers concluded that "the bottleneck is not simply accessing a countdown value, but mapping time pressure into an appropriate strategic policy" [^4^].

This finding has direct architectural consequences. Every time estimation tool in the server should return *both* a precise numeric estimate and a categorical classification. For task duration, the categorical output might be `"urgency": "short"` (under 2 hours), `"medium"` (2 hours to 2 days), or `"long"` (over 2 days). For schedule risk, the output might include `"confidence": "likely"` (P50), `"optimistic"` (P20), or `"pessimistic"` (P80). The numeric value serves human review and downstream calculation; the categorical value serves the LLM's policy adaptation.

This dual-output pattern also aligns with how human time perception operates. Humans do not experience "47 minutes remaining" as a continuous numeric value; they experience "getting close" or "plenty of time" [^4^]. By providing categorical classifications, the MCP server bridges between the precision required for project management and the qualitative signals that LLMs can actually act upon.

### 5.1.3 Bridge Token-Space and Time-Space

Research Insight 8 identified that LLM agents currently use token budgets (200K–500K tokens per session) as a proxy for time budgets, but this mapping is broken [^8^]. Tokens do not linearly correlate with wall-clock time due to three confounding factors: reasoning-time variation (a single reasoning step may consume thousands of tokens in seconds or minutes, depending on model and complexity), tool-call latency (each external API call adds round-trip time independent of token count), and API speed variation (different providers and rate limits produce different tokens-per-second throughput).

The architectural response is an explicit token-to-time mapping layer inside the MCP server. This is not a single conversion factor but a parametric model:

$$
\text{Estimated Wall-Clock Time} = \frac{\text{Tokens}}{\text{Tokens/Second}} + (\text{Tool Calls} \times \text{Average Latency}) + \text{Reasoning Overhead}
$$

Where *Reasoning Overhead* is a model-specific constant derived from empirical measurement (e.g., Claude 4 Sonnet ≈ 2.3 seconds per 1K reasoning tokens under typical load), and *Average Latency* is measured per-tool from the server's own request logs. The server maintains a calibration table that the LLM can query: `get_token_time_mapping(model="claude-sonnet-4", tool_calls=5, reasoning_tokens=8000)` returns a distribution estimate rather than a point value.

This bridge is essential because agents currently say "I'll complete this in a few steps" when they mean "this will fit within my token budget" [^8^]. Without an explicit translation layer, every agent estimate is implicitly a token estimate masquerading as a time estimate—and it will be wrong.

### 5.1.4 Reference Class Forecasting Over Algorithmic Models

Research Insight 6 established that historical actual-vs-estimated data from project management systems is more valuable than algorithmic models for LLM-assisted development [^6^]. The reasoning is straightforward: algorithmic models like COCOMO II and PERT assume predictable task structures and human labor rates, but LLM-assisted development is highly variable. METR's "messiness" factors (complexity, ambiguity, novelty, dependency count, tool unfamiliarity) each degrade performance by approximately 8% per point on a 16-point scale [^6^]. No algorithmic model captures these idiosyncratic, team-specific factors.

Kahneman's reference class forecasting—estimating from the outside by examining how similar tasks actually unfolded—outperforms inside-view estimation for humans, and the same logic applies to LLM agents [^589^]. If the last twelve "refactor authentication" tasks in Jira averaged 2.3× their initial estimates, the server should apply a 2.3× correction factor to the next such estimate, transparently reporting the adjustment.

The architectural implication is that Layer 4 (Data Integration) and Layer 5 (Advanced Analytics) must be treated as *primary* estimation sources, while Layer 3 (Software Estimation Algorithms) serves as a fallback when historical data is sparse. This inverts the traditional hierarchy where algorithmic models are primary and historical data is supplementary.

**Table 1: Core Design Principles for the Time Estimation MCP Server**

| Principle | Research Basis | Architectural Manifestation |
|-----------|---------------|----------------------------|
| Make time legible, not LLMs better at time | LLMs lack continuous-time module architecturally [^1^]; Toolformer proved tool delegation works [^286^] | Structured external representations; LLM requests calculations, never performs them |
| Categorical outputs alongside numeric | Urgency cues outperform numeric countdowns by mapping to policy, not arithmetic [^4^] | Every tool returns `"urgency"` and `"confidence"` classifications alongside precise values |
| Bridge token-space and time-space | Token budgets act as broken implicit time budgets [^8^] | Explicit parametric model with model-specific calibration tables |
| Reference class forecasting over algorithms | Historical actual-vs-estimated data captures team-specific messiness factors [^6^] [^589^] | PM system integration (Jira, Toggl) as primary source; algorithmic models as fallback |

These four principles constrain every subsequent architectural decision. A server that violates any of them—by asking the LLM to compute durations, by returning only numeric outputs, by ignoring token-to-time translation, or by privileging COCOMO over Jira actuals—will reproduce the same estimation failures that motivated this work.

## 5.2 Five-Layer Server Architecture

The architecture organizes functionality into five ascending layers, each building on the layers below. Layer 1 handles what existing time MCP servers already do; Layers 2–5 address the gaps identified in the research. The full architecture is shown in Figure 1.

**Figure 1. Five-Layer Time Estimation MCP Server Architecture.** The diagram shows five functional layers (Core Temporal Primitives through Advanced Analytics) above an MCP Protocol Integration Layer that exposes the functionality to LLM clients via registry-based tool dispatch. Three design principles—making time legible to LLMs, bridging token-space to time-space, and providing categorical outputs alongside numeric—are annotated at the top. Transport options (stdio for local development, Streamable HTTP for production) are shown on the right.

### 5.2.1 Layer 1 — Core Temporal Primitives

Layer 1 provides the foundation that existing MCP time servers (passage-of-time-mcp, mcp-time) already demonstrate is necessary [^481^] [^478^]. These are the operations that LLMs demonstrably cannot perform reliably: current time retrieval, timezone conversion, timestamp parsing, duration calculation, and elapsed-time tracking.

The implementation strategy is straightforward but must be rigorous. All timestamps are stored and transmitted in UTC (ISO 8601 format), with timezone identifiers using IANA names (`America/New_York`, not `EST`) to handle Daylight Saving Time transitions correctly [^508^]. Duration parsing must handle both precise formats (`P3DT12H30M` per ISO 8601) and natural language (`"3 business days from now"`, `"end of Q3"`) through the `dateparser` library [^512^]. Human-readable formatting—`diff_for_humans()` in Pendulum terminology—should be included alongside raw timestamps because LLMs process relative descriptions ("2 hours ago") more reliably than absolute timestamps [^508^].

A subtle but critical requirement is elapsed-time tracking across conversation turns. The passage-of-time-mcp server demonstrated that temporal awareness enables conversation pattern analysis—spotting pauses, reasoning about rhythms, labeling a chat's "three-act structure" [^477^]. For estimation purposes, the server must track how much wall-clock time has elapsed since the *start* of the current task or estimation session, because agents routinely lose track of time between messages [^1^].

### 5.2.2 Layer 2 — Calendar Math

Layer 2 is where this server diverges from all existing time MCP servers. None of the current open-source implementations support business-day calculations, holiday awareness, or working-hours constraints [^478^] [^481^]. Yet these are precisely the calculations that software estimation requires: "5 business days from today" is not the same as "5 days from today," and the difference can be 2–4 calendar days depending on weekends, holidays, and the country's calendar.

The `workalendar` library provides holiday-aware business-day calculations for 80+ countries, including variable holidays (Easter, Thanksgiving) and different workweeks (Israel Sunday–Thursday, UAE Monday–Friday) [^600^]. The server exposes this through tools like `business_days_between(start_date, end_date, country_code)` and `add_business_days(start_date, days, country_code)`.

Working-hours constraints are equally important for realistic scheduling. A task estimated at "8 hours" does not complete in one calendar day if the team's working day is 6 hours. The server must support configurable working hours per team or project, and schedule constraint checking (`is_within_working_hours(timestamp, team_config)`).

Recurring pattern detection completes Layer 2. Stand-ups, sprint planning, deployment windows, and maintenance periods all recur on predictable patterns that affect scheduling. The server should detect and expose these patterns from calendar API data, enabling estimates like "the earliest possible completion is the Tuesday after the next deployment freeze."

### 5.2.3 Layer 3 — Software Estimation Algorithms

Layer 3 provides the classic software estimation algorithms, but with two important adaptations for the LLM-assisted context. First, the parameters must be adjusted to account for LLM-specific cost drivers: reasoning complexity, context completeness, transformation impact, iterative cycles, and human oversight [^HC-4^]. Second, every algorithm must return probabilistic outputs (ranges and confidence intervals) rather than point estimates, because the research showed that single-number estimates are systematically wrong [^589^].

**PERT three-point estimation** uses the Beta distribution formula $E = (O + 4M + P) / 6$ with variance $\sigma^2 = ((P - O) / 6)^2$, where $O$ = optimistic, $M$ = most likely, and $P$ = pessimistic [^459^]. For LLM-assisted tasks, the pessimistic estimate should explicitly account for iteration cycles—if the first attempt fails 35% of the time (per METR empirical data [^6^]), the PERT parameters should reflect expected rework.

**COCOMO II** provides parametric effort estimation at the project level [^457^]. The LLM-adapted version replaces the 17 human-labor cost drivers with LLM-specific factors: prompt engineering complexity, context window requirements, reasoning depth (chain-of-thought steps), tool integration count, and human review checkpoints. The scale factors (novelty, flexibility, risk resolution, team cohesion, process maturity) remain relevant but must be reinterpreted for human+LLM hybrid teams.

**Story Point velocity tracking** requires a local database of sprint data. The server computes velocity as the rolling average of story points completed per sprint, with conversion to hours via the team-specific factor $\text{Total Sprint Hours} \div \text{Average Velocity}$ [^543^]. This conversion factor must be recalibrated every 3–4 sprints [^543^], and the server automates this recalculation.

**Critical Path Method (CPM)** computes Early Start, Early Finish, Late Start, Late Finish, and Slack for each task in a dependency graph [^492^]. The LLM-adapted version adds a "merge bias" adjustment: the more predecessors a task has, the less probable it is to start on time, a phenomenon that traditional CPM ignores but Monte Carlo simulation captures [^537^].

**Function Point Analysis** quantifies software size from requirements [^520^]. The challenge here is standard fragmentation: IFPUG, COSMIC, FiSMA, NESMA, and Mark II are all ISO standards but "generally not comparable" [^564^]. The server should default to COSMIC for new projects (better suited to modern software architectures) while supporting IFPUG for legacy compatibility.

### 5.2.4 Layer 4 — Data Integration

Layer 4 is the most important differentiator of this architecture. No existing MCP server connects to project management systems to pull actual-vs-estimated time data [^478^] [^481^]. Without this layer, the server is a calculator with no memory—it cannot learn from past estimation errors.

The integration targets are:

- **Jira REST API**: worklogs (`GET /rest/api/2/issue/{key}/worklog`), estimated time fields, and JQL search for historical issues by type and complexity [^517^].
- **Asana API**: native Estimated Time and Actual Time custom fields, with subtask rollups [^480^].
- **Toggl Track / Clockify / Harvest APIs**: time entry data with project and task categorization [^540^] [^483^].
- **Git commit history**: `git log` analysis to infer actual development time from commit timestamps and file change patterns.
- **Calendar APIs**: Google Calendar, Outlook, CalDAV for blocked-time analysis and meeting overhead calculation.

The reference class forecasting database is built from this data. For each task category (e.g., "API endpoint implementation," "database migration," "frontend component"), the server maintains a distribution of actual-vs-estimated ratios. When a new estimate is requested, the server queries this distribution and applies the historical correction factor. If "API endpoint implementation" tasks have historically taken 1.8× their estimate, the server returns both the raw algorithmic estimate and the corrected estimate, with transparency about the adjustment.

### 5.2.5 Layer 5 — Advanced Analytics

Layer 5 provides the probabilistic and self-correcting capabilities that turn estimation from guesswork into forecast engineering.

**Monte Carlo simulation** generates range estimates by running thousands of schedule simulations with randomized task durations drawn from the historical distributions in Layer 4 [^532^]. The output is not "the project completes on March 15" but "P50 completion is March 15, P80 completion is March 22"—a statement the LLM can use to communicate realistic expectations.

**Planning fallacy correction factors** are computed per-team by comparing estimated vs. actual times across the historical database [^589^]. If a team's estimates are consistently 1.5× too low, the server applies a 1.5× multiplier and records the adjustment in the output metadata. The correction factor is recomputed monthly and trends are reported so teams can observe whether their estimation accuracy is improving.

**Team-specific velocity calibration** goes beyond simple story-point conversion. It accounts for team composition changes (new hire → velocity dip for 2 sprints), technical debt accumulation (velocity decay over quarters), and seasonal variation (holiday periods, conference seasons).

**Estimation accuracy tracking** closes the feedback loop. Every estimate produced by the server is logged with its inputs, assumptions, and confidence level. When actual completion data arrives from Layer 4 integrations, the server computes accuracy metrics (MAPE, bias, variance) and exposes them through resources that the LLM can query to improve future estimates.

**Table 2: Five-Layer Architecture Summary**

| Layer | Domain | Key Capabilities | Existing Coverage | Gap Status |
|-------|--------|-----------------|-------------------|------------|
| 1 — Core Temporal | Clock time, timezone, duration | Current time, timezone conversion, timestamp parsing, duration arithmetic, elapsed-time tracking | passage-of-time-mcp, mcp-time provide partial coverage [^478^] [^481^] | Narrow—no elapsed-time across turns |
| 2 — Calendar Math | Business days, holidays, working hours | Business-day calculation (80+ countries), holiday awareness, working-hours constraints, recurring pattern detection, DST handling | **None**—no existing MCP server covers this [^478^] [^481^] | Major gap |
| 3 — Software Estimation | PERT, COCOMO, Story Points, CPM, Function Points | Three-point estimation with Beta distribution, LLM-adapted parametric models, velocity tracking, critical path analysis, functional sizing | **None**—no existing MCP server covers this [^478^] [^481^] | Major gap |
| 4 — Data Integration | Jira, Asana, Toggl, Git, Calendar APIs | Worklog retrieval, actual-vs-estimated comparison, reference class database construction, commit history analysis | Harvest MCP Server covers one vendor [^474^] | Major gap |
| 5 — Advanced Analytics | Monte Carlo, confidence intervals, correction factors | Probabilistic schedule simulation, P50/P80 forecasts, planning fallacy correction, team velocity calibration, accuracy tracking | **None** | Major gap |

The table makes the gap explicit: existing time MCP servers cover approximately 15–20% of the required functionality. The remaining 80% is unimplemented territory, which explains why coding agents still give wrong time estimates—they simply have no tool that combines all five layers.

## 5.3 MCP Protocol Integration

The five functional layers must be exposed to LLM clients through the Model Context Protocol (MCP), which has become the de facto standard for connecting AI agents to external systems with 97 million monthly SDK downloads and 10,000+ active public servers [^396^]. MCP's core value proposition is model-agnostic portability: build the server once, and it works with Claude, GPT, Gemini, DeepSeek, or any MCP-compatible host [^320^].

MCP defines three server-side primitives [^311^]: **Tools** (executable functions with JSON Schema inputs, analogous to POST endpoints), **Resources** (read-only data access via URIs, analogous to GET endpoints), and **Prompts** (reusable parameterized templates that are user-controlled and never auto-triggered [^332^]). The 2025-11-25 specification added an experimental **Tasks** primitive for long-running asynchronous operations [^311^]. This section covers how each primitive is applied in the time estimation server.

### 5.3.1 Tool Design for Context Efficiency: Registry-Based Dispatch

The most critical architectural decision in MCP tool design is how many tools to expose. Anthropic's own engineering research confirms that tool definitions overload context windows, and intermediate tool results consume additional tokens—the two primary patterns that increase agent cost and latency at scale [^321^]. GitHub's official MCP server consumes 17,600 tokens of tool definitions per request [^319^]. Connecting multiple servers can reach 30,000+ tokens of metadata before the agent does any work [^319^].

The Harness MCP server v2 demonstrated the solution: a registry-based dispatch model that reduced tools from 130+ to 11, cutting tool-definition context cost from approximately 26% to approximately 1.6% of a 200K-token window [^19^]. The pattern is not "fewer features" but "different architecture": the LLM reasons about *what* to do ("estimate this project's duration"), and the server handles *how* to do it via a registry that maps operation types to the appropriate layer and algorithm.

For the time estimation server, the 11 consolidated tools are:

1. `temporal_status()` — Layer 1: current time, elapsed session time, timezone context
2. `time_math(operation, operands)` — Layer 1–2: duration arithmetic, business-day math, timezone conversion via registry dispatch
3. `pert_estimate(tasks[])` — Layer 3: three-point estimation with Beta distribution
4. `cocomo_estimate(params)` — Layer 3: parametric effort estimation with LLM-adapted cost drivers
5. `sprint_forecast(backlog, velocity_history)` — Layer 3: story-point-based completion forecasting
6. `critical_path(tasks[])` — Layer 3: CPM with merge-bias adjustment
7. `fetch_historical_data(source, filters)` — Layer 4: unified PM system query (Jira, Asana, Toggl, etc.)
8. `reference_class_estimate(task_type, complexity)` — Layer 4–5: data-driven estimate with correction factor
9. `monte_carlo_simulation(tasks[], iterations)` — Layer 5: probabilistic schedule risk analysis
10. `calibrate_estimates(team_id, period)` — Layer 5: velocity and correction factor recalculation
11. `token_time_bridge(tokens, model, tool_calls)` — Layer 1–5: explicit token-to-wall-clock mapping

The `time_math` tool exemplifies registry dispatch. Instead of exposing separate tools for `add_days`, `add_business_days`, `convert_timezone`, `parse_natural_language`, and `format_duration`, there is one tool with an `operation` parameter that the registry routes to the correct Layer 1 or Layer 2 function. The LLM provides the semantic intent; the server resolves the implementation.

### 5.3.2 Tool Schemas and Descriptions

MCP tool descriptions are "smelly"—purely natural-language-based alignment can lead to inefficiency, and augmented descriptions with structured metadata improve agent efficiency [^539^]. For this server, every tool schema must satisfy three constraints: minimal token footprint (under 500 tokens per tool definition), Pydantic/Zod validation with `.describe()` on every parameter, and explicit `readOnlyHint` annotations where applicable.

The 500-token target is aggressive but achievable. The Harness v2 server proved that 11 tools can fit in ~1.6% of a 200K context window, which implies approximately 290 tokens per tool on average [^19^]. Atlassian's `mcp-compressor` proxy demonstrates that high compression (tool names + parameter names only) achieves 88% reduction to ~2,200 tokens for a large server, while maximum compression (single `list_tools()` function) reaches 97% reduction to ~500 tokens [^319^]. The registry-based approach sits in the middle: enough description for the LLM to select correctly, not so much that it drowns out the user's actual request.

Every parameter must carry a `.describe()` annotation that explains not just what the parameter is, but how the LLM should think about filling it. For example, the `pert_estimate` tool's `most_likely` parameter should be described as: "Your best-guess duration if everything goes reasonably well. Do NOT use your initial optimistic guess—historical data shows initial estimates average 1.5× too low." This embeds the planning fallacy correction directly into the parameter description, nudging the LLM toward more realistic inputs.

Tool annotations (shipped in the 2025-03-26 MCP specification) serve as a "risk vocabulary" [^411^]. All estimation tools are read-only (`readOnlyHint: true`) and non-destructive (`destructiveHint: false`), which lets MCP clients auto-approve them without human confirmation. Tools that write to PM systems (updating Jira worklogs, creating time entries) carry `destructiveHint: true` and trigger the confirmation workflow.

**Table 3: MCP Tool Schema Specifications for the 11 Consolidated Tools**

| Tool Name | Layer | Primary Function | Key Parameters | Output Schema | readOnlyHint |
|-----------|-------|-----------------|----------------|---------------|--------------|
| `temporal_status` | 1 | Current time context, session elapsed time | `timezone` (IANA string), `include_session_time` (bool) | `{utc_time, local_time, elapsed_session_ms, is_business_hours}` | true |
| `time_math` | 1–2 | Registry-dispatched time calculations | `operation` (enum: add_days, add_business_days, diff, convert_tz, parse_nl, format), `operands` (object) | `{result, result_human_readable, operation_applied}` | true |
| `pert_estimate` | 3 | Three-point Beta distribution estimation | `tasks[]` (each with `optimistic`, `most_likely`, `pessimistic`, `name`) | `{expected, variance, std_dev, confidence_interval_95, urgency_category}` | true |
| `cocomo_estimate` | 3 | LLM-adapted parametric effort model | `size_kloc`, `stage` (enum), `cost_drivers` (object), `scale_factors` (object) | `{effort_person_months, schedule_months, team_size, range_low, range_high}` | true |
| `sprint_forecast` | 3 | Velocity-based completion prediction | `backlog_points`, `velocity_history[]`, `sprint_length_days` | `{sprints_required, completion_date, confidence_80, risk_flags[]}` | true |
| `critical_path` | 3 | CPM with merge-bias adjustment | `tasks[]` (each with `duration`, `predecessors[]`, `name`) | `{critical_path_tasks[], slack_per_task[], merge_bias_adjustment}` | true |
| `fetch_historical_data` | 4 | Unified PM system query | `source` (enum: jira, asana, toggl, git, calendar), `filters` (object), `date_range` | `{records[], summary_stats, data_quality_score}` | true |
| `reference_class_estimate` | 4–5 | Data-driven estimate with correction | `task_type` (enum), `complexity` (1–5), `team_id` (optional) | `{raw_estimate, corrected_estimate, correction_factor, sample_size, confidence}` | true |
| `monte_carlo_simulation` | 5 | Probabilistic schedule risk analysis | `tasks[]`, `iterations` (default 10,000), `correlation_matrix` (optional) | `{p10, p50, p80, p95, critical_path_probability, risk_events[]}` | true |
| `calibrate_estimates` | 5 | Recalculate team correction factors | `team_id`, `period_days` (default 90), `minimum_samples` (default 10) | `{correction_factor, accuracy_trend, velocity_trend, recommendations[]}` | false (writes calibration data) |
| `token_time_bridge` | 1–5 | Explicit token-to-wall-clock mapping | `tokens`, `model` (enum), `tool_calls` (int), `reasoning_depth` (enum) | `{estimated_seconds, estimated_minutes, confidence, breakdown}` | true |

The schema design reflects the core principles from Section 5.1. Every estimation tool returns both a precise value and a categorical classification (`urgency_category`, `confidence`, `risk_flags`). The `token_time_bridge` tool directly implements the token-to-time mapping principle. The `reference_class_estimate` tool prioritizes historical data over algorithmic models. And the `time_math` registry dispatch minimizes context window consumption while maximizing coverage.

### 5.3.3 Resource and Prompt Templates

MCP Resources provide read-only data access via URIs following RFC 6570 URI Templates with parameterized variables [^335^]. For the time estimation server, resources expose data that changes frequently but is not the result of a computation: team velocity histories, estimation methodology references, and calibration factor tables.

Key resources include:

- `velocity://{team_id}` — Rolling velocity chart data for a team, updated after each sprint completion. The LLM can subscribe to this resource to receive push notifications when velocity changes.
- `methodology://{name}` — Estimation methodology references ("How to apply PERT to LLM-assisted tasks," "Reference class forecasting guide"). These are static reference documents that help the LLM use the tools correctly.
- `accuracy://{team_id}/{period}` — Estimation accuracy metrics (MAPE, bias, variance) for a team over a specified period, enabling the LLM to report on estimation quality trends.

MCP Prompts are user-controlled templates that are never auto-triggered by the model [^332^]. Following the Harness v2 skills layer pattern [^19^], the server registers prompt templates for common estimation workflows:

- `/estimate-project` — Guided multi-step workflow: break down tasks → apply PERT per task → compute critical path → run Monte Carlo → apply reference class correction
- `/sprint-plan` — Velocity-based capacity planning with story-point-to-hours conversion and risk buffer calculation
- `/schedule-milestone` — Business-day math with holiday awareness and buffer inclusion
- `/audit-estimates` — Compare estimates vs. actuals, compute correction factors, identify systematic bias patterns
- `/cocomo-assessment` — Guided function point counting → COCOMO II calculation with LLM-adapted cost drivers

Each prompt template is a parameterized MCP prompt that the user (or the LLM, via user request) selects. They are not automatic—the spec explicitly prevents auto-triggering [^332^]—but they provide structured starting points that improve estimation consistency.

### 5.3.4 Transport and Deployment

MCP supports two official transport mechanisms [^348^]: **stdio** (local process communication via stdin/stdout, approximately 1 ms latency, no authentication needed) and **Streamable HTTP** (remote network communication, 10–100 ms latency, supports OAuth 2.1). The older HTTP+SSE transport was deprecated in March 2025 and should not be used for new implementations [^345^].

**stdio** is the correct choice for local development and personal productivity workflows. Claude Desktop and Claude Code both spawn MCP servers as child processes and communicate through stdin/stdout [^348^]. The ~1 ms latency makes stdio ideal for interactive estimation queries where the agent is making rapid successive tool calls.

**Streamable HTTP** is the correct choice for production deployment and team-shared instances. It uses a single endpoint with POST requests and optional SSE streaming, solving the dual-endpoint complexity, scalability limitations, and connection reliability issues of the deprecated SSE-only approach [^345^]. For production, the MCP specification recommends stateless mode (`stateless_http=True`, `json_response=True`) for optimal horizontal scaling, though this sacrifices server-initiated capabilities like progress notifications and sampling [^403^]. A time estimation server can operate statelessly because all operations are request-response: the LLM asks for an estimate, the server computes and returns it. There is no need for server-initiated sampling or long-running subscriptions.

Security considerations are paramount. A 2025 study of 2,614 MCP implementations found 82% use file system operations prone to Path Traversal (CWE-22), 67% use sensitive APIs related to Code Injection (CWE-94), and 34% related to Command Injection (CWE-78) [^400^]. The time estimation server minimizes attack surface by: (1) never executing shell commands or file system operations outside its configured data directories, (2) validating all date/time inputs with strict schema enforcement, (3) using read-only mode for all estimation queries, and (4) requiring explicit confirmation for any write operation to PM systems.

Production deployment should follow the tiered risk assessment framework: Tier 1 (read-only internal operations) auto-approved; Tier 2 (single-record writes) single confirmation; Tier 3 (multi-record updates) confirmation plus audit; Tier 4 (destructive operations) multi-party approval [^323^]. All estimation and query tools fall in Tier 1. Calibration updates and PM system writes fall in Tier 2 or 3.

The architecture described in this chapter—five functional layers, eleven consolidated tools with registry-based dispatch, dual-output schemas with categorical and numeric values, explicit token-to-time bridging, and reference-class forecasting prioritized over algorithmic models—constitutes the first integrated solution to the "estimation infrastructure vacuum" identified in the research. The following chapter translates this architecture into implementation, providing concrete Python and TypeScript code for each layer and tool.
