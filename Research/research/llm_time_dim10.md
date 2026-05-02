# Dimension 10: Implementation Guide — Building Time Estimation MCP Server

## Research Date: 2026-06-28
## Scope: Complete technical implementation details for building an MCP server in Python (FastMCP / official SDK) and TypeScript (official MCP SDK), specifically oriented toward time estimation capabilities.

---

## 1. Dimension Overview and Scope

This research dimension covers the complete technical implementation path for building an MCP server that exposes **time estimation capabilities** — e.g., estimating task duration, parsing natural-language time expressions, converting timezones, and computing time deltas. The scope spans:

- **Python implementations**: FastMCP (high-level) vs. official `mcp` SDK (low-level `Server` class)
- **TypeScript implementations**: `McpServer` (high-level) vs. `Server` (low-level)
- **Input validation**: Pydantic (Python) and Zod (TypeScript)
- **Transport modes**: stdio, SSE (deprecated), Streamable HTTP
- **Error handling, logging, debugging, testing, deployment, auth, rate limiting**
- **Tool description best practices, annotations, and structured output**
- **Existing open-source time-related MCP servers as reference implementations**

---

## 2. Key Findings with Evidence Blocks

### 2.1 Python: FastMCP as the High-Level Framework

**Claim**: FastMCP provides a decorator-based API (`@mcp.tool()`, `@mcp.resource()`, `@mcp.prompt()`) that dramatically reduces boilerplate compared to the low-level `Server` class, and is the recommended starting point for Python MCP servers. [^1^]

**Source**: MCP Python SDK — Official Repository  
**URL**: https://github.com/modelcontextprotocol/python-sdk  
**Date**: 2026-04-02  
**Excerpt**:
```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Demo")

@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two numbers"""
    return a + b

@mcp.resource("greeting://{name}")
def get_greeting(name: str) -> str:
    """Get a personalized greeting"""
    return f"Hello, {name}!"

@mcp.prompt()
def greet_user(name: str, style: str = "friendly") -> str:
    """Generate a greeting prompt"""
    styles = {
        "friendly": "Please write a warm, friendly greeting",
        "formal": "Please write a formal, professional greeting",
    }
    return f"{styles.get(style, styles['friendly'])} for someone named {name}."
```

**Context**: FastMCP infers metadata (name, description) from function names and docstrings, supports type annotations for automatic JSON Schema generation, and handles capability negotiation automatically.  
**Confidence**: High

---

### 2.2 FastMCP Calculator Example — Direct Pattern for Time Estimation Tools

**Claim**: A calculator-style MCP server built with FastMCP demonstrates the exact pattern needed for time estimation: a unified tool that routes to specific operations, with Pydantic-based input validation, error handling, and stdio transport. [^2^]

**Source**: MCP Course — Calculator Python Server  
**URL**: https://alexyslozada-mcp-course-71.mintlify.app/servers/calculator-python  
**Date**: 2026-03-04  
**Excerpt**:
```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Calculator MCP Server")

@mcp.tool()
def calculate(a: float, b: float, operation: str) -> float:
    """Perform arithmetic operations on two numbers.

    Args:
        a: First number
        b: Second number
        operation: Operation to perform (add, subtract, multiply, divide)

    Returns:
        Result of the calculation

    Raises:
        ValueError: If operation is invalid or division by zero
    """
    if operation == "add":
        return add(a, b)
    elif operation == "subtract":
        return subtract(a, b)
    elif operation == "multiply":
        return multiply(a, b)
    elif operation == "divide":
        return divide(a, b)
    else:
        raise ValueError("Operación no válida")

if __name__ == "__main__":
    mcp.run(transport='stdio')
```

**Context**: This pattern maps directly to a time-estimation server: one `estimate_time` tool that routes to sub-operations (e.g., `parse_natural_language`, `compute_duration`, `convert_timezone`).  
**Confidence**: High

---

### 2.3 FastMCP Input Validation — Strict vs. Flexible Modes

**Claim**: FastMCP uses Pydantic for input validation with two modes: flexible (default, coerces string representations like `"10"` to integers) and strict (`strict_input_validation=True`, rejects any type mismatch). The flexible mode is recommended for LLM clients that commonly send stringified values. [^3^]

**Source**: GoFastMCP — Tools Documentation  
**URL**: https://gofastmcp.com/servers/tools  
**Date**: Unknown (current as of 2026)  
**Excerpt**:
```python
# Enable strict validation for this server
mcp = FastMCP("StrictServer", strict_input_validation=True)

@mcp.tool
def add_numbers(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b

# With strict_input_validation=True, sending {"a": "10", "b": "20"} will fail
# With strict_input_validation=False (default), it will be coerced to integers
```

**Context**: For a time estimation server receiving natural-language inputs (e.g., `"2 hours"`), flexible validation is essential because LLMs frequently send strings where numbers or enums are expected.  
**Confidence**: High

---

### 2.4 Python SDK Low-Level Server vs. FastMCP

**Claim**: The official `mcp` Python SDK provides both a high-level `FastMCP` class and a low-level `Server` class. The low-level API requires manual handler registration (`@server.list_tools()`, `@server.call_tool()`, etc.) and explicit capability declaration, but offers full protocol control including lifespan management, structured output validation, and custom protocol extensions. [^4^]

**Source**: MCP Python SDK — README / Low-Level Server Examples  
**URL**: https://github.com/modelcontextprotocol/python-sdk  
**Date**: 2026-04-02  
**Excerpt**:
```python
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.models import InitializationOptions

server = Server("example-server")

@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="query_db",
            description="Query the database",
            inputSchema={
                "type": "object",
                "properties": {"query": {"type": "string", "description": "SQL query to execute"}},
                "required": ["query"],
            },
        )
    ]

@server.call_tool()
async def query_db(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    if name != "query_db":
        raise ValueError(f"Unknown tool: {name}")
    ctx = server.request_context
    db = ctx.lifespan_context["db"]
    results = await db.query(arguments["query"])
    return [types.TextContent(type="text", text=f"Query results: {results}")]
```

