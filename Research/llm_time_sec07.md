# 7. Integration with Coding Agents and IDEs

The Time Estimation MCP Server delivers value only when it is reachable from the coding agents and frameworks developers use daily. This chapter maps the integration pathways from the server implementation in Chapter 6 to every major coding agent, IDE, and agent framework. The Model Context Protocol has become the de facto standard — 97 million monthly SDK downloads and 10,000+ public servers confirm its dominance [^396^] — meaning a single server build can serve Claude Code, Cursor, VS Code, Windsurf, Cline, and other clients with only configuration-level differences [^1^]. Each client introduces its own configuration syntax, transport preferences, tool limits, and security posture. Agent frameworks such as LangChain, AutoGen, LlamaIndex, and the OpenAI Agents SDK do not speak MCP natively; they require adapter layers or decorator-based wrappers. Finally, every integration must confront the same scarce resource: the LLM's context window. A poorly integrated server can consume 26% of available tokens before any real work begins [^19^]. This chapter addresses three questions: how to configure each client (§7.1), how to bridge each framework (§7.2), and how to keep the integration lightweight (§7.3).

### 7.1 MCP Client Configuration Patterns

MCP follows a strict host-client-server architecture: the host (Claude Code, Cursor, VS Code) creates one MCP client per connected server, and each client maintains a dedicated one-to-one connection [^25^]. The protocol supports stdio for local execution (~1 ms latency, no authentication) and Streamable HTTP for remote services (10–100 ms latency, OAuth 2.1 support) [^348^]. Because the protocol is open, the same server binary works across all compatible clients; only the host-side configuration file changes [^1^]. The subsections below document the exact configuration syntax, transport defaults, and practical limits for each major client.

#### 7.1.1 Claude Code: `claude mcp add-json` with `.mcp.json` configuration; stdio transport for local execution

Claude Code offers the most sophisticated MCP configuration system of any CLI agent, with three scopes — project, local, and user — controlled by where the configuration lives [^3^]. Project-scoped servers are declared in `.mcp.json` at the repository root; this file can be committed to version control. Local-scoped servers live in `~/.claude.json` and apply only to the current project on the current machine. User-scoped servers also live in `~/.claude.json` but apply globally across all projects.

For scripted setup, the `claude mcp add-json` command accepts raw JSON directly [^4^]:

```bash
claude mcp add-json time-estimator \
  '{"type":"http","url":"https://api.time-estimator.dev/mcp"}'
```

For local stdio execution — recommended for development because it avoids network latency — the syntax is:

```bash
claude mcp add --transport stdio time-estimator \
  -- python -m time_estimator_server
```

Claude Code also implements Anthropic's Tool Search feature, which dynamically loads only the tool definitions needed for each task. This reduces context consumption from roughly 72,000 tokens to about 8,700 tokens — an 85% reduction — and improves tool selection accuracy from 49% to 74% on Opus 4 [^5^]. Tool Search requires Sonnet 4 or later, or Opus 4 or later, and is enabled by default. For the Time Estimation MCP Server, Tool Search is the critical enabler: the server's tool definitions are loaded only when the agent is reasoning about time or effort, rather than on every prompt.

#### 7.1.2 Cursor: `.cursor/mcp.json` configuration; UI-based MCP marketplace

Cursor supports MCP through project-level `.cursor/mcp.json` or global `~/.cursor/mcp.json`, both using the same JSON schema [^10^]. Cursor's integrated MCP marketplace provides UI-based discovery, though manual configuration remains necessary for custom or self-hosted servers.

A critical constraint is the recommended limit of approximately 40 active tools across all connected servers [^10^]. Beyond this threshold, tool selection accuracy degrades as the context window fills with definitions. The Time Estimation MCP Server should therefore present a minimal surface — ideally one to three tools — when targeting Cursor users.

Security is another Cursor-specific concern. CVE-2025-54136 ("MCPoison") revealed that Cursor pinned trust to the MCP server's key name in the configuration file rather than to the actual command being executed [^10^]. Production Cursor deployments should use absolute binary paths and restricted permissions.

