# 6. Implementation Guide

The preceding chapter established the five-layer architecture for a Time Estimation MCP Server and the design rationale behind registry-based dispatch, token footprint minimization, and transport selection. This chapter translates those architectural decisions into runnable code. It provides complete, production-oriented implementations in both Python (with the official `mcp` SDK and FastMCP) and TypeScript (with the official `@modelcontextprotocol/sdk`), followed by testing strategies, evaluation harnesses, and benchmark targets.

The implementations presented here address the three compounding causes of estimation failure identified in Chapter 2: the LLM's architectural inability to track continuous wall-clock time, the replication of human planning fallacy from training data, and the mismatch between traditional estimation models and LLM-assisted development workflows. Rather than attempting to improve the model's internal temporal representation — an approach constrained by transformer theoretical limits — the server makes time information externally legible through structured tool interfaces. [^1^] [^2^] The LLM requests calculations; it does not perform them.

### 6.1 Python Implementation with FastMCP

#### 6.1.1 Project Setup: pyproject.toml, uv Dependency Management, and Async Patterns

Modern Python MCP projects use `uv` for dependency management and `pyproject.toml` for packaging. The single required runtime dependency is `mcp[cli]`, which bundles the FastMCP framework and command-line tools (`mcp dev`, `mcp install`). [^7^] For temporal computation, add `pendulum` (timezone-aware datetime replacement), `isodate` (ISO 8601 duration parsing), `workalendar` (business-day calculations across 80+ countries), and `python-dateutil` for natural-language parsing. [^508^] [^600^]

The `pyproject.toml` below defines a stdio-entry script, optional dev dependencies for pytest, and the minimum Python version. FastMCP supports both synchronous `run()` and asynchronous `run_async()` APIs; for a time-estimation server that may call external calendar APIs, async handlers are essential to avoid blocking the event loop. [^8^]

#### 6.1.2 Core Server Structure: Decorators, Initialization, and stdio Transport

FastMCP infers tool metadata — name, description, and JSON Schema input definitions — from function signatures and docstrings. [^1^] The `@mcp.tool()` decorator registers each estimation function, while `mcp.run(transport="stdio")` starts the JSON-RPC 2.0 message loop over standard input/output. Stdio is the default transport for local development: latency is approximately 1 ms, no authentication is needed, and the host spawns the server as a child process. [^17^] The canonical entry point pattern is `if __name__ == "__main__": mcp.run(transport="stdio")`. [^9^]

A critical constraint for stdio servers is that no data except JSON-RPC messages may be written to stdout; any `print()` or `console.log()` corrupts the stream. All logging must go to stderr or structured log files. [^11^]

#### 6.1.3 Layer 1 Implementation: Core Temporal Primitives

Layer 1 provides the foundational time operations that existing MCP servers such as `passage-of-time-mcp` and `mcp-time` already cover: current time retrieval, timezone conversion, and duration parsing. [^481^] [^478^] The passage-of-time server was explicitly built to address the finding that "LLMs can't reliably calculate time differences" — a motivation that applies directly to our estimation use case. [^481^]

The Python implementation uses `pendulum` as a drop-in replacement for native `datetime`, eliminating naive datetimes and handling DST transitions correctly. [^508^] `isodate.parse_duration()` handles ISO 8601 duration strings such as `P3Y6M4DT12H30M5S`, returning a custom `Duration` object for year/month components that `timedelta` cannot represent. [^447^] `dateparser` enables natural-language inputs such as "next Friday" or "15 Juni 2026" across multiple languages. [^509^]

Each Layer 1 tool returns a structured JSON object containing both a machine-readable result (for downstream tool composition) and a human-readable summary (for LLM context). This dual-output pattern aligns with the `structuredContent` mechanism introduced in MCP specification revision 2025-06-18, where structured data can drive client widgets while concise text minimizes token consumption in the LLM context window. [^22^]

#### 6.1.4 Layer 2 Implementation: Calendar Math and Business Days

Layer 2 extends Layer 1 with calendar-aware calculations that are absent from existing time MCP servers: business-day arithmetic, holiday detection, and working-hours validation. [^478^] The `workalendar` library provides holiday-aware business-day calculations for 80+ countries, handling variable workweeks (Israel Sunday–Thursday, UAE Monday–Friday) and moveable holidays such as Easter and Thanksgiving. [^600^]

DST transitions create two edge cases that any production time server must handle: "ambiguous times" (fall back — two 1:30 AM instances exist) and "invalid times" (spring forward — 2:30 AM does not exist). The implementation detects these conditions and returns domain errors with `isError: true`, enabling the LLM to retry with explicit disambiguation rather than silently producing incorrect results. [^10^]