**Context**: The low-level server is needed for production scenarios requiring lifespan context (e.g., database connection pools), structured output schemas, and `CallToolResult` with `_meta` fields. FastMCP 2.0 may also support these, but the low-level API is the guaranteed path.  
**Confidence**: High

---

### 2.5 TypeScript: Official SDK `McpServer` with Zod Validation

**Claim**: The official TypeScript MCP SDK uses `McpServer` as the high-level API, with `registerTool()` accepting Zod schemas for automatic input validation and JSON Schema conversion. Tool descriptions and parameter `.describe()` strings are what the LLM reads to decide when and how to use tools. [^5^]

**Source**: Blog — MCP TypeScript SDK Complete Guide  
**URL**: https://blog.agentailor.com/posts/mcp-typescript-sdk-complete-guide  
**Date**: 2026-03-18  
**Excerpt**:
```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const server = new McpServer({ name: 'file-server', version: '1.0.0' })

server.registerTool(
  'read_file',
  {
    description: `Read the contents of a file from the filesystem.

Use this tool when you need to:
- Examine source code or configuration files
- Read log files for debugging
- Access any text-based file`,
    inputSchema: {
      path: z.string().describe('Absolute path to the file to read'),
      encoding: z.enum(['utf-8', 'ascii', 'base64']).default('utf-8').describe('File encoding to use'),
    },
  },
  async ({ path, encoding }) => {
    const content = await fs.readFile(path, encoding)
    return { content: [{ type: 'text', text: content }] }
  }
)
```

**Context**: The TypeScript SDK automatically converts Zod schemas to JSON Schema for the MCP protocol. The `description` field and per-parameter `.describe()` are critical for LLM tool selection accuracy.  
**Confidence**: High

---

### 2.6 TypeScript: Complete Server Setup with package.json

**Claim**: A production-ready TypeScript MCP server requires `tsconfig.json` with `module: "Node16"`, `package.json` with `"type": "module"`, and the official `@modelcontextprotocol/sdk` plus `zod` as core dependencies. [^6^]

**Source**: Medium — Build Your First MCP Server with Plain and TypeScript  
**URL**: https://thecraftman.medium.com/build-your-first-mcp-server-with-plain-and-typescript-6dd13494b95e  
**Date**: 2026-01-11  
**Excerpt**:
```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}

// package.json
{
  "name": "plain-mcp-server",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  }
}
```

**Installation**:
```bash
npm install @modelcontextprotocol/sdk zod
npm install -D typescript @types/node
```

**Context**: This is the canonical TypeScript MCP server setup. The `Node16` module resolution is required for the SDK's ESM/CJS dual packaging.  
**Confidence**: High

---

### 2.7 Python Project Setup: pyproject.toml with uv

**Claim**: Modern Python MCP projects use `uv` for dependency management and `pyproject.toml` for packaging. The core dependency is `mcp[cli]` which includes FastMCP and CLI tools (`mcp dev`, `mcp install`). [^7^]

**Source**: CircleCI Blog — Building and Deploying a Python MCP Server with FastMCP  
**URL**: https://circleci.com/blog/building-and-deploying-a-python-mcp-server-with-fastmcp/  
**Date**: 2025-10-07  
**Excerpt**:
```toml
[build-system]
requires = ["setuptools>=61.0", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "mcp-document-brain"
version = "0.1.1"
description = "MCP server for converting files to markdown"
readme = "README.md"
requires-python = ">=3.12"
dependencies = [
    "mcp[cli]>=1.8.0",
    "Markitdown[all]>=0.1.1",
]

[project.optional-dependencies]
dev = [
    "build>=1.2.2.post1",
    "pytest>=8.3.5",
    "twine>=6.1.0",
]

[project.scripts]
mcp-document-brain = "document_brain.server:main"

[tool.setuptools]
package-dir = {"" = "src"}
```

**Context**: `mcp[cli]` is the single dependency needed for FastMCP servers. `uv add "mcp[cli]"` is the fastest setup path. Entry-point scripts in `[project.scripts]` make the server runnable via CLI after `pip` or `uv` installation.  
**Confidence**: High

---

### 2.8 Async Patterns — FastMCP is Built on asyncio

**Claim**: FastMCP servers are built on async Python. The framework provides both synchronous `run()` and asynchronous `run_async()` APIs. In async contexts (e.g., existing ASGI apps), `run_async()` should be used. [^8^]

**Source**: GoFastMCP — Running Your Server  
**URL**: https://gofastmcp.com/deployment/running-server  
**Date**: Unknown (current)  
**Excerpt**:
```python
from fastmcp import FastMCP
import asyncio

mcp = FastMCP(name="MyServer")

@mcp.tool
def hello(name: str) -> str:
    return f"Hello, {name}!"

async def main():
    await mcp.run_async(transport="http", port=8000)

if __name__ == "__main__":
    asyncio.run(main())
```

**Context**: For time estimation tools that may call external APIs (timezone databases, calendar services), async handlers are essential to avoid blocking the event loop. FastMCP supports both sync and async tool functions.  
**Confidence**: High

---

### 2.9 MCP stdio Server Entry Point Pattern

**Claim**: The canonical entry point for a stdio MCP server is `if __name__ == "__main__": mcp.run(transport="stdio")` (Python) or `async function main() { const transport = new StdioServerTransport(); await server.connect(transport); }` (TypeScript). [^9^]