#### 7.1.3 VS Code: `.vscode/mcp.json` with extensions panel; host-client-server model

VS Code implements the full MCP specification and offers the most flexible integration surface of any IDE [^8^]. Servers can be added through: (a) web install URLs using `vscode:mcp/install?...` deeplinks; (b) workspace configuration in `.vscode/mcp.json`; (c) global user-profile configuration; (d) autodiscovery from Claude Desktop; (e) extensions registering servers programmatically via `vscode.lm.registerMcpServerDefinitionProvider`; or (f) command-line setup with `--add-mcp` [^8^][^9^].

The workspace-scoped `.vscode/mcp.json` is the pattern most teams should adopt, because it makes the server available automatically to anyone who opens the project. VS Code's host-client-server model aligns exactly with the MCP architecture: the Copilot Chat extension acts as the host, creates an MCP client, and maintains a stdio connection to the server process. Because VS Code also supports autodiscovery from Claude Desktop, developers who already configured the server in Claude Code will find it available in VS Code by enabling `"chat.mcp.discovery.enabled": true` [^35^].

#### 7.1.4 Windsurf, Cline, Roo Code, Continue.dev, Gemini CLI: configuration syntax variations and best practices

The remaining major clients each introduce a configuration dialect that server documentation must address.

**Windsurf** provides a built-in MCP Marketplace with one-click installation via `windsurf://windsurf-mcp-registry?serverName=...` deeplinks [^11^]. It supports all three transports and enforces a 100-tool total limit per Cascade session [^11^]. Configuration on macOS lives at `~/.codeium/windsurf/mcp_config.json` [^12^].

**Cline** supports natural-language MCP server building: pasting a GitHub repository URL causes Cline to clone, build, and register the server automatically [^14^]. Network timeout is configurable from 30 seconds to 1 hour, which matters for tools that analyze large codebases [^15^].

**Roo Code** can auto-generate MCP servers from natural language prompts [^13^]. For pre-built servers, Roo consumes VS Code's MCP settings and allows disabling MCP servers to remove all MCP-related logic from the system prompt, reducing token usage [^13^].

**Continue.dev** is the outlier: it uses YAML configuration files in `.continue/mcpServers/` rather than JSON [^16^][^17^].

**Gemini CLI** follows a pattern nearly identical to Claude Code's: `gemini mcp add --transport http time-estimator https://api.time-estimator.dev/mcp/` [^33^]. Configuration lives in `~/.gemini/settings.json`, with OAuth 2.0 for authenticated endpoints [^34^].

**Aider** is the notable exception. It connects directly to LLM APIs and does not implement MCP [^18^][^19^]. Aider users who want time estimation must either call a standalone CLI wrapper before invoking Aider, use the tool as a pre-processing step, or integrate at the LLM API layer via custom function calling.

Table 1 consolidates the configuration patterns, transport support, and tool limits for every client discussed above.

| Client | Config File / Command | Transports | Tool Limit | Scope | Key Constraint |
|---|---|---|---|---|---|
| Claude Code | `claude mcp add-json`; `.mcp.json` | stdio, HTTP, SSE | ~100 with Tool Search [^5^] | project / local / user | Tool Search requires Sonnet 4+ |
| Cursor | `.cursor/mcp.json` | stdio, HTTP, SSE | ~40 recommended [^10^] | project / global | CVE-2025-54136 path trust |
| VS Code + Copilot | `.vscode/mcp.json`; `--add-mcp` | stdio, HTTP, SSE | N/A | workspace / global / extension | Autodiscovery from Claude Desktop [^35^] |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | stdio, HTTP, SSE | 100 total [^11^] | global / marketplace | Deeplink one-click install |
| Cline | `.clinerules/` or UI | stdio, HTTP, SSE | N/A | project | 30s–1h timeout configurable [^15^] |
| Roo Code | VS Code MCP settings | stdio, HTTP, SSE | N/A | project | Auto-generation from natural language [^13^] |
| Continue.dev | `.continue/mcpServers/*.yaml` | stdio, SSE, streamable-http | N/A | workspace | YAML syntax [^16^] |
| Gemini CLI | `~/.gemini/settings.json`; `gemini mcp add` | stdio, SSE, HTTP | N/A | global | OAuth 2.0 support [^34^] |
| Aider | N/A (no MCP support) [^18^] | N/A | N/A | N/A | Requires CLI wrapper or pre-processing |