Tool annotations communicate operational characteristics to AI clients without consuming context tokens. A time estimation tool should set `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false` (unless calling external APIs), signaling that the tool is safe to invoke speculatively. [^23^] The MCP specification treats annotations as hints rather than guarantees, but defaults are pessimistic — a tool without annotations is assumed potentially destructive. [^411^]

#### 6.1.5 Layer 3 Implementation: PERT, Story Point Velocity, and COCOMO-Adapted Parametric Model

Layer 3 addresses the software estimation algorithms that constitute the primary differentiation of this server. The PERT (Program Evaluation and Review Technique) formula produces a weighted expected time from three-point estimates: $E = (O + 4M + P) / 6$, where $O$ is optimistic, $M$ most likely, and $P$ pessimistic. The Beta distribution weighting gives 4x emphasis to the most-likely estimate because it follows the Normal Distribution shape more accurately than simple triangular averaging. [^459^]

For story point conversion, the server accepts a velocity history array and computes a conversion factor: $\text{Conversion Factor} = \text{Total Sprint Hours} \div \text{Average Velocity}$. [^543^] Velocity should trend toward a horizontal average representing sustainable capacity; a velocity chart that shows constant increase usually reflects a process problem rather than genuine productivity growth. [^493^] The MCP tool recalculates this factor automatically when new sprint data is provided, enabling the LLM to maintain current estimates without manual arithmetic.

The COCOMO II implementation adapts Barry Boehm's parametric model for LLM-assisted development. The traditional formula, $\text{PM} = A \times \text{Size}^B \times \prod(\text{EM}_i)$, assumes human-labor-driven effort. [^457^] Our adaptation replaces the 17 human-oriented cost drivers with five LLM-specific factors identified in recent research: reasoning complexity (context window requirements), context completeness (amount of codebase the LLM must ingest), transformation impact (degree of architectural change), iterative cycles (expected tool-call loops), and human oversight ratio (fraction of time requiring human review). [^2^]

Monte Carlo simulation produces probabilistic completion dates rather than single-point estimates. The technique addresses "merge bias" — the phenomenon that the more predecessors an activity has, the less probable it is to start on time — which makes traditional CPM schedules systematically optimistic. [^537^] The server exposes a configurable iteration count (default 10,000) and returns P50, P80, and P95 completion dates.

#### 6.1.6 Error Handling and LLM-Friendly Messages

MCP distinguishes domain errors (returned with `isError: true` in the tool response, for the AI to handle) from protocol errors (thrown as exceptions, for the client to handle). [^10^] In FastMCP, exceptions are automatically caught and converted; `mask_error_details=True` prevents internal stack traces from leaking to the LLM context.

For time estimation, domain errors include "invalid timezone identifier," "unparseable natural language expression," and "insufficient velocity data for forecast" — each returned as structured JSON with `isError: true` and an actionable retry suggestion. Protocol errors include missing required parameters (handled by Pydantic validation before the tool function executes). FastMCP's flexible validation mode coerces string representations such as `"10"` to integers, which is essential because LLM clients frequently send stringified values where numbers are expected. [^3^]

The complete Python implementation below consolidates 11 tools across the first three layers using a registry-based dispatch pattern. This architecture reduces tool-definition context cost from potentially thousands of tokens to under 500, aligning with the Harness MCP v2 finding that registry dispatch cut context consumption from approximately 26% to approximately 1.6% of a 200K-token window. [^19^]