**Source**: MCP Python SDK — Direct Execution Example  
**URL**: https://github.com/modelcontextprotocol/python-sdk  
**Date**: 2026-04-02  
**Excerpt**:
```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("My App")

@mcp.tool()
def hello(name: str = "World") -> str:
    """Say hello to someone."""
    return f"Hello, {name}!"

def main():
    mcp.run()

if __name__ == "__main__":
    main()
```

**Source**: Anthropic Skills — Node/TypeScript MCP Server Implementation Guide  
**URL**: https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/node_mcp_server.md  
**Date**: Unknown  
**Excerpt**:
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "service-mcp-server", version: "1.0.0" });
// Register tools...

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
```

**Context**: stdio is the default transport for local development and Claude Desktop integration. The server must never write non-JSON-RPC data to stdout.  
**Confidence**: High

---

### 2.10 Error Handling Patterns — Domain vs. Protocol Errors

**Claim**: MCP distinguishes two error types: **domain errors** (returned with `isError: true` in the tool response, for the AI to handle) and **protocol errors** (thrown as `McpError` / `ToolError`, for the client to handle). In FastMCP, exceptions are automatically caught and converted; `mask_error_details=True` hides internal details. [^10^]

**Source**: GoFastMCP — Error Handling  
**URL**: https://gofastmcp.com/servers/tools  
**Date**: Unknown  
**Excerpt**:
```python
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

mcp = FastMCP(name="SecureServer", mask_error_details=True)

@mcp.tool
def divide(a: float, b: float) -> float:
    if b == 0:
        raise ToolError("Division by zero is not allowed.")
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        raise TypeError("Both arguments must be numbers.")
    return a / b
```

**Source**: Medium — MCP TypeScript SDK Complete Guide  
**URL**: https://techwithibrahim.medium.com/the-mcp-typescript-sdk-a-complete-guide-to-tools-resources-prompts-and-beyond-285c6ad05a07  
**Date**: 2026-04-06  
**Excerpt**:
```typescript
// Domain error — AI should retry or inform user
return {
  content: [{ type: "text", text: `User "${userId}" not found.` }],
  isError: true,
}

// Protocol error — client should handle
throw new McpError(ErrorCode.InvalidParams, "Division by zero is not allowed")
```

**Context**: For time estimation, domain errors include "invalid timezone" or "unparseable natural language expression" (return as `isError: true`). Protocol errors include missing required parameters (throw `McpError` / `ValueError`).  
**Confidence**: High

---

### 2.11 Logging and Debugging — Never Use console.log / print to stdout

**Claim**: For stdio-based MCP servers, writing to stdout corrupts the JSON-RPC stream. All logging must go to stderr (`console.error()` in TypeScript, `sys.stderr` in Python) or use MCP's structured logging notifications. The MCP Inspector is the official debugging tool but has significant limitations. [^11^]

**Source**: MCP Official Docs — Debugging  
**URL**: https://modelcontextprotocol.io/docs/tools/debugging  
**Date**: 2025-11-25  
**Excerpt**:
> "When building MCP servers, be careful about how you handle logging: For STDIO-based servers: Never use `console.log()`, as it writes to standard output (stdout). Writing to stdout will corrupt the JSON-RPC messages and break your server."

**Source**: Apigene — MCP Inspector: Debug and Test Your MCP Servers  
**URL**: https://apigene.ai/blog/mcp-inspector  
**Date**: 2026-03-26  
**Excerpt**:
> "MCP Inspector shows protocol frames, not your app logs. Because stdio servers use stdout for the protocol, `console.log` breaks the JSON-RPC stream. Inspector shows messages but not what's happening inside your server."

**Context**: The recommended debugging stack is: (1) MCP Inspector for protocol validation, (2) `stderr`/file logging for internal state, (3) custom JSON-RPC harnesses for automated testing, and (4) gateway proxies for production observability.  
**Confidence**: High

---

### 2.12 MCP Inspector — Official Testing and Validation Tool

**Claim**: The MCP Inspector (`npx @modelcontextprotocol/inspector`) is the official development tool for testing MCP servers. It connects as a test client, validates protocol compliance, lists tools/resources/prompts, and enables individual tool testing. However, it cannot observe real client traffic (Claude Desktop, Cursor) and has a critical CVE (CVE-2025-49596) affecting older versions. [^12^]

**Source**: MCP Official Docs — Inspector  
**URL**: https://modelcontextprotocol.io/docs/tools/inspector  
**Date**: 2026-03-25  
**Excerpt**:
> "The Inspector provides several features for interacting with your MCP server: Server connection pane (stdio or Streamable HTTP), Resources tab, Prompts tab, Tools tab (shows schemas, enables testing), Notifications pane."

**Source**: Apigene — MCP Inspector Guide  
**URL**: https://apigene.ai/blog/mcp-inspector  
**Date**: 2026-03-26  
**Excerpt**:
> "CVE-2025-49596 is a critical RCE vulnerability in MCP Inspector. If you're running an older version, update immediately or use an alternative mcp tester."

**Context**: For a time estimation server, the Inspector workflow is: (1) start server, (2) connect Inspector, (3) verify `tools/list` returns the estimation tools, (4) test each tool with sample inputs, (5) check error responses.  
**Confidence**: High

---

### 2.13 Resource Implementation — URI Templates

**Claim**: MCP resources are identified by URIs. Dynamic resources use URI templates (e.g., `person://properties/{name}`). In TypeScript, use `ResourceTemplate` from the SDK. In Python FastMCP, use `@mcp.resource("resource://{param}")` and the function parameter name maps to the placeholder. [^13^]