The table reveals two structural patterns. First, JSON-based configuration dominates six of eight MCP-capable clients, with Continue.dev's YAML and Gemini CLI's settings JSON as exceptions. Documentation should lead with JSON and provide YAML as a secondary format. Second, tool limits vary by an order of magnitude: Cursor's ~40-tool ceiling is the tightest constraint, while Windsurf's 100-tool limit and Claude Code's Tool Search effectively remove the limit. A server targeting universal compatibility should expose no more than three discrete tools, consolidating related operations behind parameters rather than separate endpoints.

### 7.2 Agent Framework Integration

Coding agents and IDEs consume MCP servers directly. Agent frameworks — LangChain, AutoGen, LlamaIndex, OpenAI Agents SDK — do not. They provide their own abstractions for tool definition, binding, and execution, and an MCP server must be wrapped or bridged to fit each. The subsections below document the exact integration pattern for each framework.

#### 7.2.1 LangChain: `@tool` decorator + `model.bind_tools()` pattern for tool binding

LangChain's tool integration centers on the `@tool` decorator, which wraps a Python function with automatic schema inference from type hints and docstrings, and on `model.bind_tools(tools)`, which attaches the tool set to a chat model [^21^][^22^]. A ReAct agent built in LangGraph follows a think-act-observe loop: the model receives the user query, reasons about which tool to call, executes it, observes the result, and repeats until the task completes [^29^].

For the Time Estimation MCP Server, there are two integration paths. The first is to wrap the MCP server's tools as LangChain `@tool` functions using an MCP client library. The second — simpler for teams already using LangChain — is to implement the estimation logic as a native `@tool` and bypass MCP entirely. The `@tool` docstring is critical: it is what the LLM "reads" to decide when to invoke the function. For time estimation, the docstring must explicitly mention "time," "duration," "effort," or "estimate" so that the model recognizes the tool's relevance to planning queries [^23^].

#### 7.2.2 AutoGen: `McpWorkbench` + `StreamableHttpServerParams` for multi-agent coordination

Microsoft's AutoGen framework supports MCP through `autogen-ext-tools` and the `McpWorkbench` class [^20^]. The pattern is to instantiate `StreamableHttpServerParams` with the server URL and credentials, wrap it in a `McpWorkbench` context manager, and pass the workbench to an `AssistantAgent`:

```python
from autogen_ext.tools.mcp import McpWorkbench, StreamableHttpServerParams

server_params = StreamableHttpServerParams(
    url="https://api.time-estimator.dev/mcp",
    timeout=30.0,
    sse_read_timeout=300.0,
    headers={"x-api-key": os.getenv("TIME_ESTIMATOR_API_KEY")}
)

async with McpWorkbench(server_params) as workbench:
    agent = AssistantAgent(
        name="estimator_planner",
        model_client=model_client,
        workbench=workbench,
        max_tool_iterations=10
    )
```

The `McpWorkbench` pattern is particularly powerful for multi-agent coordination because multiple AutoGen agents can share the same MCP server connection. A planner agent can call the time estimation tool to build a schedule, a coder agent can re-estimate after discovering complexity, and a reviewer agent can validate deadlines — all through the same workbench instance [^20^].

#### 7.2.3 LlamaIndex: `FunctionTool.from_defaults()` for query engine integration

LlamaIndex provides `FunctionTool.from_defaults(fn, name=...)` to wrap any Python callable as an agent-accessible tool [^23^][^24^]. The Hugging Face Agents Course emphasizes that "defining a clear set of Tools is crucial to performance... clear tool interfaces are easier for LLMs to use" [^23^]. This is especially true in LlamaIndex, where tools are often composed into query engines that chain multiple retrieval and computation steps. The `name` and `description` parameters are what the LLM sees; they should be specific and action-oriented. A generic name like "time_tool" is less likely to be selected than "estimate_task_time" when the agent is reasoning about project planning [^41^].