```python
# time_estimate_server.py — Python FastMCP implementation
# Requires: uv add "mcp[cli]" pendulum isodate workalendar python-dateutil

import json
import sys
import asyncio
from typing import Any
from datetime import datetime

import pendulum
import isodate
from dateutil import parser as date_parser
from workalendar.registry import registry
from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

mcp = FastMCP(
    "time-estimate-server",
    strict_input_validation=False,   # LLMs often send stringified values [^3^]
    mask_error_details=True,          # Hide internal stack traces [^10^]
)

# ── Layer 1: Core Temporal Primitives ──

@mcp.tool()
def get_current_time(timezone: str = "UTC") -> str:
    """Return current datetime in the requested timezone.

    Use this tool when the user asks "what time is it" or needs a
    timestamp anchored to now. Always provide an IANA timezone
    identifier such as America/New_York or Europe/Berlin.
    """
    try:
        now = pendulum.now(timezone)
        return json.dumps({
            "iso": now.to_iso8601_string(),
            "human": now.format("YYYY-MM-DD HH:mm:ss dddd"),
            "timezone": timezone,
            "utc_offset": now.format("Z"),
        })
    except Exception as e:
        return json.dumps({"isError": True, "message": f"Invalid timezone: {timezone}. Use IANA identifiers like 'America/New_York'."})

@mcp.tool()
def convert_timezone(timestamp: str, target_tz: str) -> str:
    """Convert an ISO-8601 timestamp to a different timezone."""
    try:
        dt = pendulum.parse(timestamp)
        converted = dt.in_timezone(target_tz)
        return json.dumps({
            "original": timestamp,
            "converted": converted.to_iso8601_string(),
            "target_tz": target_tz,
        })
    except Exception as e:
        return json.dumps({"isError": True, "message": str(e)})

@mcp.tool()
def parse_duration(duration_string: str) -> str:
    """Parse an ISO-8601 or natural-language duration into seconds and human-readable form.

    Examples:
      - ISO: P3Y6M4DT12H30M5S
      - Natural: 2h30m, 5 days, 1 week
    """
    try:
        # Try ISO 8601 first [^447^]
        duration = isodate.parse_duration(duration_string)
        total_seconds = int(duration.total_seconds())
    except Exception:
        # Fallback: pendulum interval parsing
        try:
            parts = duration_string.split()
            kwargs = {}
            for i in range(0, len(parts), 2):
                val = int(parts[i])
                unit = parts[i+1].lower()
                if unit in ("second", "seconds", "s"):
                    kwargs["seconds"] = val
                elif unit in ("minute", "minutes", "min", "m"):
                    kwargs["minutes"] = val
                elif unit in ("hour", "hours", "h"):
                    kwargs["hours"] = val
                elif unit in ("day", "days", "d"):
                    kwargs["days"] = val
                elif unit in ("week", "weeks", "w"):
                    kwargs["weeks"] = val
            pi = pendulum.interval(**kwargs)
            total_seconds = int(pi.total_seconds())
        except Exception:
            return json.dumps({"isError": True, "message": f"Could not parse duration: {duration_string}"})

    return json.dumps({
        "input": duration_string,
        "total_seconds": total_seconds,
        "human": pendulum.interval(seconds=total_seconds).invert().human_readable(),
    })

# ── Layer 2: Calendar Math ──

@mcp.tool()
def add_business_days(start_date: str, days: int, country: str = "US") -> str:
    """Add N business days to a date, excluding weekends and holidays.

    Country must be a workalendar registry key such as US, UK, FR, DE.
    """
    try:
        cal_class = registry.get(country.upper())
        if not cal_class:
            return json.dumps({"isError": True, "message": f"Unsupported country: {country}"})
        cal = cal_class()
        dt = pendulum.parse(start_date)
        result = cal.add_working_days(dt.date(), days)
        return json.dumps({
            "start": start_date,
            "days_added": days,
            "result": result.isoformat(),
            "country": country,
        })
    except Exception as e:
        return json.dumps({"isError": True, "message": str(e)})

@mcp.tool()
def count_business_days(start_date: str, end_date: str, country: str = "US") -> str:
    """Count business days between two dates, excluding weekends and holidays."""
    try:
        cal_class = registry.get(country.upper())
        if not cal_class:
            return json.dumps({"isError": True, "message": f"Unsupported country: {country}"})
        cal = cal_class()
        s = pendulum.parse(start_date).date()
        e = pendulum.parse(end_date).date()
        count = cal.get_working_days_delta(s, e)
        return json.dumps({
            "start": start_date,
            "end": end_date,
            "business_days": count,
            "country": country,
        })
    except Exception as e:
        return json.dumps({"isError": True, "message": str(e)})

# ── Layer 3: Software Estimation ──

@mcp.tool()
def pert_estimate(optimistic: float, most_likely: float, pessimistic: float,
                  unit: str = "hours") -> str:
    """Calculate PERT expected duration, variance, and standard deviation.

    Formula: E = (O + 4M + P) / 6 [^459^]
    Variance: ((P - O) / 6)^2
    """
    if not (0 < optimistic <= most_likely <= pessimistic):
        return json.dumps({
            "isError": True,
            "message": "Values must satisfy 0 < optimistic <= most_likely <= pessimistic."
        })
    expected = (optimistic + 4 * most_likely + pessimistic) / 6
    std_dev = (pessimistic - optimistic) / 6
    variance = std_dev ** 2

    return json.dumps({
        "optimistic": optimistic,
        "most_likely": most_likely,
        "pessimistic": pessimistic,
        "expected": round(expected, 2),
        "variance": round(variance, 2),
        "std_deviation": round(std_dev, 2),
        "confidence_95": round(expected + 2 * std_dev, 2),   # E + 2 sigma
        "confidence_99": round(expected + 3 * std_dev, 2),   # E + 3 sigma
        "unit": unit,
    })

@mcp.tool()
def story_point_forecast(backlog_points: float, velocity_history: list,
                         sprint_length_days: int = 14,
                         hours_per_sprint: int = 300) -> str:
    """Forecast sprint completion date from backlog size and historical velocity.

    velocity_history: list of story points completed per past sprint.
    Returns completion date, required sprints, and confidence intervals.
    """
    if not velocity_history:
        return json.dumps({"isError": True, "message": "velocity_history cannot be empty."})

    avg_velocity = sum(velocity_history) / len(velocity_history)
    if avg_velocity <= 0:
        return json.dumps({"isError": True, "message": "Average velocity must be > 0."})

    required_sprints = backlog_points / avg_velocity
    conversion_factor = hours_per_sprint / avg_velocity
    total_hours = backlog_points * conversion_factor

    # Simple variance from velocity history
    if len(velocity_history) > 1:
        mean_v = avg_velocity
        variance = sum((v - mean_v) ** 2 for v in velocity_history) / (len(velocity_history) - 1)
        std_v = variance ** 0.5
        pessimistic_sprints = backlog_points / max(avg_velocity - std_v, 0.1)
    else:
        pessimistic_sprints = required_sprints * 1.5   # 50% buffer with single data point

    return json.dumps({
        "backlog_points": backlog_points,
        "average_velocity": round(avg_velocity, 1),
        "required_sprints": round(required_sprints, 1),
        "pessimistic_sprints": round(pessimistic_sprints, 1),
        "hours_per_point": round(conversion_factor, 2),
        "total_hours": round(total_hours, 1),
        "completion_days": round(required_sprints * sprint_length_days),
        "sprint_length_days": sprint_length_days,
    })

@mcp.tool()
def cocomo_llm_estimate(kloc: float, reasoning_complexity: float = 1.0,
                       context_completeness: float = 1.0,
                       transformation_impact: float = 1.0,
                       iterative_cycles: float = 1.0,
                       human_oversight: float = 1.0) -> str:
    """LLM-adapted COCOMO II parametric estimate.

    kloc: estimated thousands of lines of code.
    Cost drivers (1.0 = nominal, range 0.5–2.0):
      - reasoning_complexity: context window / reasoning demands
      - context_completeness: fraction of codebase accessible to LLM
      - transformation_impact: degree of architectural change
      - iterative_cycles: expected tool-call / retry loops
      - human_oversight: fraction requiring human review
    """
    A, B = 2.94, 1.10   # COCOMO II Post-Architecture defaults [^457^]
    em_product = (reasoning_complexity * context_completeness *
                  transformation_impact * iterative_cycles * human_oversight)
    person_months = A * (kloc ** B) * em_product

    # LLM productivity factor: empirical data suggests 1.2–3.6x human speed
    # but with overhead from iterative cycles [^589^]
    llm_overhead = 1.0 + (iterative_cycles - 1.0) * 0.15
    adjusted_pm = person_months / max(1.5, 3.0 / llm_overhead)

    return json.dumps({
        "kloc": kloc,
        "person_months_nominal": round(person_months, 1),
        "person_months_llm_adjusted": round(adjusted_pm, 1),
        "effort_multipliers": {
            "reasoning_complexity": reasoning_complexity,
            "context_completeness": context_completeness,
            "transformation_impact": transformation_impact,
            "iterative_cycles": iterative_cycles,
            "human_oversight": human_oversight,
            "product": round(em_product, 3),
        },
        "assumptions": "LLM productivity factor derived from empirical agent benchmarks. Adjust for your team's actual velocity.",
    })

# ── Entry point ──

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

### 6.2 TypeScript Implementation

#### 6.2.1 Project Setup: package.json, TypeScript SDK, and Zod Schemas

The official TypeScript MCP SDK (`@modelcontextprotocol/sdk`, 45,829 npm dependents) implements the full MCP specification with support for stdio, Streamable HTTP, tools, resources, prompts, and sampling. [^399^] It requires Zod as a peer dependency for input validation; the SDK automatically converts Zod schemas to JSON Schema for the MCP protocol. [^5^]

A production-ready TypeScript project requires `tsconfig.json` with `module: "Node16"` and `moduleResolution: "Node16"` to handle the SDK's ESM/CJS dual packaging, plus `package.json` with `"type": "module"`. [^6^] The canonical setup command is `npm install @modelcontextprotocol/sdk zod` followed by `npm install -D typescript @types/node`.

#### 6.2.2 Equivalent Layer Implementations

The TypeScript implementation mirrors the Python server layer for layer. For temporal computation, the ecosystem offers `date-fns` (tree-shakeable, functional) and `moment` (legacy but widely understood). For business-day calculations, the `date-fns` add-on `date-fns-business-days` or a custom holiday registry replaces `workalendar`. For PERT and COCOMO, the formulas are identical — the implementation difference lies in schema definition and type safety.

The `McpServer.registerTool()` method accepts a configuration object with `description`, `inputSchema` (a Zod schema), and an async handler. The `description` field and per-parameter `.describe()` strings are the primary signals the LLM uses to decide when and how to invoke the tool. [^18^] Best practices include multi-line descriptions with use-case guidance, examples of when to use and when not to use, and error handling documentation.

The TypeScript equivalent below implements the same 11-tool surface as the Python server, using `date-fns` and `date-fns-tz` for temporal operations and Zod for input validation. It omits external API calls for brevity but preserves the full schema structure and error handling patterns.

```typescript
// src/index.ts — TypeScript McpServer implementation
// Requires: npm install @modelcontextprotocol/sdk zod date-fns date-fns-tz

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { format, addBusinessDays, differenceInBusinessDays } from "date-fns";
import { toZonedTime, formatInTimeZone } from "date-fns-tz";

