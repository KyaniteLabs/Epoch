# Dimension 09: Time Estimation Tool Design & Specification

## Research Summary

**Scope:** Design the conceptual architecture and functional specification for an MCP server or skill that helps LLMs provide accurate time calculations, duration estimates, and scheduling reasoning. This dimension covers: (a) temporal computation primitives (datetime, timezone, duration), (b) software project estimation algorithms (PERT, COCOMO, story points, function points), (c) calendar math and business-day calculations, (d) integration patterns with project management and time-tracking systems, and (e) existing MCP server implementations in this domain.

---

## 1. Key Findings with Evidence

### 1.1 LLMs Cannot Reliably Calculate Time Differences — Tool Support Is Essential

The foundational motivation for a time-estimation MCP tool comes from well-documented LLM limitations in temporal reasoning. The creators of the `passage-of-time-mcp` server explicitly built it to address the problem that "LLMs can't reliably calculate time differences" and that instead of "publishing a paper about how 'silly' these models are at mental math, we decided to do what we've done for ourselves: equip them with a calculator for time."

Claim: LLMs struggle with basic temporal reasoning including time difference calculations, awareness of current time, and understanding passage of time in conversations.
Source: passage-of-time-mcp GitHub repository
URL: https://github.com/jlumbroso/passage-of-time-mcp
Date: 2024-01-15 (ongoing)
Excerpt: "This project emerged from a philosophical question: 'Can AI perceive the passage of time?' What started as an exploration of machine consciousness became a practical solution to a real problem - LLMs can't reliably calculate time differences. Instead of publishing a paper about how 'silly' these models are at mental math, we decided to do what we've done for ourselves: equip them with a calculator for time."
Context: The server provides 6 core functions (current_datetime, time_difference, timestamp_context, time_since, parse_timestamp, add_time, format_duration) to give Claude/GPT temporal awareness.
Confidence: high

This aligns with the Toolformer paper from Meta AI, which identified that "large models (albeit their impressive results) struggle with basic functionality like arithmetic or factual lookup, whereas smaller and simpler models perform better" — specifically noting "Limited awareness of the passage of time (you can ask a chatbot about current dates and times)" as a key limitation.

Claim: Toolformer demonstrated that LLMs can teach themselves to use external tools via simple APIs, including a calculator and calendar, achieving substantially improved zero-shot performance.
Source: arXiv / Meta AI — "Language Models Can Teach Themselves to Use Tools"
URL: https://arxiv.org/abs/2302.04761
Date: 2023-02-09
Excerpt: "Language models (LMs) exhibit remarkable abilities to solve new tasks from just a few examples or textual instructions, especially at scale. They also, paradoxically, struggle with basic functionality, such as arithmetic or factual lookup, where much simpler and smaller specialized models excel. In this paper, we show that LMs can teach themselves to use external tools via simple APIs and achieve the best of both worlds. We incorporate a range of tools, including a calculator, a Q&A system, two different search engines, a translation system, and a calendar."
Context: Toolformer was trained in a self-supervised way to decide which APIs to call, when to call them, what arguments to pass, and how to incorporate results into future token prediction.
Confidence: high

---

### 1.2 Existing MCP Servers for Time Already Exist — But Are Narrow in Scope

At least three MCP servers for time computation exist in the open-source ecosystem:

**A. passage-of-time-mcp (by Jérémie Lumbroso / Princeton)**
- Features: `current_datetime`, `time_difference`, `timestamp_context`, `time_since`, `parse_timestamp`, `add_time`, `format_duration`
- Philosophy: "teaching AI the significance of the passage of time"
- Notable: Designed through collaboration with Claude Opus 4.0; returns human-readable contextual metadata (e.g., "is_weekend", "is_business_hours", "typical_activity")
- Transport: HTTP SSE (FastMCP framework)

**B. mcp-time (by TheoBrigitte)**
- Features: "Time Manipulation" (current time, timezone conversion, add/subtract durations), "Natural Language Parsing" ("yesterday", "next month"), "Time Comparison", "Flexible Formatting"
- Transport: stdio for local, HTTP stream for network
- Hosted deployment available on Fronteir AI

**C. Time MCP Server (on mcpmarket.com)**
- Features: current time in UTC/local, relative time calculation, timestamps, days in month, week/ISO week, timezone conversion

Claim: Multiple open-source MCP servers for time already exist, providing basic temporal computation primitives.
Source: GitHub — TheoBrigitte/mcp-time
URL: https://github.com/TheoBrigitte/mcp-time
Date: 2025-10-01
Excerpt: "The Time MCP Server is a Model Context Protocol server that provides AI assistants and other MCP clients with standardized tools to perform time and date-related operations. This server acts as a bridge between AI tools and a robust time-handling backend, allowing for complex time manipulations through natural language interactions."
Context: Supports stdio and HTTP stream transports. Includes natural language parsing for relative time expressions.
Confidence: high

Claim: The passage-of-time-mcp server was featured on Hacker News and demonstrated that temporal awareness enables conversation pattern analysis.
Source: Hacker News — "Show HN: An MCP server that gives LLMs temporal awareness and time calculation"
URL: https://news.ycombinator.com/item?id=44583014
Date: 2025-07-16
Excerpt: "Six functions (`current_datetime`, `time_difference`, `timestamp_context`, etc.) give Claude/GPT real temporal awareness: It can spot pauses, reason about rhythms, and even label a chat's 'three-act structure'."
Context: 91 points, 55 comments. Author discussed extending the pattern to location, weather, device state, calendar context, biometric cues.
Confidence: high