#### 7.2.4 OpenAI Agents SDK: `activity_as_tool` helper for tool registration

The OpenAI Agents SDK (formerly Assistants API) uses function calling with JSON Schema metadata: the developer defines the tool's name, description, and input schema, and the LLM decides when to request invocation [^25^]. The actual execution happens on the client side, not within OpenAI's infrastructure. The `activity_as_tool` helper bridges this pattern by converting an activity definition into a tool binding compatible with the Agents SDK runtime.

For the Time Estimation MCP Server, the integration requires an OpenAI-compatible client wrapper that translates between the MCP protocol and the Agents SDK's function-calling format. The wrapper exposes the server's tool definitions as JSON Schema and routes the LLM's function-call requests to the MCP server via HTTP.

Table 2 compares the four frameworks on integration pattern, transport handling, multi-agent support, and the specific class or decorator responsible for tool binding.

| Framework | Integration Pattern | Transport Handling | Multi-Agent Support | Tool Binding Primitive | MCP Native |
|---|---|---|---|---|---|
| LangChain / LangGraph | `@tool` decorator + `bind_tools()` | Client-managed (stdio/SSE/HTTP via adapter) | Yes, via LangGraph state machine | `model.bind_tools(tools)` [^21^] | Via adapter |
| AutoGen | `McpWorkbench` context manager | `StreamableHttpServerParams` [^20^] | Yes, shared `workbench` across agents | `AssistantAgent(workbench=...)` [^20^] | Yes, via `autogen-ext-tools` |
| LlamaIndex | `FunctionTool.from_defaults()` | Client-managed via transport wrapper | Yes, via `QueryEngineTool` chaining | `FunctionTool.from_defaults(fn)` [^23^] | Via wrapper |
| OpenAI Agents SDK | JSON Schema function calling | HTTP/SSE client wrapper | Yes, via agent orchestration | `activity_as_tool` helper | Via wrapper |

The comparison reveals that only AutoGen offers first-class, native MCP integration through `McpWorkbench`; the other three frameworks require adapter or wrapper layers. For production deployments, this means teams should budget implementation time for the wrapper layer, or they should choose AutoGen if MCP-native consumption is a hard requirement. All four frameworks share a common design principle: the tool's name and description are the interface the LLM reasons about, and their clarity directly determines selection accuracy [^23^][^41^].

**Integration architecture diagram.** Figure 7.1 depicts the complete integration topology. At the center, the Time Estimation MCP Server exposes a Streamable HTTP endpoint (or stdio for local use) with a registry-based dispatch layer (see §7.3.1). On the left, MCP-native clients — Claude Code, Cursor, VS Code, Windsurf, Cline, Gemini CLI — connect directly via their respective MCP client implementations, each using the host-client-server model. On the right, agent frameworks connect through adapter layers: AutoGen's `McpWorkbench` consumes the server natively; LangChain, LlamaIndex, and the OpenAI Agents SDK each use a thin wrapper translating between MCP protocol messages and the framework's internal tool representation. A Supergateway bridge [^37^] sits between local stdio servers and remote HTTP consumers. All connections converge on the same server binary, validating MCP's "build once, use everywhere" value proposition [^1^].

### 7.3 Context Window Optimization

Every tool definition loaded into an MCP client consumes tokens from the context window before any user prompt is processed. For a time estimation server, the challenge is twofold: schemas must be descriptive enough for correct selection, yet compact enough to avoid crowding out code, conversation history, and reasoning traces.

#### 7.3.1 Token footprint reduction: 11 tools at ~3,150 tokens (Harness v2 pattern) vs 175 tools at ~26% context window

The Harness engineering team documented the most influential case study in MCP context optimization. Their first server exposed 130+ individual tools and consumed roughly 26% of a 200,000-token context window [^19^]. Their v2 redesign consolidated these into 11 registry-dispatched tools, cutting consumption to approximately 1.6% [^19^]. The key insight was to separate *what* the LLM wants to do from *how* the server executes it: the LLM selects a generic operation and provides a resource type parameter; the server looks up the type in an internal registry and dispatches to the correct endpoint.