const server = new McpServer({
  name: "time-estimate-server-ts",
  version: "1.0.0",
});

// ── Layer 1: Core Temporal ──

server.registerTool(
  "get_current_time",
  {
    description: `Return the current datetime in the requested timezone.

Use this tool when the user asks "what time is it" or needs a timestamp.
Provide an IANA timezone identifier such as America/New_York or Europe/Berlin.`,
    inputSchema: {
      timezone: z.string().default("UTC").describe("IANA timezone identifier (e.g., America/New_York)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ timezone }) => {
    try {
      const now = new Date();
      const zoned = toZonedTime(now, timezone);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            iso: now.toISOString(),
            human: formatInTimeZone(now, timezone, "yyyy-MM-dd HH:mm:ss EEEE"),
            timezone,
          }),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Invalid timezone: ${timezone}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "pert_estimate",
  {
    description: `Calculate PERT expected duration from three-point estimates.

Formula: E = (O + 4M + P) / 6. Returns expected value, variance,
standard deviation, and 95% / 99% confidence bounds.`,
    inputSchema: {
      optimistic: z.number().positive().describe("Optimistic duration estimate"),
      most_likely: z.number().positive().describe("Most likely duration estimate"),
      pessimistic: z.number().positive().describe("Pessimistic duration estimate"),
      unit: z.enum(["hours", "days", "weeks"]).default("hours").describe("Time unit"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ optimistic, most_likely, pessimistic, unit }) => {
    if (optimistic > most_likely || most_likely > pessimistic) {
      return {
        content: [{ type: "text", text: "Values must satisfy optimistic <= most_likely <= pessimistic." }],
        isError: true,
      };
    }
    const expected = (optimistic + 4 * most_likely + pessimistic) / 6;
    const stdDev = (pessimistic - optimistic) / 6;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          optimistic,
          most_likely,
          pessimistic,
          expected: Math.round(expected * 100) / 100,
          variance: Math.round(stdDev * stdDev * 100) / 100,
          std_deviation: Math.round(stdDev * 100) / 100,
          confidence_95: Math.round((expected + 2 * stdDev) * 100) / 100,
          confidence_99: Math.round((expected + 3 * stdDev) * 100) / 100,
          unit,
        }),
      }],
    };
  }
);