**Source**: MCP Course — Resources  
**URL**: https://www.mintlify.com/alexyslozada/mcp-course/concepts/resources  
**Date**: 2026-03-04  
**Excerpt**:
```typescript
server.resource(
  "person-properties",
  new ResourceTemplate("person://properties/{name}", { list: undefined }),
  async (uri, { name }) => {
    const person = personData[name];
    if (!person) {
      throw new Error(`Person with name ${name} not found`);
    }
    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify(person),
        mimeType: "application/json"
      }]
    };
  }
);
```

**Source**: GoFastMCP — Resources & Templates  
**URL**: https://gofastmcp.com/servers/resources  
**Date**: Unknown  
**Excerpt**:
```python
@mcp.resource("data://app-status")
def get_application_status() -> str:
    """Provides the current status of the application."""
    return json.dumps({"status": "ok", "uptime": 12345})
```

**Context**: For time estimation, a resource like `timezones://list` could expose available timezone data, while `time://{timezone}` could expose current time for a specific zone.  
**Confidence**: High

---

### 2.14 Prompt Templates — Server-Side Reusable Instructions

**Claim**: MCP prompts are reusable templates that guide AI interactions. In FastMCP, use `@mcp.prompt()`. In TypeScript, use `server.registerPrompt()`. Prompts can return strings (converted to user messages) or arrays of `Message` objects for multi-turn conversations. [^14^]

**Source**: CodeSignal — Exploring MCP Primitives  
**URL**: https://codesignal.com/learn/courses/developing-and-integrating-an-mcp-server-in-typescript/lessons/defining-tools-and-resources  
**Date**: Unknown  
**Excerpt**:
```typescript
server.registerPrompt(
  "analyze-code",
  {
    description: "Analyze code for bugs and improvements",
    argsSchema: {
      language: z.string().describe("Programming language"),
      code: z.string().describe("Code to analyze"),
    },
  },
  async ({ language, code }) => ({
    messages: [
      { role: "user", content: { type: "text", text: `Analyze this ${language} code:\n\n${code}` } },
    ],
  })
);
```

**Source**: GoFastMCP — Prompts  
**URL**: https://gofastmcp.com/servers/prompts  
**Date**: Unknown  
**Excerpt**:
```python
@mcp.prompt
def debug_session(error: str) -> list[Message]:
    """Start a debugging conversation"""
    return [
        Message(f"I'm seeing this error:\n\n{error}"),
        Message("I'll help you debug that. Can you share the relevant code?", role="assistant"),
    ]
```

**Context**: A time estimation server could provide a prompt like `estimate_task` that instructs the LLM on how to break down tasks and apply estimation heuristics.  
**Confidence**: High

---

### 2.15 Testing MCP Servers — pytest, Mock Clients, Inspector

**Claim**: MCP server testing can be done via: (1) pytest with mock MCP clients, (2) the MCP Inspector for interactive validation, and (3) custom JSON-RPC test harnesses for automated protocol-level testing. The Python SDK provides `ClientSession` and `stdio_client` for building test clients. [^15^]

**Source**: Real Python — Build a Python MCP Client to Test Servers  
**URL**: https://realpython.com/python-mcp-client/  
**Date**: 2025-11-19  
**Excerpt**:
```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

server_params = StdioServerParameters(
    command="uv",
    args=["run", "server", "fastmcp_quickstart", "stdio"],
)

async def run():
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print(f"Available tools: {[t.name for t in tools.tools]}")
            result = await session.call_tool("add", arguments={"a": 5, "b": 3})
```

**Source**: CircleCI Blog — FastMCP Server  
**URL**: https://circleci.com/blog/building-and-deploying-a-python-mcp-server-with-fastmcp/  
**Date**: 2025-10-07  
**Excerpt**:
```toml
[project.optional-dependencies]
dev = ["pytest>=8.3.5", "build>=1.2.2.post1"]
```

**Context**: A recommended testing strategy for a time estimation server: unit tests for estimation logic (pure Python functions), integration tests using `ClientSession` against the running server, and Inspector-based smoke tests before deployment.  
**Confidence**: High

---

### 2.16 Deployment — stdio vs. HTTP, npx/uvx, mcp-proxy

**Claim**: MCP servers can be deployed via stdio (local, spawned by client), Streamable HTTP (remote, recommended for new servers), or SSE (deprecated). For stdio servers distributed as npm/Python packages, `mcp-proxy` converts stdio to HTTP for remote deployment. [^16^]

**Source**: TrueFoundry — Deploy MCP Server from npx/uvx  
**URL**: https://www.truefoundry.com/docs/mcp-server-deployment/deploy-mcp-server-from-npx-uvx  
**Date**: 2026-01-27  
**Excerpt**:
> "MCP servers run via `npx` or `uvx` typically use stdio communication. To deploy them on TrueFoundry, you need to: (1) Wrap the `npx`/`uvx` command with `mcp-proxy` to convert stdio to HTTP, (2) Deploy it as a service that can be accessed over HTTP."

**Source**: Apigene — MCP SSE vs Stdio  
**URL**: https://apigene.ai/blog/mcp-sse-vs-stdio  
**Date**: 2026-03-26  
**Excerpt**:
> "Stdio is local-only and single-client. Production testing showed 20 of 22 requests failed with just 20 simultaneous connections. SSE is deprecated. Streamable HTTP is the current standard."

**Context**: For a time estimation server intended for local use (e.g., Claude Desktop), stdio is simplest. For remote/shared deployment, use Streamable HTTP directly or wrap stdio with `mcp-proxy`.  
**Confidence**: High

---

### 2.17 Transport Comparison — Stdio, SSE, Streamable HTTP