**Gap observation:** All existing time MCP servers focus on *calendar time* (clocks, timezones, durations). None address *software project time estimation* (story points, PERT, COCOMO, velocity forecasting, critical path), *business-day math*, or *integration with project management systems* (Jira, Asana, Toggl, Clockify).

---

### 1.3 Core Time/Date Libraries Form the Implementation Foundation

For a Python-based MCP server, the following libraries provide the essential primitives:

**Python datetime ecosystem:**
- `python-dateutil`: Flexible parsing, `relativedelta` for month/year arithmetic, timezone handling
- `pendulum`: Drop-in datetime replacement with better API, timezone awareness by default, human-readable diffs (`diff_for_humans()`), proper DST handling
- `zoneinfo` (Python 3.9+): Built-in IANA timezone database access
- `pytz`: Legacy timezone support, `localize()` for DST-aware conversion
- `isodate`: ISO 8601 duration parsing (e.g., `P3Y6M4DT12H30M5S`)
- `dateparser`: Natural language date parsing ("15 Juni 2026" in Swedish, "March 3")
- `python-networkdays` / `workalendar` / `holidays`: Business-day calculations with holiday awareness

Claim: Pendulum provides a cleaner API than native datetime while inheriting from it, eliminating naive datetimes, and handling DST transitions correctly.
Source: PyPI — Pendulum
URL: https://pypi.org/project/pendulum/
Date: 2026-01-30
Excerpt: "Pendulum provides a cleaner and more easy to use API while still relying on the standard library. So it's still datetime but better. Unlike other datetime libraries for Python, Pendulum is a drop-in replacement for the standard datetime class (it inherits from it). It also removes the notion of naive datetimes: each Pendulum instance is timezone-aware and by default in UTC for ease of use."
Context: Example shows `pendulum.datetime(2013, 3, 31, 2, 30, tz='Europe/Paris')` correctly returning 03:30 because 2:30 does not exist (DST skip).
Confidence: high

Claim: dateutil's relativedelta enables differences in terms of months/years that timedelta cannot represent, but converting relativedelta to days requires anchor dates because month lengths vary.
Source: Stack Overflow — "dateutil.relativedelta - How to get duration in days?"
URL: https://stackoverflow.com/questions/27908090/dateutil-relativedelta-how-to-get-duration-in-days
Date: 2021-11-09
Excerpt: "There isn't a very clean way to get the span of time in a particular unit. This is partly because of the date-range dependency on units. `relativedelta()` takes an argument for months. But when you think about how long a month is, the answer is 'it depends'. With that said, it's technically impossible to convert a `relativedelta()` directly to days, without knowing which days the delta lands on."
Context: This is a critical implementation detail for any MCP tool that promises "duration in days" when the input may include months or years.
Confidence: high

Claim: isodate parses ISO 8601 duration strings into timedelta or Duration objects, with a custom Duration class for years/months since timedelta doesn't handle them.
Source: PyPI — isodate
URL: https://pypi.org/project/isodate/
Date: 2024-10-08
Excerpt: "As ISO 8601 allows to define durations in years and months, and timedelta does not handle years and months, this module provides a Duration class, which can be used almost like a timedelta object (with some limitations). However, a Duration object can be converted into a timedelta object."
Context: Methods: parse_time, parse_date, parse_datetime, parse_duration, parse_tzinfo; plus ISO formatting methods.
Confidence: high

Claim: workalendar provides holiday-aware business-day calculations for 80+ countries.
Source: workalendar documentation
URL: https://workalendar.github.io/workalendar/basic.html
Date: ongoing
Excerpt: "workalendar covers 70+ countries with state/province support for some... methods include `add_working_days()`, `get_working_days_delta()`, `is_working_day()`."
Context: Handles different workweeks (Israel Sunday-Thursday, UAE Monday-Friday), variable holidays (Easter, Thanksgiving), and pre-calculated astronomical values for Asian calendars (1991-2051).
Confidence: high

---

### 1.4 Timezone Handling Best Practices Are Well-Established

The research reveals consensus on timezone handling best practices that any time MCP server should implement:

1. **Always store UTC** — single source of truth
2. **Never use server local time** — use `datetime.now(timezone.utc)`
3. **Use timezone identifiers, not offsets** — "America/New_York" not "EST"
4. **Handle DST transitions explicitly** — check for ambiguous/invalid times
5. **Use aware datetime objects** — never naive

Claim: Python 3.9+ zoneinfo module is the recommended modern approach; pytz is for legacy support only.
Source: Dev.to — "Daylight Saving Time Handling Strategies: A Guide for C# and Python Developers"
URL: https://dev.to/outdated-dev/daylight-saving-time-handling-strategies-a-guide-for-c-and-python-developers-2oe0
Date: 2026-01-13
Excerpt: "Strategy 2: Use zoneinfo (Python 3.9+). The zoneinfo module is built-in and uses system timezone data. Strategy 3: Use pytz for Legacy Support. For Python < 3.9 or when you need pytz-specific features."
Context: Also recommends dateutil for flexible parsing and NodaTime for advanced C# scenarios.
Confidence: high