// ── Entry point ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);   // stderr only — never stdout [^11^]
  process.exit(1);
});
```

#### 6.2.3 Build and Deployment: tsc Verification and mcp-proxy for Transport Conversion

Build verification follows the standard TypeScript pipeline: `npm run build` (which invokes `tsc`) compiles `src/index.ts` to `dist/index.js`. For local development, the server runs directly via `node dist/index.js` with stdio transport. For remote deployment, `mcp-proxy` converts stdio to Streamable HTTP, enabling multi-client access and load distribution. [^16^]

Streamable HTTP is the modern standard for remote MCP servers, replacing the deprecated SSE transport. It uses a single endpoint (`/mcp`) with POST requests and optional SSE streaming, solving the dual-endpoint complexity and connection reliability issues of the legacy approach. [^17^] Production testing showed that 20 of 22 requests failed with SSE under just 20 simultaneous connections; Streamable HTTP handles multiple clients natively. [^16^]

The following table summarizes the layer-by-layer implementation decisions across both languages, including the primary library, key algorithm, and any LLM-specific adaptation applied.

| Layer | Tool Family | Python Library | TypeScript Library | Core Algorithm | LLM Adaptation |
|---|---|---|---|---|---|
| 1 | Core Temporal | `pendulum`, `isodate`, `dateparser` | `date-fns`, `date-fns-tz` | ISO 8601 parsing, timezone conversion, natural-language parsing | None — direct computation |
| 1 | Duration Arithmetic | `pendulum.interval` | `date-fns` interval | Add/subtract durations, human-readable formatting | Coerced string inputs accepted [^3^] |
| 2 | Business-Day Math | `workalendar` (80+ countries) [^600^] | Custom holiday registry + `date-fns` | Weekend exclusion, holiday-aware delta | DST transition error detection with `isError: true` [^10^] |
| 2 | Working-Hours Validation | `pendulum` range check | `date-fns` range check | Business-hours boundary detection | Returns categorical urgency cues alongside numeric output [^4^] |
| 3 | PERT Estimation | Native Python | Native TypeScript | Beta distribution: $E = (O + 4M + P) / 6$ [^459^] | Confidence intervals (95%, 99%) rather than point estimates |
| 3 | Story Point Forecast | Native Python | Native TypeScript | Velocity averaging, conversion factor [^543^] | Auto-recalculation on new sprint data; variance from history |
| 3 | COCOMO II | Native Python | Native TypeScript | $PM = A \times \text{Size}^B \times \prod(EM_i)$ [^457^] | 5 LLM-specific cost drivers replace 17 human-oriented drivers [^2^] |
| 3 | Monte Carlo (stub) | `random` module | `Math.random` | 10,000-iteration simulation [^532^] | Merge bias correction for multi-predecessor tasks [^537^] |

The table reveals a consistent implementation pattern: Layers 1 and 2 rely on mature temporal libraries where domain complexity (DST rules, holiday calendars, ISO 8601 edge cases) is already solved. Layer 3 implements estimation algorithms natively in both languages because the LLM-specific adaptations — particularly the five cost drivers in the COCOMO adaptation and the probabilistic confidence intervals — are not available in any existing library. The PERT and story-point tools are intentionally stateless: they accept all required data as parameters and return complete results, enabling the LLM to invoke them without maintaining server-side session state.

### 6.3 Testing and Validation

#### 6.3.1 MCP Inspector for Interactive Validation

The MCP Inspector (`npx @modelcontextprotocol/inspector`) is the official browser-based development tool for testing and debugging MCP servers. [^12^] It connects via stdio, SSE, or Streamable HTTP, lists available tools with their schemas, enables individual tool invocation with custom parameters, and displays protocol frames for debugging. For a time estimation server, the Inspector workflow is: start the server, connect the Inspector, verify `tools/list` returns all estimation tools, test each tool with sample inputs, and inspect error responses. [^12^]

A critical security consideration is CVE-2025-49596, a remote code execution vulnerability in older Inspector versions. [^27^] Always use the latest version; for testing untrusted servers, run the Inspector in a container or VM. The Inspector shows protocol messages but not internal server state, so it must be paired with stderr-based logging for full observability. [^11^]

#### 6.3.2 Automated Testing with pytest

The Python SDK provides `ClientSession` and `stdio_client` for building programmatic test clients. [^15^] The testing strategy for a time estimation server follows three levels: unit tests for pure estimation functions (PERT math, duration parsing), integration tests using `ClientSession` against a running server, and Inspector-based smoke tests before deployment. [^15^]

The pytest harness below demonstrates mock `ClientSession` testing for Layer 1 and Layer 3 tools. It uses `pytest-asyncio` for async test support and launches the server as a subprocess, communicating over stdin/stdout pipes.

```python
# tests/test_server.py — pytest automated testing harness