**Claim**: MCP supports three transports with distinct characteristics. Stdio is local-only, single-client, simplest. SSE is deprecated (two-endpoint design, `/sse` + `/messages`). Streamable HTTP is the modern standard — single endpoint `/mcp`, bidirectional, supports both synchronous and streaming responses, works with Claude.ai Custom Connectors. [^17^]

**Source**: Roo Code — MCP Server Transports  
**URL**: https://docs.roocode.com/features/mcp/server-transports  
**Date**: 2026-02-19  
**Excerpt**:
```
| Feature              | stdio          | Streamable HTTP | SSE (Legacy)   |
|---------------------|----------------|-----------------|----------------|
| Location            | Local only     | Local or remote | Local or remote|
| Clients             | Single client  | Multiple        | Multiple       |
| Performance         | Lower latency  | Higher latency  | Higher latency |
| Setup Complexity    | Simpler        | More complex    | More complex   |
| Scalability         | Limited        | Can distribute  | Can distribute |
| Recommendation      | Local tools    | Modern standard | Legacy         |
```

**Context**: A time estimation server for personal AI assistants should use stdio. For team/enterprise use, Streamable HTTP with auth is required. SSE should not be used for new projects.  
**Confidence**: High

---

### 2.18 Tool Description Best Practices — Detailed, Workflow-Oriented

**Claim**: Tool descriptions are the primary signal LLMs use to decide when to invoke a tool. Best practices include: (1) detailed multi-line descriptions with use-case guidance, (2) per-parameter `.describe()` with constraints, (3) `annotations` (readOnlyHint, destructiveHint, idempotentHint, openWorldHint), (4) examples of when to use and when NOT to use, (5) error handling documentation. [^18^]

**Source**: Anthropic Skills — Node/TypeScript MCP Server Implementation Guide  
**URL**: https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/node_mcp_server.md  
**Date**: Unknown  
**Excerpt**:
```typescript
server.registerTool("example_search_users", {
  title: "Search Example Users",
  description: `Search for users in the Example system by name, email, or team.

This tool searches across all user profiles in the Example platform, supporting partial matches and various search filters. It does NOT create or modify users, only searches existing ones.

Args:
  - query (string): Search string to match against names/emails
  - limit (number): Maximum results to return, between 1-100 (default: 20)

Returns:
  For JSON format: Structured data with schema: { "total": number, "users": [...] }

Examples:
  - Use when: "Find all marketing team members" -> params with query="team:marketing"
  - Don't use when: You need to create a user (use example_create_user instead)

Error Handling:
  - Returns "Error: Rate limit exceeded" if too many requests (429 status)`,
  inputSchema: UserSearchInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}, async (params) => { ... });
```

**Context**: For time estimation, descriptions should explicitly state: "Use this tool when the user asks how long a task will take", "Provide task description, complexity level, and any known constraints", "Returns estimated duration in hours with confidence level".  
**Confidence**: High

---

### 2.19 Rate Limiting for Production MCP Servers

**Claim**: AI agents create load patterns unlike human users — they can make 50+ rapid sequential requests during normal operation. Rate limiting should be implemented at per-IP/session level and per-tool level. Use JSON-RPC error codes (e.g., -32029) with `retryAfter` metadata. [^19^]

**Source**: Fast.io — How to Implement MCP Server Rate Limiting  
**URL**: https://fast.io/resources/mcp-server-rate-limiting/  
**Date**: 2026-02-10  
**Excerpt**:
```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32029,
    "message": "Rate limit exceeded. Try again in 3 seconds.",
    "data": {
      "retryAfter": 3,
      "limit": 60,
      "window": "1m"
    }
  }
}
```

**Source**: MintMCP — Rate Limiting with MCP  
**URL**: https://www.mintmcp.com/blog/rate-limiting-with-mcp  
**Date**: 2026-02-04  
**Excerpt**:
> "Token-based quotas: Limit actual compute usage (input + output tokens) rather than raw request counts. Multi-dimensional limits: Apply restrictions by user, team, model type, tool category, and time window."

**Context**: For a time estimation server calling external APIs (e.g., calendar APIs), rate limiting protects both the server and downstream services from agent retry loops.  
**Confidence**: High

---

### 2.20 Authentication Patterns — API Keys, OAuth, mTLS

**Claim**: Three dominant authentication patterns exist for MCP servers: API keys (simplest, for internal/dev), OAuth 2.0 (multi-tenant, user-delegated), and Mutual TLS (zero-trust, regulated environments). A production pattern layers all three: mTLS at transport, OAuth for scopes, API keys for health checks. [^20^]

**Source**: Dev.to — MCP Server Authentication: OAuth vs API Keys vs Mutual TLS  
**URL**: https://dev.to/whoffagents/mcp-server-authentication-oauth-vs-api-keys-vs-mutual-tls-which-to-use-and-when-4nj3  
**Date**: 2026-04-17  
**Excerpt**:
```typescript
function requireApiKey(requiredScope?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }
    const key = authHeader.slice(7);
    // timingSafeCompare to prevent timing attacks
    // check scope
    next();
  };
}
```

**Source**: Microsoft Foundry — Set Up MCP Server Authentication  
**URL**: https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/mcp-authentication  
**Date**: 2026-04-09  
**Excerpt**:
> "When in doubt, start with Microsoft Entra authentication if the MCP server supports it. Microsoft Entra authentication eliminates the need to manage secrets and provides built-in token rotation."

**Context**: For a local stdio time estimation server, authentication is typically unnecessary. For remote Streamable HTTP deployment, Bearer token auth via `Authorization` header is the minimum viable security layer.  
**Confidence**: High

---

### 2.21 Existing Time-Related MCP Server — Reference Implementation

**Claim**: `TheoBrigitte/mcp-time` is an existing Go-based MCP server providing time utilities: `current_time`, `relative_time` (natural language parsing), `convert_timezone`, and `add_time` (duration arithmetic). It serves as a functional reference for what a time estimation server should expose. [^21^]