For the Time Estimation MCP Server, this pattern translates directly. Rather than exposing separate tools for `estimate_simple_task`, `estimate_complex_task`, `estimate_with_history`, and so on, the server should expose a single `estimate_time` tool with a `mode` or `method` parameter. The token savings are substantial: GitHub's official MCP server consumes 17,600 tokens of tool definitions per request, and connecting multiple servers can push pre-work metadata to 30,000+ tokens [^319^]. Atlassian's `mcp-compressor` proxy demonstrates that aggressive schema compression can reduce this by up to 97%, but over-compression hurts tool selection accuracy [^319^].

The practical target for the Time Estimation MCP Server should be under 500 tokens for all tool definitions combined. A single tool with a clear name, a one-sentence description, and a compact JSON Schema for five to seven parameters typically lands in the 250–400 token range [^6^].

#### 7.3.2 Tool Search annotation (Anthropic): reduces context consumption by ~85% (72K → 8.7K tokens)

Anthropic's Tool Search, available in Claude Code and Claude Desktop, changes the optimization equation entirely. Instead of loading all tool definitions from all connected servers on every turn, Tool Search indexes the available tools and loads only those whose descriptions match the current task [^5^]. The measured reduction is from ~72,000 tokens to ~8,700 tokens — an 85% reduction [^5^]. Tool selection accuracy improves simultaneously, from 49% to 74% on Opus 4 [^5^].

Tool Search is not universal. Cursor, VS Code (as of mid-2026), and the agent frameworks lack equivalent mechanisms. The recommended dual strategy is: (a) design for the lowest-common-denominator client (Cursor's ~40-tool ceiling) so the server is universally lightweight; and (b) take advantage of Tool Search in Claude Code by providing rich, searchable tool descriptions.

A competing approach, Stacklok's MCP Optimizer, claims 94% tool selection accuracy versus Anthropic's Tool Search at 34% when tested against 2,792 tools [^41^]. The discrepancy likely stems from different test methodologies — Stacklok uses semantic embeddings, while Tool Search relies on description keyword indexing. For a small server with three or fewer tools, the difference is negligible.

#### 7.3.3 Progressive disclosure: summary information by default, detailed exploration on request

Even with compact tool definitions, the *output* of a time estimation tool can bloat the context window on subsequent turns. A detailed PERT analysis with optimistic, pessimistic, and most-likely estimates, confidence intervals, historical comparisons, and risk factors can easily return 2,000–3,000 tokens of structured JSON. When this output is fed back into the context as a tool result, it consumes space that could otherwise hold code, conversation history, or reasoning traces.

The progressive disclosure pattern addresses this by returning a minimal summary by default and exposing a separate tool (or a `detail_level` parameter) for full exploration. The default response should be a single sentence — "Estimated 2.5 hours (medium confidence)" — perhaps 20–30 tokens. If the agent needs the full breakdown, it invokes the tool again with `detail_level: "full"`.

This pattern also aligns with the finding that qualitative, categorical time signals are more actionable for LLMs than precise numeric countdowns [^5^]. A categorical summary ("short task — under 1 hour," "medium — 1–4 hours," "large — over 4 hours") is both more compact and more legible to the LLM than a floating-point hour estimate. The LLM should *request* time calculations, not *perform* them; the server should provide structured, categorical outputs that the LLM can reason about without arithmetic.

Production agents need explicit budget guardrails: loop limits, tool-call caps, token budgets, wall-clock timeouts, and tenant budgets [^31^]. A well-designed agent "has a budget contract the way a well-run service has an SLO" [^31^]. The Time Estimation MCP Server should be engineered to never trigger these guardrails: responses should be sub-second, outputs should be compact, and the server should be stateless so it can be called repeatedly without accumulating session state. Claude Code's own token budget system uses three mechanisms — hard internal limits, automatic context compaction, and pre-execution budget checks — with compaction reducing context size by 60–80% on long-running sessions [^32^]. By keeping both schema and output minimal, the Time Estimation MCP Server ensures it is a net contributor to agent capability rather than a net consumer of context budget.