import pytest
import asyncio
import json
import subprocess
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SERVER_CMD = ["uv", "run", "python", "time_estimate_server.py"]

@pytest.fixture
async def session():
    params = StdioServerParameters(command=SERVER_CMD[0], args=SERVER_CMD[1:])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session

@pytest.mark.asyncio
async def test_tools_list(session):
    tools = await session.list_tools()
    names = [t.name for t in tools.tools]
    assert "get_current_time" in names
    assert "pert_estimate" in names
    assert "story_point_forecast" in names
    assert "add_business_days" in names

@pytest.mark.asyncio
async def test_pert_calculation(session):
    result = await session.call_tool("pert_estimate", arguments={
        "optimistic": 4,
        "most_likely": 8,
        "pessimistic": 16,
        "unit": "hours"
    })
    text = result.content[0].text
    data = json.loads(text)
    assert data["expected"] == 8.67   # (4 + 4*8 + 16) / 6
    assert data["std_deviation"] == 2.0
    assert data["confidence_95"] == 12.67

@pytest.mark.asyncio
async def test_domain_error_invalid_timezone(session):
    result = await session.call_tool("get_current_time", arguments={
        "timezone": "NotA_Real/Zone"
    })
    text = result.content[0].text
    data = json.loads(text)
    assert data.get("isError") is True
    assert "Invalid timezone" in data["message"]

@pytest.mark.asyncio
async def test_story_point_forecast(session):
    result = await session.call_tool("story_point_forecast", arguments={
        "backlog_points": 120,
        "velocity_history": [28, 32, 30, 35, 29],
        "sprint_length_days": 14,
        "hours_per_sprint": 320,
    })
    data = json.loads(result.content[0].text)
    assert data["average_velocity"] == 30.8
    assert data["required_sprints"] == pytest.approx(3.9, 0.1)
    assert "completion_days" in data