**Source**: GitHub — TheoBrigitte/mcp-time  
**URL**: https://github.com/TheoBrigitte/mcp-time  
**Date**: 2025-10-01  
**Excerpt**:
```
Available Tools:
- current_time: Get the current time in any timezone and format.
  Parameters: format (optional), timezone (optional). Defaults to UTC.
- relative_time: Get a time based on a relative natural language expression.
  Parameters: text (required, e.g., "yesterday", "5 minutes ago"), time (optional), timezone (optional), format (optional).
- convert_timezone: Convert a given time between timezones.
  Parameters: time (required), input_timezone (optional), output_timezone (optional), format (optional).
- add_time: Add or subtract a duration from a given time.
  Parameters: time (required), duration (required, e.g., "2h30m"), timezone (optional), format (optional).
```

**Context**: This server focuses on time *manipulation* (parsing, conversion, arithmetic) rather than time *estimation* (predicting duration). A time estimation server would extend these capabilities with estimation heuristics, historical data analysis, and confidence scoring.  
**Confidence**: High

---

### 2.22 Structured Output — `structuredContent` for Client Widgets

**Claim**: MCP tools can return both `content` (text for the LLM context) and `structuredContent` (structured data for client widgets). The `structuredContent` never enters the LLM context window (zero token cost) and can drive interactive UI elements in Claude.ai / Claude Desktop. [^22^]

**Source**: FutureSearch — MCP structuredContent: How to Return Large Results  
**URL**: https://futuresearch.ai/blog/mcp-results-widget/  
**Date**: 2026-02-26  
**Excerpt**:
```python
return CallToolResult(
    content=[TextContent(type="text", text=summary)],
    structuredContent=widget_data,
)
```

**Context**: For time estimation, `structuredContent` could carry the full estimation breakdown (task components, individual estimates, confidence intervals) while `content` provides a concise text summary for the LLM.  
**Confidence**: High

---

### 2.23 Tool Annotations — Safety Hints for AI Systems

**Claim**: MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) communicate operational characteristics to AI clients, helping them understand safety profiles without consuming token context. [^23^]

**Source**: Dokploy MCP Server — Tool Annotations  
**URL**: https://mintlify.com/Dokploy/mcp/api-reference/tool-annotations  
**Date**: 2026-03-04  
**Excerpt**:
```
annotations: {
  title?: string;
  readOnlyHint?: boolean;      // Tool only reads data
  destructiveHint?: boolean;   // Tool modifies/deletes resources
  idempotentHint?: boolean;    // Safe to retry with same result
  openWorldHint?: boolean;     // Interacts with external systems
}
```

**Context**: A time estimation tool should set `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` (unless calling external APIs). This helps LLMs understand the tool is safe to invoke speculatively.  
**Confidence**: High

---

### 2.24 FastMCP TypeScript — Alternative Framework

**Claim**: `punkpeye/fastmcp` is a TypeScript framework for building MCP servers, inspired by the Python FastMCP. It provides `FastMCP` and `EdgeFastMCP` classes, supports stdio/httpStream/SSE, includes built-in auth, and has a CLI (`npx fastmcp dev`, `npx fastmcp inspect`). [^24^]

**Source**: GitHub — punkpeye/fastmcp  
**URL**: https://github.com/punkpeye/fastmcp  
**Date**: 2026-04-24  
**Excerpt**:
```typescript
import { FastMCP } from "fastmcp";
import { z } from "zod";

const server = new FastMCP({ name: "My Server", version: "1.0.0" });

server.addTool({
  name: "add",
  description: "Add two numbers",
  parameters: z.object({ a: z.number(), b: z.number() }),
  execute: async (args) => String(args.a + args.b),
});

server.start({ transportType: "stdio" });
```

**Context**: This is an alternative to the official SDK's `McpServer`. It offers a more ergonomic API and built-in development tools. However, the official SDK is more widely adopted and better documented.  
**Confidence**: Medium

---

## 3. Major Players, Tools, and Frameworks

### Frameworks and SDKs

| Framework / SDK | Language | Level | Key Features | URL |
|-----------------|----------|-------|--------------|-----|
| **Official MCP Python SDK** (`mcp`) | Python | High + Low | FastMCP decorators, low-level `Server`, stdio/HTTP/SSE, CLI tools | github.com/modelcontextprotocol/python-sdk |
| **Official MCP TypeScript SDK** (`@modelcontextprotocol/sdk`) | TypeScript | High + Low | `McpServer`, `Server`, Zod validation, stdio/HTTP/SSE | github.com/modelcontextprotocol/typescript-sdk |
| **FastMCP (TypeScript)** (`fastmcp`) | TypeScript | High | `FastMCP` / `EdgeFastMCP`, built-in auth, CLI dev tools | github.com/punkpeye/fastmcp |
| **MCP Framework** (`mcp-framework`) | TypeScript | High | Directory-based discovery, CLI scaffold, auth, multiple transports | mcp-framework.com |
| **MCP Server Boilerplate** | TypeScript + Python | Starter | Working examples of tools/resources/prompts, Docker, CI/CD | github.com/shellsage-ai/mcp-server-boilerplate |

### Development and Debugging Tools

| Tool | Purpose | URL |
|------|---------|-----|
| **MCP Inspector** | Official protocol validation, tool testing, Web UI | npx @modelcontextprotocol/inspector |
| **MCP Inspector for VSCode** | IDE-integrated debugging | marketplace.visualstudio.com/items?itemName=WSO2.mcp-server-inspector |
| **fastmcp dev / inspect** | CLI testing for FastMCP TypeScript servers | github.com/punkpeye/fastmcp |
| **mcp-cli** | Terminal-based MCP client for testing | Bundled with official SDK |
| **mcp-proxy** | Converts stdio servers to HTTP for remote deployment | Used by TrueFoundry, various gateways |