Claim: DST transitions create both "ambiguous times" (fall back — two 1:30 AMs) and "invalid times" (spring forward — 2:30 AM doesn't exist). Any time tool must handle these.
Source: Same Dev.to article
URL: https://dev.to/outdated-dev/daylight-saving-time-handling-strategies-a-guide-for-c-and-python-developers-2oe0
Date: 2026-01-13
Excerpt: "When a time is ambiguous, decide how to handle it. Option 1: Use the first occurrence (DST). Option 2: Use the second occurrence (Standard Time). Option 3: Throw exception and require user to specify. When a time doesn't exist, adjust it. Option 1: Add one hour (move to valid time)."
Context: Example code shows `timezone.IsAmbiguousTime()` and `timezone.IsInvalidTime()` checks.
Confidence: high

---

### 1.5 Software Estimation Algorithms: From Classic to Agile

**PERT (Program Evaluation and Review Technique)**
- Formula: `Expected Time = (Optimistic + 4 × Most Likely + Pessimistic) / 6`
- Variance: `((Pessimistic - Optimistic) / 6)²`
- Standard Deviation: `(Pessimistic - Optimistic) / 6`
- Origins: U.S. Navy Polaris missile project, 1958
- Also supports Triangular Distribution: `(O + M + P) / 3` (less accurate)

Claim: PERT uses Beta distribution weighting, giving 4x weight to Most Likely because it follows Normal Distribution shape more accurately than simple triangular averaging.
Source: ProjectManagement.com — "3-Points Estimating"
URL: https://www.projectmanagement.com/wikis/368763/3-points-estimating
Date: ongoing
Excerpt: "Beta Distribution (PERT): E = (o + 4m + p) / 6. The beta distribution is a weighted average in which more weight is given to the most likely estimate. This alteration to the formula and placing more weight on the most likely estimate is made to increase the accuracy of the estimate by making it follow the Normal Distribution shape. Hence, in most of the cases, the Beta (PERT) distribution has been proven to be more accurate than the 3-Point triangular estimation."
Context: For Activity A with o=4, m=8, p=16: Triangular gives 9.3 hours, Beta/PERT gives 8.7 hours.
Confidence: high

**COCOMO II (Constructive Cost Model)**
- Three stages: Application Composition (object points), Early Design (function points → KLOC), Post-Architecture (LOC + 17 cost drivers)
- Formula: `PM_nominal = A × (Size)^B` where B (scale factor) varies 1.1–1.24 based on novelty, flexibility, risk resolution, team cohesion, process maturity
- Full formula with cost drivers: `PM = A × Size^B × ∏(EM_i)` where EM = multiplicative effort multipliers

Claim: COCOMO II provides range estimates tied to estimation input definition degree, not point estimates.
Source: COCOMO II Model Definition Manual (USC)
URL: https://athena.ecs.csus.edu/~buckley/CSc231_files/Cocomo_II_Manual.pdf
Date: 1999–2000
Excerpt: "COCOMO II enables projects to furnish coarse-grained cost driver information in the early project stages, and increasingly fine-grained information in later stages. Consequently, COCOMO II does not produce point estimates of software cost and effort, but rather range estimates tied to the degree of definition of the estimation inputs."
Context: Developed by Barry Boehm at USC. Three sub-models: End User Programming, Intermediate Sector, Infrastructure Sector.
Confidence: high

**Function Point Analysis (FPA)**
- Five component types: External Inputs, External Outputs, External Inquiries, Internal Logical Files, External Interface Files
- Each classified by complexity (low/average/high) with weights
- UFP = Unadjusted Function Points; AFP = Adjusted (with Value Adjustment Factor 0.65–1.35)
- ISO standards: IFPUG (1st gen, 1974), COSMIC (2nd gen, 1998)

Claim: Function points measure software by quantifying information processing functionality associated with external data/control input, output, or file types.
Source: COCOMO II Model Definition Manual / IFPUG
URL: https://athena.ecs.csus.edu/~buckley/CSc231_files/Cocomo_II_Manual.pdf
Date: 1999–2000
Excerpt: "Function points measure a software project by quantifying the information processing functionality associated with major external data or control input, output, or file types. Five user function types should be identified... Each instance of these function types is then classified by complexity level. The complexity levels determine a set of weights, which are applied to their corresponding function counts to determine the Unadjusted Function Points quantity."
Context: Used in COCOMO II Early Design model as sizing input before KLOC is known.
Confidence: high

**Story Points & Velocity**
- Story points measure complexity, effort, and uncertainty (not just time)
- Modified Fibonacci sequence: 1, 2, 3, 5, 8, 13, 21...
- Velocity = average story points completed per sprint
- Conversion to hours: `Conversion Factor = Total Sprint Hours ÷ Average Velocity`
- Burndown charts track remaining work daily; velocity charts track completed work per sprint for forecasting

Claim: Story point to hours conversion is team-specific and should be recalculated every 3-4 sprints.
Source: StarAgile — "How to Convert Story Points to Hours in Agile Estimation"
URL: https://staragile.com/blog/story-points-to-hours
Date: 2024-07-19
Excerpt: "Formula: Conversion Factor = Total Sprint Hours ÷ Average Velocity. Using our example: 300 hours ÷ 30 story points = 10 hours per story point... Recalculate your conversion factor every 3-4 sprints or whenever significant team changes occur."
Context: Example validation table shows expected vs actual hours with variance tracking.
Confidence: high

**Critical Path Method (CPM)**
- Forward pass: calculate Early Start (ES), Early Finish (EF)
- Backward pass: calculate Late Start (LS), Late Finish (LF), Slack
- Critical path = activities with zero slack (longest path)
- Python implementation readily available using topological sorting

Claim: CPM implementation in Python can compute ES, EF, LS, LF, Slack, and critical path from task-duration-predecessor data.
Source: dimkoug.com — "Critical Path Method Algorithm Python"
URL: https://www.dimkoug.com/post/python/critical-path-method-algorithm-python/
Date: ongoing
Excerpt: "The calculate_critical_path function then calculates the critical path for these activities and prints the result using json.dumps... including the earliest start (es), earliest finish (ef), latest start (ls), latest finish (lf), and slack time for each activity."
Context: Simple 8-activity example with dependencies shows iterative ES/EF forward pass and reverse LS/LF/slack calculation.
Confidence: high

---

### 1.6 The Planning Fallacy Is the Primary Enemy of Time Estimation

Research consistently shows that software projects overrun estimates due to systematic cognitive biases:

Claim: The Standish Group's CHAOS reports found only about 30% of software projects completed on time and on budget.
Source: dev.to — "The Planning Fallacy in Software Development"
URL: https://dev.to/william_geo/the-planning-fallacy-in-software-development-16jf
Date: 2026-02-28
Excerpt: "The Standish Group's CHAOS reports have found that only about 30% of software projects are completed on time and on budget. A study by Bent Flyvbjerg found that IT projects have an average cost overrun of 27%, with one in six projects having a cost overrun of 200% or more. Research by Steve McConnell suggests that initial estimates for software projects are typically off by a factor of 2x to 4x."
Context: Planning fallacy (Kahneman & Tversky) is the tendency to underestimate time, costs, and risks. Software is especially vulnerable due to invisible complexity, novel problem-solving, cascading dependencies, and "happy path" bias.
Confidence: high

Claim: Kahneman's solution is "reference class forecasting" — estimate from the outside (how similar tasks actually unfolded) rather than from the inside (imagining how the task will unfold).
Source: Same dev.to article
URL: https://dev.to/william_geo/the-planning-fallacy-in-software-development-16jf
Date: 2026-02-28
Excerpt: "Kahneman's solution to the planning fallacy is 'reference class forecasting' -- instead of estimating from the inside (imagining how the task will unfold), estimate from the outside (looking at how similar tasks actually unfolded in the past). Keep records of actual vs. estimated time for every task. Categorize tasks by type and complexity. Use historical data rather than intuition for future estimates. Apply correction factors based on your track record."
Context: If past estimates have consistently been 2x too low, multiply current estimate by 2.
Confidence: high

**Implication for MCP tool design:** A time-estimation MCP server should support *historical data integration* (actual vs. estimated times), *reference class forecasting*, and *systematic correction factors* — not just raw calculation.

---

### 1.7 Monte Carlo Simulation Enables Probabilistic Schedule Forecasting

For advanced scheduling, Monte Carlo simulation produces probabilistic completion dates (P50, P80) rather than single-point estimates.

Claim: Monte Carlo schedule risk analysis helps determine the impact of risks and uncertainties on schedules and generates risk-adjusted project schedules.
Source: RiskyProject / Intaver
URL: https://intaver.com/
Date: 2026-03-14
Excerpt: "RiskyProject performs both qualitative and quantitative project risk analysis and includes schedule and cost risk analysis using Monte Carlo simulations... Monte Carlo schedule risk analysis helps to determine the impact of risks and uncertainties on your schedule and generates risk adjusted project schedules."
Context: Tools like RiskyProject, Safran Risk, Acumen Risk, Oracle Primavera Cloud integrate with MS Project/Primavera for Monte Carlo simulation.
Confidence: high

Claim: Merge bias means the more predecessors any activity has, the less probable it is to start on time — this is the key reason for Monte Carlo schedule risk analysis.
Source: Barbecana — Full Monte Schedule Risk Analysis
URL: https://www.barbecana.com/full-monte/
Date: 2025-04-28
Excerpt: "About the only thing you can be certain of about a project completion date calculated by traditional critical path method (CPM) scheduling tools is that it will be wrong... a phenomenon called merge bias means that the more predecessors any given activity has, the less probable it is to start on time. This is the key reason for performing a schedule risk analysis using Monte Carlo simulation."
Context: Full Monte SRA calculates range of probable dates for every activity/milestone and identifies all potential critical paths.
Confidence: high

---

### 1.8 Machine Learning for Task Duration Prediction Is an Active Research Area

Claim: IEEE Access paper (2023) investigated ML techniques for predicting task effort and duration in software projects, finding applicability for individual task-level estimation.
Source: IEEE Access — "Applying Machine Learning to Estimate the Effort and Duration of Individual Tasks in Software Projects"
URL: https://ieeexplore.ieee.org/document/10227275/
Date: 2023
Excerpt: "We investigate the use of machine learning techniques in predicting task effort and duration in software projects to assess their applicability and..."
Context: Cited in SciTePress 2025 paper "AI-Based Approaches for Software Tasks Effort Estimation" alongside other ML approaches: Sarro et al. (2022) "Learning from mistakes: Machine learning enhanced human expert effort estimates" in IEEE TSE.
Confidence: medium

Claim: Probabilistic estimation using historical databases and Monte Carlo simulation can improve accuracy early in the lifecycle even with incomplete requirements.
Source: arXiv / New Zealand Journal — "Probabilistic Estimation of Software Project Duration"
URL: https://arxiv.org/pdf/1606.05926
Date: 2007
Excerpt: "By linking estimates to a historical database of real project data, the approach has the capability to make accurate estimates early in the lifecycle with relatively low risk, despite the fact that the project requirements may be incomplete or inaccurate. The data in the historical data base is the actual duration of previous projects, for which estimates would have been made in similar circumstances when requirements were incomplete."
Context: Uses ISBSG dataset and Finnish dataset. Tool captures actual effort per project phase, refits distributions as data grows.
Confidence: medium

---

### 1.9 Project Management and Time Tracking APIs Provide Data Sources

**Jira REST API:**
- Worklogs: `GET /rest/api/2/issue/{issueIdOrKey}/worklog` — returns time spent, author, started time
- Search with JQL: `worklogDate>=2022-09-05 AND worklogAuthor=currentUser()`
- Fields: estimated time, actual time, timeSpentSeconds

**Asana API:**
- Native time tracking with Estimated time and Actual time custom fields
- Time tracking read API support available
- Supports subtask rollups, live timer, CSV import/export

**Toggl Track API:**
- `POST /api/v9/workspaces/{workspace_id}/time_entries` — create time entry
- Duration in seconds; start/stop timestamps in ISO 8601
- `GET /api/v9/me/time_entries/current` — get running timer

**Clockify API:**
- REST API with X-Api-Key auth
- Webhooks for real-time notifications
- Rate limit: 50 requests/second
- Entity changes API for sync

**Harvest MCP Server (existing):**
- Already exists as MCP server integration
- Features: time entries, projects, clients, tasks, estimates

Claim: Harvest MCP Server already exists as an MCP integration for time tracking and project management.
Source: mcpservers.org — "Harvest MCP Server"
URL: https://mcpservers.org/servers/taiste/harvest-mcp-server
Date: ongoing
Excerpt: "This MCP server provides integration with the Harvest time tracking and project management API. It allows Claude and other MCP-compatible AI assistants to interact with your Harvest account, helping you manage time entries, projects, clients, and more."
Context: Tools include: list users, list/create time entries, start/stop timers, list projects, list clients, list tasks, list/create/update estimates.
Confidence: high

---

### 1.10 MCP Workflow Patterns: Skills Layer, Registry Dispatch, Prompt Templates

The Harness MCP v2 redesign demonstrates how to move beyond raw tools to workflow-oriented skills:

Claim: Harness MCP v2 introduces a skills layer that turns raw MCP tool access into guided, multi-step workflows through three levels: shared agent instructions, server-side prompt templates, and individual slash-command skills.
Source: Harness.io — "Designing MCP for the Age of AI Agents"
URL: https://www.harness.io/blog/harness-mcp-server-redesign
Date: 2026-03-19
Excerpt: "The v2 server ships with a companion skills layer that turns raw MCP tool access into guided, multi-step workflows. Skills are IDE-native agent instructions that teach the AI how to use the MCP server effectively — without the developer having to explain Harness concepts or orchestration patterns... Level 1: Shared Agent Instructions (CLAUDE.md, AGENTS.md, .cursor/rules). Level 2: Prompt Templates (Server-Side) — 26 MCP prompt templates registered directly in the server. Level 3: Individual Skills (Slash Commands) — SKILL.md files that function as slash commands."
Context: Example skills: /create-pipeline, /run-pipeline, /debug-pipeline, /create-service, /analyze-costs, /audit-report.
Confidence: high

Claim: MCP tool descriptions are "smelly" — purely natural-language-based alignment can lead to inefficiency. Augmented descriptions with structured metadata improve agent efficiency.
Source: arXiv — "Model Context Protocol (MCP) Tool Descriptions Are Smelly! Towards Improving AI Agent Efficiency with Augmented MCP Tool Descriptions"
URL: https://arxiv.org/html/2602.14878v1
Date: 2026-02-16
Excerpt: "MCP provides a unified interface to bridge FM-based agents with external capabilities by exposing them to the following three tools-related natural-language artifacts: a tool name, a tool description, and an input schema... This purely native natural-language-based alignment of MCP with the agentic ecosystem is driving its massive adoption."
Context: Paper argues for improving tool descriptions beyond natural language to reduce agent inefficiency.
Confidence: high

---

## 2. Major Players, Tools, and Frameworks

### Time/Date Libraries
| Library | Purpose | Key Feature |
|---------|---------|-------------|
| pendulum | Modern datetime | Drop-in replacement, always timezone-aware, human diffs |
| python-dateutil | Parsing/deltas | relativedelta for month/year arithmetic |
| zoneinfo (stdlib) | Timezones | Built-in IANA database (Python 3.9+) |
| pytz | Legacy timezones | localize() for DST handling |
| isodate | ISO 8601 | parse_duration for PnYnMnDTnHnMnS |
| dateparser | NL parsing | "March 3", multi-language, incomplete dates |
| workalendar | Business days | 80+ country holiday calendars |
| python-networkdays | Business days | Lightweight, no dependencies, JobSchedule |
| arrow | Alternative datetime | RFC 3339/ISO 8601 focused |

### Software Estimation Models
| Model | Type | Use Case |
|-------|------|----------|
| PERT | Probabilistic (3-point) | Task-level duration with uncertainty |
| COCOMO II | Parametric | Effort/cost at project-level |
| Function Points | Functional sizing | Size measurement from requirements |
| Story Points | Relative estimation | Agile sprint planning |
| SEER (Galorath) | Parametric + Monte Carlo | Enterprise cost/schedule/risk |
| Reference Class Forecasting | Historical benchmark | Correcting planning fallacy |

### Existing MCP Time Servers
| Server | Author | Focus |
|--------|--------|-------|
| passage-of-time-mcp | jlumbroso (Princeton) | Temporal awareness, conversation patterns |
| mcp-time | TheoBrigitte | Time manipulation, NL parsing, formatting |
| Time (mcpmarket) | Unknown | Basic time ops, timezone conversion |
| Harvest MCP Server | taiste | Harvest API integration (time tracking) |

### PM/Time Tracking APIs
| API | Data Available |
|-----|---------------|
| Jira REST API | Worklogs, estimated/actual time, issue search |
| Asana API | Estimated time, actual time, time logs, subtask rollups |
| Toggl Track API v9 | Time entries, projects, durations, running timers |
| Clockify API | Time entries, webhooks, custom fields, detailed reports |
| Harvest API | Time entries, projects, clients, estimates |

---

## 3. Controversies and Conflicting Claims

### 3.1 Story Points vs. Hours: Strong Opposing Views
- **Pro-conversion:** Some teams "prefer to convert story points to some measurement of time" and tools exist for this (PlanningPoker.live Story Point Calculator).
- **Anti-conversion:** Leading Agile teams argue story points measure complexity, not time, and conversion "breaks" the relative estimation model. Monday.com writes: "This shift helps teams plan more accurately... It changes the conversation from 'Why did this take 10 hours instead of 8?' to 'Did we deliver what we committed to?'"

Claim: "Some agile teams prefer to convert story points to some measurement of time, while others are strongly against this conversion."
Source: PlanningPoker.live — Story Point Calculator
URL: https://planningpoker.live/tools/story-point-calculator
Date: ongoing
Excerpt: "Some agile teams prefer to convert story points to some measurement of time, while others are strongly against this conversion. This story point calculator helps the former teams estimate project delivery timelines by converting story points into a measurement of time."
Context: Supports both viewpoints in the agile community. Tool is explicitly for teams that *do* want conversion.
Confidence: high

### 3.2 Velocity as KPI vs. Estimation Tool
- **Correct usage:** Velocity is "a tool for estimation, and its chart should trend towards a horizontal average, not a constant increase." (Sitepoint)
- **Misuse:** Management often treats velocity as a productivity KPI, pressuring teams to increase it sprint-over-sprint, which distorts the metric and leads to gaming.

Claim: "A velocity chart is intended to trend toward a horizontal average. You may hear executives talking about trying to increase the team's velocity... A velocity chart that shows a constant increase (or decrease) over time usually reflects a problem in the process."
Source: Sitepoint — "Scrum Artifacts: Velocity and Burndown Charts"
URL: https://www.sitepoint.com/scrum-artifacts-velocity-and-burndown-charts/
Date: 2024-11-06
Excerpt: "The point of velocity tracking is to improve the team's ability to estimate how much work they can get done consistently and reliably. A velocity chart that shows a constant increase (or decrease) over time usually reflects a problem in the process."
Context: Velocity should converge to a stable line representing sustainable capacity, not grow indefinitely.
Confidence: high

### 3.3 PERT vs. Single-Point Estimation
- PERT advocates claim three-point estimation is "more accurate than the 3-Point triangular estimation" and "proven to be more accurate" for most cases.
- Critics note PERT can be "time-consuming, requiring in-depth analysis and constant monitoring" and that "over-relying on estimates without sufficient data may lead to inaccurate predictions."

### 3.4 Function Point Standards Are Not Comparable
IFPUG, COSMIC, FiSMA, NESMA, and Mark II are all ISO standards but "generally not comparable" — sizing the same software with different approaches yields different results. Researchers should not mix projects sized with different count approaches.

Claim: "These methods are generally not comparable: if the functional size of the same software specification is determined using different approaches, the results will generally be different."
Source: RIUNET — "The usage of ISBSG data fields in software effort estimation"
URL: https://riunet.upv.es/server/api/core/bitstreams/44d941db-235b-4a86-810c-b85dc8db928d/content
Date: ongoing
Excerpt: "COSMIC, IFPUG, FiSMA, NESMA and Mark II refer to the five approaches to Functional Size Measurement that have been approved as international standards. These methods are generally not comparable... Since FSM approaches are not comparable, researchers should not analyse together projects that were sized with different count approaches."
Context: This is a major challenge for any universal function-point MCP tool — which standard to implement?
Confidence: high

---

## 4. Gaps and Open Questions

### 4.1 No Existing MCP Server Combines Calendar Time + Project Estimation
All existing time MCP servers handle "what time is it?" and "how many days between X and Y?" None address "how long will this software project take?" or "what's the critical path?" or "given our velocity, when will we finish the backlog?"

### 4.2 Integration with Historical Data Is Missing
No MCP server connects to Jira/Asana/Toggl to pull actual vs. estimated time data for reference class forecasting. A truly powerful estimation tool needs data, not just algorithms.

### 4.3 Business-Day Math Is Overlooked
Existing servers don't appear to support "5 business days from today" or "how many business days between these dates in Germany?" This is essential for real-world scheduling.

### 4.4 Natural Language Duration Parsing Is Weak
While `dateparser` handles "next Friday", parsing "in 3 business days" or "2 sprints from now" or "by end of Q3" requires more sophisticated NL understanding. No MCP server advertises this capability.

### 4.5 Monte Carlo / Probabilistic Output Is Absent
All existing tools produce point estimates. None provide "P80 completion date is March 15, P50 is February 28" style probabilistic forecasts.

### 4.6 COCOMO/Function Point Calculators Don't Exist as MCP Tools
These are well-documented algorithms but require significant domain knowledge to implement correctly (17 cost drivers, 5 scale factors, complexity tables).

### 4.7 The "Planning Fallacy Correction" Pattern Is Unimplemented
No tool systematically applies Kahneman's reference class forecasting or correction factors based on historical estimate accuracy.

---

## 5. Summary and Recommended Deep-Dive Areas

### 5.1 Recommended Architecture for an "Time Estimation MCP Server"

Based on the Harness MCP v2 pattern and analysis of existing tools, a comprehensive Time Estimation MCP server should have:

**Layer 1: Core Temporal Primitives (existing tools do this)**
- `current_datetime(timezone)` — current time with timezone
- `time_difference(t1, t2, unit)` — duration between timestamps
- `add_time(timestamp, duration, unit)` — add/subtract durations
- `parse_timestamp(string)` — NL date parsing
- `convert_timezone(timestamp, target_tz)` — timezone conversion
- `format_duration(seconds, style)` — human-readable durations

**Layer 2: Calendar Math (gap in existing tools)**
- `business_days_between(start, end, country/region)` — exclude weekends + holidays
- `add_business_days(start, days, country/region)` — advance by business days
- `is_working_day(date, country/region)` — check if business day
- `get_holidays(year, country/region)` — list holidays

**Layer 3: Software Estimation Algorithms (major gap)**
- `pert_estimate(optimistic, most_likely, pessimistic)` — PERT expected time + variance
- `story_point_forecast(backlog_points, velocity_history)` — sprint completion forecast
- `cocomo_estimate(kloc_or_fp, cost_drivers, stage)` — effort in person-months
- `function_point_count(inputs, outputs, inquiries, files, interfaces)` — UFP calculation
- `critical_path(tasks[])` — CPM with ES/EF/LS/LF/slack
- `velocity_tracking(sprint_data[])` — velocity chart + trend analysis

**Layer 4: Data Integration (major gap)**
- `fetch_jira_worklogs(project, date_range)` — actual time data
- `fetch_toggl_entries(workspace, date_range)` — time tracking data
- `compare_estimate_vs_actual(estimated[], actual[])` — correction factor calculation
- `reference_class_forecast(task_type, complexity, historical_db)` — data-driven estimate

**Layer 5: Advanced Analytics (major gap)**
- `monte_carlo_schedule(tasks[], iterations)` — probabilistic completion dates
- `estimate_confidence_interval(estimate, variance, confidence)` — statistical bounds
- `planning_fallacy_correction(estimate, historical_accuracy)` — apply correction factor

### 5.2 Skills / Prompt Templates (per Harness v2 pattern)
- `/estimate-project` — full workflow: breakdown → PERT per task → critical path → Monte Carlo
- `/sprint-plan` — velocity-based capacity planning with story point conversion
- `/schedule-milestone` — business-day math + holiday awareness + buffer calculation
- `/audit-estimates` — compare estimates vs. actuals, calculate correction factors
- `/cocomo-assessment` — guided function point counting → COCOMO II calculation

### 5.3 Key Design Principles
1. **Workflow-oriented, not CRUD-oriented** — per Harness pattern, expose multi-step workflows, not just raw calculation primitives
2. **Always return both raw and human-readable** — JSON for machines, formatted strings for LLM context
3. **Timezone-aware by default** — never naive datetimes; use IANA identifiers
4. **Probabilistic over point estimates** — where possible, return ranges/confidence intervals
5. **Historical data integration** — the tool becomes more valuable as it learns from actuals
6. **Natural language in, structured out** — accept "end of Q3" and "3 business days"; return ISO 8601
7. **Correction factor transparency** — if applying planning fallacy correction, show the math

### 5.4 Recommended Deep-Dive Areas for Further Research
1. **ISBSG dataset integration** — how to leverage the world's largest software project benchmark database (3000+ projects, 20 countries) for reference class forecasting
2. **ML-enhanced estimation** — implementing Sarro et al.'s "Learning from mistakes" approach (IEEE TSE 2022) where ML improves human expert estimates
3. **Discrete-event simulation for scheduling** — implementing day-by-day workflow simulation that respects team availability, skills, and dependencies (per tommesani.com approach)
4. **Function point automation** — ScopeMaster-style automated function point counting from written requirements using NLP
5. **Calendar NLU** — parsing complex temporal expressions like "the last business day of the quarter" or "2 sprints after the release"
6. **Multi-calendar support** — Islamic (lunar), Hebrew, fiscal year calendars alongside Gregorian

---

## Source Index

[^311^] Databricks — "What is the Model Context Protocol (MCP)?" (2026-01-21)
[^446^] Sitepoint — "Managing Dates and Times Using Moment.js" (2024-11-07)
[^447^] PyPI — isodate (2024-10-08)
[^450^] InstituteProjectManagement — "PERT Formula: A Guide to Project Timeline Calculation" (2026-03-05)
[^451^] Asana — "PERT chart: Definition, examples & how to make one" (2026-01-14)
[^452^] Udemy — "PERT Formula Explained" (2025-10-02)
[^453^] ProjectManager.com — "PERT Analysis in Project Management" (2025-07-31)
[^454^] GeeksforGeeks — "COCOMO Model-Software Engineering" (2025-07-11)
[^455^] Rose-Hulman — "Software Estimation With COCOMO-II" (slides)
[^457^] USC — "COCOMO II Model Definition Manual" (1999-2000)
[^458^] GlobalLogic — "Using Story Points to Estimate Software Development Projects" (PDF)
[^459^] ProjectManagement.com — "3-Points Estimating"
[^474^] mcpservers.org — "Harvest MCP Server"
[^475^] Toggl — "Clockify vs. Toggl Track" (2025-02-14)
[^476^] arXiv — "Probabilistic Estimation of Software Project Duration" (2007)
[^477^] Hacker News — "Show HN: An MCP server that gives LLMs temporal awareness" (2025-07-16)
[^478^] GitHub — TheoBrigitte/mcp-time (2025-10-01)
[^480^] Asana Help — "Time tracking in Asana"
[^481^] GitHub — jlumbroso/passage-of-time-mcp (2024-01-15)
[^482^] IEEE — "Applying Machine Learning to Estimate the Effort and Duration of Individual Tasks in Software Projects" (2023)
[^483^] Clockify API Documentation (2024-03-04)
[^487^] Atlassian — "Agile Burndown Chart Tutorial" (2026-02-24)
[^489^] IJSR — "Implementation of CPM in Web Applications for Project Scheduling with Python" (2025-07-16)
[^490^] NextAgile — "Velocity Chart in Agile" (2025-05-09)
[^491^] Galorath — "Project Schedule Management" (2026-03-27)
[^492^] dimkoug.com — "Critical Path Method Algorithm Python"
[^493^] Sitepoint — "Scrum Artifacts: Velocity and Burndown Charts" (2024-11-06)
[^497^] tommesani.com — "forecasting project completion through work flow simulation" (2026-01-25)
[^508^] PyPI — Pendulum (2026-01-30)
[^509^] iRoyal — "Python Dateparser: How to Parse Dates Easily" (2025-08-04)
[^510^] Atlassian Community — Jira worklog timeframe question (2025-03-28)
[^511^] Medium — "Time Tracking and Worklog Best Practices in Jira" (2025-09-29)
[^512^] PyPI — dateparser (2026-03-26)
[^513^] Medium — "Python datetimes with Arrow or Pendulum" (2024-06-30)
[^514^] ScopeMaster — "Function Point counting" (2024-12-20)
[^515^] ParselTongue — "Pendulum: Python datetimes made easy" (2023-03-31)
[^517^] Atlassian Developer — Jira Cloud REST API v3 — Issue worklogs (2021-01-17)
[^520^] arXiv — "Implementation of Function Point Analysis in Measuring the Volume Estimation of Software System" (2013)
[^532^] Intaver — RiskyProject (2026-03-14)
[^533^] ProjectDecisions — "Top Project Risk Analysis Tools" (2025-10-25)
[^534^] Galorath — "Reduce Uncertainty With Monte Carlo Simulation Software" (2025-09-22)
[^535^] Monday.com — "Story points vs hours" (2025-11-27)
[^536^] Reddit r/agile — "How many hours does a Story point equal to?" (2025-09-26)
[^537^] Barbecana — "Full Monte Schedule Risk Analysis" (2025-04-28)
[^538^] Lumivero — "Schedule Risk Analysis: Project Risk Software" (2025-01-10)
[^539^] arXiv — "MCP Tool Descriptions Are Smelly!" (2026-02-16)
[^540^] Toggl Developers — Time entry API docs
[^541^] PlanningPoker.live — Story Point Calculator
[^542^] Toggl Community — "Tracking Time - Getting Started With API" (2024-11-20)
[^543^] StarAgile — "How to Convert Story Points to Hours in Agile Estimation?" (2024-07-19)
[^558^] ACM — Toolformer Proceedings (2025-09-01)
[^559^] arXiv — "Language Models Can Teach Themselves to Use Tools" (2023-02-09)
[^560^] LearnByExample — "Calculating the Time Difference in Python" (2024-04-15)
[^563^] ISBSG — "Estimating Application Maintenance and Support" (2024)
[^564^] RIUNET — "The usage of ISBSG data fields in software effort estimation"
[^565^] ISBSG — "Productivity Measurement of Software Projects"
[^566^] Stack Overflow — dateutil.relativedelta duration days (2021-11-09)
[^567^] ISBSG — "How to use ISBSG data for Software Project Estimation" (2023)
[^568^] GitHub dateutil — ISO8601 Durations support issue (2019-01-09)
[^570^] Medium — "Converting RFC3339 timestamp to UTC timestamp in Python" (2018-09-12)
[^589^] dev.to — "The Planning Fallacy in Software Development" (2026-02-28)
[^590^] WorldDataAPI — "How to Calculate Business Days in Python" (2025-11-30)
[^591^] Galorath — "Cost Modeling & Estimation Software" (2025-10-15)
[^592^] Galorath — SEER platform (2025-05-16)
[^593^] mcpservers.org — Superpower MCP
[^594^] Galorath — "What Is Parametric Modeling?" (2024-12-10)
[^595^] Lark — "Planning Fallacy for Software Development Teams" (2024-01-19)
[^596^] ICEAA — SEER Systems Engineering (PDF)
[^597^] Galorath — "Parametric Estimating for Accurate Project Predictions" (2025-08-06)
[^598^] TowardsDataScience — "The Easiest Way to Identify Holidays in Python" (2022-01-15)
[^599^] PyNative — "Python Get Business Days [4 Ways]" (2022-05-16)
[^600^] workalendar docs — Basic usage
[^19^] Harness.io — "Designing MCP for the Age of AI Agents" (2026-03-19)