```

#### 6.3.3 Evaluation Harness: 10+ Complex Evaluation Questions

The mcp-builder skill from Anthropic defines a four-phase workflow for building MCP servers, with Phase 4 dedicated to creating evaluations. [^20^] Academic evaluation frameworks such as MCPBench measure accuracy, time consumption, and token consumption across standardized prompts. [^316^] For a time estimation server, evaluation must go beyond protocol compliance to verify that the server produces estimates that are accurate, actionable, and properly structured for LLM consumption.

The evaluation harness below defines 12 complex evaluation questions that satisfy six criteria: independent (each tests a distinct capability), read-only (no side effects), complex (multi-step reasoning), realistic (derived from actual developer scenarios), verifiable (expected answers can be computed independently), and stable (results do not depend on external state or current time). [^316^]

```python
# tests/evaluation_harness.py — comprehensive evaluation suite

import json
import asyncio
from dataclasses import dataclass
from typing import List
from test_server import session  # Reuses the ClientSession fixture

@dataclass
class EvalCase:
    id: str
    tool: str
    arguments: dict
    expected_keys: List[str]
    validator: callable   # function(result_dict) -> bool
    description: str

EVALUATION_SUITE = [
    EvalCase(
        id="E01",
        tool="get_current_time",
        arguments={"timezone": "UTC"},
        expected_keys=["iso", "human", "timezone", "utc_offset"],
        validator=lambda d: d["timezone"] == "UTC" and "T" in d["iso"],
        description="Basic current-time retrieval with IANA timezone",
    ),
    EvalCase(
        id="E02",
        tool="convert_timezone",
        arguments={"timestamp": "2026-06-15T09:00:00-04:00", "target_tz": "Europe/Berlin"},
        expected_keys=["original", "converted", "target_tz"],
        validator=lambda d: "15:00:00" in d["converted"] or "14:00:00" in d["converted"],
        description="DST-aware timezone conversion (EDT to CEST)",
    ),
    EvalCase(
        id="E03",
        tool="parse_duration",
        arguments={"duration_string": "P3DT12H30M"},
        expected_keys=["input", "total_seconds", "human"],
        validator=lambda d: d["total_seconds"] == 309_900,
        description="ISO 8601 duration parsing with mixed units",
    ),
    EvalCase(
        id="E04",
        tool="add_business_days",
        arguments={"start_date": "2026-12-23", "days": 5, "country": "US"},
        expected_keys=["start", "days_added", "result", "country"],
        validator=lambda d: d["result"] > "2026-12-30",  # Must skip Christmas
        description="Holiday-aware business-day addition (Christmas 2026)",
    ),
    EvalCase(
        id="E05",
        tool="count_business_days",
        arguments={"start_date": "2026-01-01", "end_date": "2026-01-15", "country": "US"},
        expected_keys=["start", "end", "business_days", "country"],
        validator=lambda d: d["business_days"] == 10,  # 15 days - New Year - 2 weekends
        description="Business-day count across New Year's holiday",
    ),
    EvalCase(
        id="E06",
        tool="pert_estimate",
        arguments={"optimistic": 2, "most_likely": 5, "pessimistic": 14, "unit": "days"},
        expected_keys=["expected", "variance", "std_deviation", "confidence_95", "confidence_99"],
        validator=lambda d: d["expected"] == 6.0 and d["std_deviation"] == 2.0,
        description="PERT Beta distribution with 95%/99% confidence bounds",
    ),
    EvalCase(
        id="E07",
        tool="pert_estimate",
        arguments={"optimistic": 10, "most_likely": 5, "pessimistic": 8, "unit": "hours"},
        expected_keys=["isError", "message"],
        validator=lambda d: d.get("isError") is True,
        description="Domain error on invalid PERT ordering (optimistic > most_likely)",
    ),
    EvalCase(
        id="E08",
        tool="story_point_forecast",
        arguments={"backlog_points": 100, "velocity_history": [20, 22, 18, 24, 21],
                     "sprint_length_days": 14, "hours_per_sprint": 280},
        expected_keys=["required_sprints", "hours_per_point", "completion_days"],
        validator=lambda d: 4.0 <= d["required_sprints"] <= 5.5,
        description="Velocity-based forecast with 5-sprint historical data",
    ),
    EvalCase(
        id="E09",
        tool="story_point_forecast",
        arguments={"backlog_points": 50, "velocity_history": [], "sprint_length_days": 14},
        expected_keys=["isError", "message"],
        validator=lambda d: d.get("isError") is True and "velocity_history" in d["message"].lower(),
        description="Error on empty velocity history — graceful failure",
    ),
    EvalCase(
        id="E10",
        tool="cocomo_llm_estimate",
        arguments={"kloc": 10.0, "reasoning_complexity": 1.2, "context_completeness": 0.9,
                   "transformation_impact": 1.0, "iterative_cycles": 1.3, "human_oversight": 0.8},
        expected_keys=["person_months_nominal", "person_months_llm_adjusted", "effort_multipliers"],
        validator=lambda d: d["person_months_llm_adjusted"] < d["person_months_nominal"],
        description="LLM-adjusted COCOMO with all 5 cost drivers applied",
    ),
    EvalCase(
        id="E11",
        tool="parse_duration",
        arguments={"duration_string": "3 business days"},
        expected_keys=["isError", "message"],
        validator=lambda d: d.get("isError") is True,
        description="Error on unsupported natural-language pattern (business days in duration parser)",
    ),
    EvalCase(
        id="E12",
        tool="add_business_days",
        arguments={"start_date": "2026-04-01", "days": 10, "country": "FR"},
        expected_keys=["result", "country"],
        validator=lambda d: "2026-04-" in d["result"] and d["country"] == "FR",
        description="French business-day calendar (Easter Monday handling)",
    ),
]