### Deployment and Gateway Platforms

| Platform | Role | URL |
|----------|------|-----|
| **Render** | One-click MCP server deployment with auth | render.com/templates/mcp-server-python |
| **TrueFoundry** | MCP server deployment from npx/uvx packages | truefoundry.com |
| **Apigene** | MCP gateway with observability, auth, transport translation | apigene.ai |
| **Smithery** | MCP server marketplace and installer | smithery.ai |

---

## 4. Controversies and Conflicting Claims

### 4.1 FastMCP (Prefect) vs. Official Python SDK

**Conflict**: There is an ongoing tension between FastMCP 2.0 (maintained by Prefect) and the official Anthropic `mcp` Python SDK. Some developers prefer FastMCP for its ergonomics; others prefer the official SDK for production stability and spec compliance. [^25^]

**Source**: GitHub Discussion — MCP python-sdk vs. FastMCP 2.0  
**URL**: https://github.com/PrefectHQ/fastmcp/discussions/2557  
**Date**: 2025-12-05  
**Excerpt**:
> "I'm currently leaning toward FastMCP, but the 'official' SDK feels more promising and potentially easier to adopt for a production environment."

**Context**: The V1 FastMCP was created before the official SDK existed. V2 is maintained independently. The official SDK now includes FastMCP-like high-level APIs. For a new project, the official SDK is the safer long-term bet, but FastMCP 2.0 has a strong community and additional features (e.g., OAuth).  
**Confidence**: Medium

### 4.2 SSE Transport Deprecation

**Conflict**: SSE was the first remote transport but is now officially deprecated in favor of Streamable HTTP. However, many existing servers and tutorials still use SSE, creating confusion. Some community members argue WebSocket should be the future transport. [^26^]

**Source**: Apigene — MCP SSE vs Stdio  
**URL**: https://apigene.ai/blog/mcp-sse-vs-stdio  
**Date**: 2026-03-26  
**Excerpt**:
> "SSE is deprecated. The MCP spec has moved to Streamable HTTP. If you're building a new remote server, skip SSE entirely."

**Context**: New servers should use Streamable HTTP. Existing SSE servers should plan migration. The community is already discussing WebSocket as a potential future transport.  
**Confidence**: High

### 4.3 Inspector CVE Security Vulnerability

**Conflict**: The official MCP Inspector has a critical remote code execution vulnerability (CVE-2025-49596) in older versions. This creates tension between using the official tool and seeking alternatives. [^27^]

**Source**: Apigene — MCP Inspector Guide  
**URL**: https://apigene.ai/blog/mcp-inspector  
**Date**: 2026-03-26  
**Excerpt**:
> "CVE-2025-49596 is a critical RCE vulnerability in MCP Inspector. A malicious MCP server can execute arbitrary code on the machine running Inspector. Always update to the latest version."

**Context**: Always use the latest Inspector version. For testing untrusted servers, run in a container or VM.  
**Confidence**: High

---

## 5. Gaps and Open Questions

1. **Time Estimation Domain-Specific Patterns**: No existing MCP server specifically targets *task duration estimation* with confidence scoring, historical learning, or heuristic models. The `mcp-time` server handles time parsing/conversion but not estimation. A research gap exists for combining MCP with estimation techniques (e.g., PERT, story points, historical velocity).

2. **Evaluation Harness Standardization**: While `connections.py` and `evaluation.py` scripts exist in the `mcp-builder` skill, there is no standardized community framework for automated MCP server evaluation. Each project builds its own test harness.

3. **Structured Output Adoption**: The `structuredContent` field (introduced in spec revision 2025-06-18) is powerful but not yet widely adopted. Client support for rendering `structuredContent` as widgets varies. The fallback to `content` is required for backwards compatibility.

4. **Multi-Transport Server Complexity**: Building a server that supports stdio (for local dev) and Streamable HTTP (for production) without duplicating code is non-trivial. The official SDKs provide separate transport classes but no unified abstraction.

5. **Authentication in stdio Mode**: stdio servers have no natural authentication mechanism since they run as local child processes. For sensitive time/estimation data, this is a security gap. Solutions involve pre-flight auth checks or proxy layers.

6. **Python SDK v2 Transition**: The Python SDK is transitioning from v1.x to v2 (pre-alpha on `main`). APIs may change. Projects starting now should pin to stable v1.x or accept migration risk.

---

## 6. Summary and Recommended Deep-Dive Areas

### Recommended Implementation Path for Time Estimation MCP Server

**For Python (Recommended for rapid prototyping):**
1. Use `uv init` to scaffold the project
2. Add `mcp[cli]` dependency
3. Create a `FastMCP` instance with `json_response=True`
4. Implement tools with `@mcp.tool()` decorators:
   - `estimate_task_duration(task_description, complexity, constraints)`
   - `parse_time_expression(natural_language_text)`
   - `convert_timezone(time, from_zone, to_zone)`
   - `add_duration(time, duration)`
5. Use Pydantic type annotations for automatic schema generation
6. Set `strict_input_validation=False` for LLM-friendly coercion
7. Implement error handling with `ToolError` for user-facing messages
8. Use `mcp.run(transport="stdio")` for local deployment
9. Test with `uv run mcp dev server.py` and MCP Inspector
10. Package with `pyproject.toml` and publish to PyPI

**For TypeScript (Recommended for integration with JS ecosystems):**
1. Use `npm init` + `tsc --init` with `module: "Node16"`
2. Install `@modelcontextprotocol/sdk` and `zod`
3. Create `McpServer` instance
4. Implement tools with `server.registerTool()` and Zod `inputSchema`
5. Add detailed `.describe()` on every parameter
6. Use `annotations` for safety hints
7. Return `{ content, structuredContent }` for rich client support
8. Use `StdioServerTransport` for local, `StreamableHTTPServerTransport` for remote
9. Test with `npx @modelcontextprotocol/inspector`
10. Deploy via `npx` or Docker with `mcp-proxy` for stdio-to-HTTP conversion

### Deep-Dive Areas for Further Research

1. **Estimation Algorithms**: Research PERT, Monte Carlo simulation, and machine learning-based duration prediction models suitable for MCP tool implementation.
2. **Multi-Modal Time Input**: How to handle voice, image (screenshots of schedules), and structured data (ICS files) as time estimation inputs.
3. **Cross-Server Composition**: How a time estimation server can compose with project management MCP servers (Jira, Linear, Notion) for end-to-end planning.
4. **Caching and Session State**: Patterns for caching timezone data, estimation models, and user preferences across MCP sessions.
5. **Client-Specific Optimization**: How tool descriptions and response formats should be tailored for Claude vs. ChatGPT vs. Cursor tool selection behaviors.

---

## Source Index

[^1^]: MCP Python SDK Official Repository — github.com/modelcontextprotocol/python-sdk (2026-04-02)
[^2^]: MCP Course — Calculator Python Server — alexyslozada-mcp-course-71.mintlify.app/servers/calculator-python (2026-03-04)
[^3^]: GoFastMCP — Tools Documentation — gofastmcp.com/servers/tools (Current)
[^4^]: MCP Python SDK — Low-Level Server Examples — github.com/modelcontextprotocol/python-sdk (2026-04-02)
[^5^]: Blog — MCP TypeScript SDK Complete Guide — blog.agentailor.com/posts/mcp-typescript-sdk-complete-guide (2026-03-18)
[^6^]: Medium — Build Your First MCP Server with TypeScript — thecraftman.medium.com/build-your-first-mcp-server-with-plain-and-typescript-6dd13494b95e (2026-01-11)
[^7^]: CircleCI — Building and Deploying a Python MCP Server — circleci.com/blog/building-and-deploying-a-python-mcp-server-with-fastmcp/ (2025-10-07)
[^8^]: GoFastMCP — Running Your Server — gofastmcp.com/deployment/running-server (Current)
[^9^]: MCP Python SDK / Anthropic Skills — github.com/modelcontextprotocol/python-sdk + github.com/anthropics/skills (2026-04-02)
[^10^]: GoFastMCP — Error Handling / Medium — MCP TS SDK Complete Guide — gofastmcp.com/servers/tools + techwithibrahim.medium.com (Current / 2026-04-06)
[^11^]: MCP Official Docs — Debugging / Apigene — MCP Inspector — modelcontextprotocol.io/docs/tools/debugging + apigene.ai/blog/mcp-inspector (2025-11-25 / 2026-03-26)
[^12^]: MCP Official Docs — Inspector / Apigene — MCP Inspector Guide — modelcontextprotocol.io/docs/tools/inspector + apigene.ai/blog/mcp-inspector (2026-03-25 / 2026-03-26)
[^13^]: MCP Course — Resources / GoFastMCP — Resources — mintlify.com/alexyslozada/mcp-course/concepts/resources + gofastmcp.com/servers/resources (2026-03-04)
[^14^]: CodeSignal — Exploring MCP Primitives / GoFastMCP — Prompts — codesignal.com/learn + gofastmcp.com/servers/prompts (Current)
[^15^]: Real Python — Build a Python MCP Client / CircleCI Blog — realpython.com/python-mcp-client/ + circleci.com/blog (2025-11-19 / 2025-10-07)
[^16^]: TrueFoundry — Deploy MCP Server / Apigene — SSE vs Stdio — truefoundry.com/docs + apigene.ai/blog/mcp-sse-vs-stdio (2026-01-27 / 2026-03-26)
[^17^]: Roo Code — MCP Server Transports — docs.roocode.com/features/mcp/server-transports (2026-02-19)
[^18^]: Anthropic Skills — Node/TypeScript MCP Server Guide — github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/node_mcp_server.md (Current)
[^19^]: Fast.io — MCP Rate Limiting / MintMCP — Rate Limiting — fast.io/resources/mcp-server-rate-limiting/ + mintmcp.com/blog/rate-limiting-with-mcp (2026-02-10 / 2026-02-04)
[^20^]: Dev.to — MCP Auth / Microsoft Foundry — MCP Authentication — dev.to/whoffagents + learn.microsoft.com (2026-04-17 / 2026-04-09)
[^21^]: GitHub — TheoBrigitte/mcp-time — github.com/TheoBrigitte/mcp-time (2025-10-01)
[^22^]: FutureSearch — MCP structuredContent — futuresearch.ai/blog/mcp-results-widget/ (2026-02-26)
[^23^]: Dokploy MCP Server — Tool Annotations — mintlify.com/Dokploy/mcp/api-reference/tool-annotations (2026-03-04)
[^24^]: GitHub — punkpeye/fastmcp — github.com/punkpeye/fastmcp (2026-04-24)
[^25^]: GitHub Discussion — MCP python-sdk vs. FastMCP 2.0 — github.com/PrefectHQ/fastmcp/discussions/2557 (2025-12-05)
[^26^]: Apigene — MCP SSE vs Stdio — apigene.ai/blog/mcp-sse-vs-stdio (2026-03-26)
[^27^]: Apigene — MCP Inspector Guide (CVE) — apigene.ai/blog/mcp-inspector (2026-03-26)