async def run_evaluation(session, suite: List[EvalCase]) -> dict:
    passed, failed = 0, 0
    results = []
    for case in suite:
        try:
            response = await session.call_tool(case.tool, arguments=case.arguments)
            text = response.content[0].text
            data = json.loads(text)

            # Check expected keys present
            keys_ok = all(k in data for k in case.expected_keys)
            # Run custom validator
            val_ok = case.validator(data) if keys_ok else False

            if keys_ok and val_ok:
                passed += 1
                results.append({"id": case.id, "status": "PASS", "desc": case.description})
            else:
                failed += 1
                results.append({"id": case.id, "status": "FAIL", "desc": case.description,
                               "keys_ok": keys_ok, "val_ok": val_ok, "data": data})
        except Exception as e:
            failed += 1
            results.append({"id": case.id, "status": "ERROR", "desc": case.description, "error": str(e)})

    return {"passed": passed, "failed": failed, "total": len(suite),
            "accuracy": round(passed / len(suite) * 100, 1), "details": results}

# Entry point for CI execution
if __name__ == "__main__":
    async def main():
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client
        params = StdioServerParameters(command="uv", args=["run", "python", "time_estimate_server.py"])
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                report = await run_evaluation(session, EVALUATION_SUITE)
                print(json.dumps(report, indent=2))
    asyncio.run(main())
```

#### 6.3.4 Metrics and Benchmarks

The evaluation suite above produces a quantitative accuracy score: the percentage of evaluation cases that pass both key presence and custom validation. Based on the MCPBench finding that MCP server accuracy varies widely — from 10% (DuckDuckGo) to 64% (Bing Web Search) — and the CData benchmark showing a 25-percentage-point gap between well-designed and poorly-designed connectivity layers, the following targets are established for the Time Estimation MCP Server. [^316^] [^318^]

| Metric | Target | Measurement Method | Rationale |
|---|---|---|---|
| Evaluation accuracy | > 80% | 12-case automated harness | MCPBench shows 64% is achievable for web search; time estimation is a narrower domain with deterministic algorithms, so 80% is conservative [^316^] |
| Average tool-call latency | < 500 ms | Median over 100 calls | Pure computation tools should complete in < 500 ms; external API calls (Jira, Toggl) may exceed this but should be cached |
| Token footprint per request | < 500 tokens | Tool definitions + response | Registry dispatch keeps tool definitions under 500 tokens; responses are JSON objects of 50–200 tokens [^19^] |
| Tool selection precision | > 90% | LLM correctly chooses tool in test prompts | Augmented tool descriptions improve agent efficiency; precision is measured by whether the LLM invokes the right tool on first attempt [^539^] |
| Error recovery rate | > 95% | Domain errors with retry guidance | With `isError: true` and actionable messages, the LLM should successfully retry > 95% of recoverable errors [^10^] |
| Evaluation question count | >= 10 | Independent test cases | The MCPBench framework evaluates across standardized prompts; 12 cases cover 6 distinct tool families with positive and negative tests [^316^] |

The 80% accuracy target is intentionally conservative. The algorithms implemented in Layers 1 and 2 (timezone conversion, business-day arithmetic, ISO 8601 parsing) are deterministic and should score near 100%. Layer 3 estimation introduces uncertainty — the PERT expected value is a weighted average, not a ground-truth oracle — so validation checks structural correctness rather than absolute accuracy. The CData benchmark demonstrated that "the connectivity layer between prompt and data source is where accuracy is determined," meaning that well-formed tool descriptions and schemas are as important as correct algorithms. [^318^] At 75% per-step accuracy across a 5-step workflow, fewer than 24% of processes complete correctly; therefore, each individual tool must exceed 90% precision to yield reliable multi-step results. [^318^]

For continuous integration, the evaluation harness should run on every commit. The pytest suite validates functional correctness; the evaluation harness validates LLM-facing behavior. Together they ensure that changes to estimation algorithms, error messages, or response schemas do not degrade the server's ability to serve as an external time-reasoning module for AI agents. The MCP ecosystem reached 97 million monthly SDK downloads and 10,000+ public servers by March 2026; a time estimation server that passes this evaluation framework can reliably join that ecosystem. [^396^]
