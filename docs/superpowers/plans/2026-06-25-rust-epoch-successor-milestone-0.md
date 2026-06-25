# Rust Epoch Successor Milestone 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the contract inventory, Rust workspace skeleton, and first drift gate that future Rust Epoch successor work depends on.

**Architecture:** Keep TypeScript as the oracle for this milestone. Add a typed public-surface inventory in `src/contract/`, export it to a tracked JSON contract artifact, then create a Rust workspace under `rust/` whose `epoch-contract` crate can read and validate that artifact. No business-logic port happens in this milestone.

**Tech Stack:** TypeScript 5.7 strict, Vitest 4, tsx, Rust 1.93.1, Cargo workspace resolver 2, Rust edition 2024, serde 1, serde_json 1, schemars 1.2, anyhow 1.

## Global Constraints

- Preserve the exact 24 MCP tool names from `src/dispatcher/tool-registry.ts`.
- Preserve the two write tools: `record_actual`, `batch_record_actuals`.
- Preserve the 11 HTTP routes from `src/entries/http.ts`.
- Preserve CLI command-family intent from `src/entries/cli.ts`.
- Treat the TypeScript implementation as the migration oracle until Rust passes parity gates.
- Keep telemetry local-first: disabled by default, no built-in receiver URL, explicit opt-in only.
- Use isolated `EPOCH_DATA_DIR` values for tests that touch local state.
- Do not port estimation, calendar, telemetry, feedback, HTTP, CLI, or MCP business logic in this milestone.
- Run a public leak audit before every commit.
- Do not push or open a public PR from this plan.

---

## Scope Check

The approved Rust clone spec spans multiple independent subsystems: contract, core algorithms, local data, MCP, CLI, HTTP, telemetry receiver, canaries, npm packaging, and docs generation.

This plan intentionally covers **Milestone 0** only:

1. Capture the current public contract in executable tests.
2. Export the contract to a tracked JSON artifact.
3. Create the Rust workspace skeleton.
4. Add the first Rust drift gate against the exported contract.

Subsequent plans should use this milestone as the base and split work by tool family or adapter surface.

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/contract/public-surface.ts` | Create | Canonical TypeScript inventory of the current public contract |
| `src/contract/public-surface.test.ts` | Create | Tests that compare inventory against live TypeScript surfaces |
| `src/contract/export-public-surface.ts` | Create | Writes the inventory JSON artifact |
| `docs/superpowers/contracts/epoch-public-surface.json` | Create | Tracked contract artifact consumed by Rust |
| `package.json` | Modify | Add contract and Rust verification scripts |
| `rust/Cargo.toml` | Create | Rust workspace root |
| `rust/crates/epoch-contract/Cargo.toml` | Create | Contract crate manifest |
| `rust/crates/epoch-contract/src/lib.rs` | Create | Typed Rust contract reader and schema-bearing structs |
| `rust/crates/epoch-core/Cargo.toml` | Create | Core crate manifest |
| `rust/crates/epoch-core/src/lib.rs` | Create | Core crate skeleton wired to contract crate |
| `rust/crates/epoch-data/Cargo.toml` | Create | Data crate manifest |
| `rust/crates/epoch-data/src/lib.rs` | Create | Data crate skeleton wired to contract crate |
| `rust/crates/epoch-mcp/Cargo.toml` | Create | MCP crate manifest |
| `rust/crates/epoch-mcp/src/lib.rs` | Create | MCP crate skeleton wired to contract crate |
| `rust/crates/epoch-cli/Cargo.toml` | Create | CLI crate manifest |
| `rust/crates/epoch-cli/src/lib.rs` | Create | CLI crate skeleton wired to contract crate |
| `rust/crates/epoch-http/Cargo.toml` | Create | HTTP crate manifest |
| `rust/crates/epoch-http/src/lib.rs` | Create | HTTP crate skeleton wired to contract crate |
| `rust/crates/epoch-canary/Cargo.toml` | Create | Canary crate manifest |
| `rust/crates/epoch-canary/src/lib.rs` | Create | Canary crate skeleton wired to contract crate |
| `rust/crates/xtask/Cargo.toml` | Create | Rust task runner manifest |
| `rust/crates/xtask/src/main.rs` | Create | Drift gate command |

---

### Task 1: TypeScript Public Surface Inventory

**Files:**
- Create: `src/contract/public-surface.ts`
- Create: `src/contract/public-surface.test.ts`

**Interfaces:**
- Consumes: `TOOL_REGISTRY` from `src/dispatcher/index.ts`, `createCliProgram()` from `src/entries/cli.ts`, `createApiApp()` from `src/entries/http.ts`.
- Produces: `PUBLIC_SURFACE`, `collectCliCommandPaths()`, `collectHttpRoutes()`.

- [ ] **Step 1: Write the failing test**

Create `src/contract/public-surface.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../dispatcher/index.js";
import { createCliProgram } from "../entries/cli.js";
import { createApiApp } from "../entries/http.js";
import {
  EXPECTED_CLI_COMMAND_PATHS,
  EXPECTED_HTTP_ROUTES,
  EXPECTED_MCP_TOOL_NAMES,
  EXPECTED_WRITE_TOOL_NAMES,
  collectCliCommandPaths,
  collectHttpRoutes,
} from "./public-surface.js";

describe("public surface inventory", () => {
  it("matches the live MCP tool registry", () => {
    expect([...TOOL_REGISTRY.keys()]).toEqual(EXPECTED_MCP_TOOL_NAMES);
    expect(EXPECTED_MCP_TOOL_NAMES).toHaveLength(24);
  });

  it("records the write tools explicitly", () => {
    expect(EXPECTED_WRITE_TOOL_NAMES).toEqual([
      "record_actual",
      "batch_record_actuals",
    ]);
  });

  it("matches the live CLI command tree", () => {
    expect(collectCliCommandPaths(createCliProgram())).toEqual(
      EXPECTED_CLI_COMMAND_PATHS,
    );
    expect(EXPECTED_CLI_COMMAND_PATHS).toHaveLength(39);
  });

  it("matches the live HTTP routes", () => {
    expect(collectHttpRoutes(createApiApp())).toEqual(EXPECTED_HTTP_ROUTES);
    expect(EXPECTED_HTTP_ROUTES).toHaveLength(11);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm exec vitest run src/contract/public-surface.test.ts
```

Expected: FAIL because `src/contract/public-surface.ts` does not exist.

- [ ] **Step 3: Create the inventory module**

Create `src/contract/public-surface.ts`:

```typescript
import type { Command } from "commander";
import type { Hono } from "hono";

export const EXPECTED_MCP_TOOL_NAMES = [
  "get_current_time",
  "convert_timezone",
  "parse_duration",
  "time_math",
  "add_business_days",
  "count_business_days",
  "pert_estimate",
  "cocomo_estimate",
  "sprint_forecast",
  "critical_path",
  "monte_carlo_schedule",
  "reference_class_estimate",
  "calibrate_estimates",
  "token_time_bridge",
  "token_cost_estimate",
  "compare_models",
  "accuracy_trend",
  "schedule_risk",
  "cocomo_validate",
  "cocomo_ground_truth",
  "record_actual",
  "get_pending_estimates",
  "batch_record_actuals",
  "feedback_health",
] as const;

export const EXPECTED_WRITE_TOOL_NAMES = [
  "record_actual",
  "batch_record_actuals",
] as const;

export const EXPECTED_HTTP_ROUTES = [
  "GET /health",
  "GET /v1/tools",
  "POST /v1/tools/:toolName",
  "POST /v1/telemetry",
  "GET /.well-known/ai-plugin.json",
  "GET /llms.txt",
  "GET /openapi.json",
  "POST /v1/feedback/record-actual",
  "GET /v1/feedback/pending",
  "POST /v1/feedback/batch-record-actuals",
  "GET /v1/feedback/health",
] as const;

export const EXPECTED_CLI_COMMAND_PATHS = [
  "get-current-time",
  "convert-timezone",
  "parse-duration",
  "time-math",
  "add-business-days",
  "count-business-days",
  "pert-estimate",
  "cocomo-estimate",
  "sprint-forecast",
  "critical-path",
  "monte-carlo-schedule",
  "reference-class-estimate",
  "calibrate-estimates",
  "token-time-bridge",
  "token-cost-estimate",
  "compare-models",
  "accuracy-trend",
  "schedule-risk",
  "cocomo-validate",
  "record-actual",
  "get-pending-estimates",
  "batch-record-actuals",
  "feedback-health",
  "cocomo-ground-truth",
  "self-improve",
  "telemetry",
  "telemetry status",
  "telemetry preview",
  "telemetry export",
  "telemetry enable",
  "telemetry set-endpoint",
  "telemetry submit",
  "telemetry disable",
  "telemetry delete-data",
  "share-data",
  "data",
  "data where",
  "data status",
  "list-tools",
] as const;

export const PUBLIC_SURFACE = {
  package_name: "@kyanitelabs/epoch",
  mcp_tool_names: EXPECTED_MCP_TOOL_NAMES,
  write_tool_names: EXPECTED_WRITE_TOOL_NAMES,
  http_routes: EXPECTED_HTTP_ROUTES,
  cli_command_paths: EXPECTED_CLI_COMMAND_PATHS,
} as const;

export type PublicSurface = typeof PUBLIC_SURFACE;

export function collectCliCommandPaths(program: Command): string[] {
  const paths: string[] = [];

  function visit(command: Command, prefix: string[]): void {
    for (const child of command.commands) {
      const next = [...prefix, child.name()];
      paths.push(next.join(" "));
      visit(child, next);
    }
  }

  visit(program, []);
  return paths;
}

type HonoRoute = {
  method?: string;
  path?: string;
};

export function collectHttpRoutes(app: Hono): string[] {
  const routes = ((app as unknown as { routes?: HonoRoute[] }).routes ?? [])
    .map((route) => {
      const method = route.method?.toUpperCase();
      const path = route.path;
      return method && path ? `${method} ${path}` : undefined;
    })
    .filter((route): route is string => route !== undefined)
    .filter((route) => EXPECTED_HTTP_ROUTES.includes(route as never));

  return routes;
}
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
pnpm exec vitest run src/contract/public-surface.test.ts
```

Expected: PASS with four passing tests.

- [ ] **Step 5: Run TypeScript verification**

Run:

```bash
pnpm run typecheck
```

Expected: PASS with zero TypeScript errors.

- [ ] **Step 6: Run the public leak audit for this task**

Run:

```bash
rg -n "/Users/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|API[_-]?KEY\\s*=|SECRET\\s*=|PASSWORD\\s*=|PRIVATE KEY|BEGIN (RSA|OPENSSH|PRIVATE)|PATH=|HOME=|TMPDIR=|100\\.[0-9]+\\.[0-9]+\\.[0-9]+" src/contract/public-surface.ts src/contract/public-surface.test.ts
```

Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add src/contract/public-surface.ts src/contract/public-surface.test.ts
git commit -m "test: lock current Epoch public surface"
```

---

### Task 2: Public Surface Export Artifact

**Files:**
- Create: `src/contract/export-public-surface.ts`
- Create: `docs/superpowers/contracts/epoch-public-surface.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PUBLIC_SURFACE` from `src/contract/public-surface.ts`.
- Produces: `pnpm run contract:inventory`, tracked JSON artifact at `docs/superpowers/contracts/epoch-public-surface.json`.

- [ ] **Step 1: Write the failing test for artifact shape**

Append this test to `src/contract/public-surface.test.ts`:

```typescript
it("exports a JSON-safe contract artifact shape", () => {
  const json = JSON.stringify(
    {
      package_name: "@kyanitelabs/epoch",
      mcp_tool_names: EXPECTED_MCP_TOOL_NAMES,
      write_tool_names: EXPECTED_WRITE_TOOL_NAMES,
      http_routes: EXPECTED_HTTP_ROUTES,
      cli_command_paths: EXPECTED_CLI_COMMAND_PATHS,
    },
    null,
    2,
  );

  const parsed = JSON.parse(json) as {
    package_name: string;
    mcp_tool_names: string[];
    write_tool_names: string[];
    http_routes: string[];
    cli_command_paths: string[];
  };

  expect(parsed.package_name).toBe("@kyanitelabs/epoch");
  expect(parsed.mcp_tool_names).toHaveLength(24);
  expect(parsed.write_tool_names).toEqual([
    "record_actual",
    "batch_record_actuals",
  ]);
  expect(parsed.http_routes).toHaveLength(11);
  expect(parsed.cli_command_paths).toHaveLength(39);
});
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
pnpm exec vitest run src/contract/public-surface.test.ts
```

Expected: PASS. This verifies the artifact shape before the export script exists.

- [ ] **Step 3: Create the export script**

Create `src/contract/export-public-surface.ts`:

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PUBLIC_SURFACE } from "./public-surface.js";

const outputPath = "docs/superpowers/contracts/epoch-public-surface.json";

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(PUBLIC_SURFACE, null, 2)}\n`);

process.stdout.write(`Wrote ${outputPath}\n`);
```

- [ ] **Step 4: Add package scripts**

Modify `package.json` inside the existing `"scripts"` object by adding these entries:

```json
"contract:inventory": "tsx src/contract/export-public-surface.ts",
"rust:check": "cargo test --manifest-path rust/Cargo.toml --workspace",
"verify:rust-milestone0": "pnpm run contract:inventory && pnpm run typecheck && pnpm test && pnpm run rust:check"
```

Keep the existing scripts unchanged.

- [ ] **Step 5: Generate the artifact**

Run:

```bash
pnpm run contract:inventory
```

Expected:

```text
Wrote
```

The exact path after `Wrote` depends on the working directory. The generated file must be `docs/superpowers/contracts/epoch-public-surface.json`.

- [ ] **Step 6: Inspect the generated artifact**

Run:

```bash
node -e "const c=require('./docs/superpowers/contracts/epoch-public-surface.json'); console.log(c.package_name, c.mcp_tool_names.length, c.http_routes.length, c.cli_command_paths.length)"
```

Expected:

```text
@kyanitelabs/epoch 24 11 39
```

- [ ] **Step 7: Run TypeScript verification**

Run:

```bash
pnpm run typecheck && pnpm exec vitest run src/contract/public-surface.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run the public leak audit for this task**

Run:

```bash
rg -n "/Users/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|API[_-]?KEY\\s*=|SECRET\\s*=|PASSWORD\\s*=|PRIVATE KEY|BEGIN (RSA|OPENSSH|PRIVATE)|PATH=|HOME=|TMPDIR=|100\\.[0-9]+\\.[0-9]+\\.[0-9]+" src/contract/export-public-surface.ts docs/superpowers/contracts/epoch-public-surface.json package.json
```

Expected: no matches.

- [ ] **Step 9: Commit**

```bash
git add package.json src/contract/export-public-surface.ts src/contract/public-surface.test.ts docs/superpowers/contracts/epoch-public-surface.json
git commit -m "build: export Epoch public surface contract"
```

---

### Task 3: Rust Workspace Skeleton

**Files:**
- Create: `rust/Cargo.toml`
- Create: `rust/crates/epoch-contract/Cargo.toml`
- Create: `rust/crates/epoch-contract/src/lib.rs`
- Create: `rust/crates/epoch-core/Cargo.toml`
- Create: `rust/crates/epoch-core/src/lib.rs`
- Create: `rust/crates/epoch-data/Cargo.toml`
- Create: `rust/crates/epoch-data/src/lib.rs`
- Create: `rust/crates/epoch-mcp/Cargo.toml`
- Create: `rust/crates/epoch-mcp/src/lib.rs`
- Create: `rust/crates/epoch-cli/Cargo.toml`
- Create: `rust/crates/epoch-cli/src/lib.rs`
- Create: `rust/crates/epoch-http/Cargo.toml`
- Create: `rust/crates/epoch-http/src/lib.rs`
- Create: `rust/crates/epoch-canary/Cargo.toml`
- Create: `rust/crates/epoch-canary/src/lib.rs`

**Interfaces:**
- Consumes: `docs/superpowers/contracts/epoch-public-surface.json`.
- Produces: a compiling Rust workspace and `epoch_contract::PublicSurfaceContract`.

- [ ] **Step 1: Write the workspace root**

Create `rust/Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = [
  "crates/epoch-contract",
  "crates/epoch-core",
  "crates/epoch-data",
  "crates/epoch-mcp",
  "crates/epoch-cli",
  "crates/epoch-http",
  "crates/epoch-canary",
]

[workspace.package]
edition = "2024"
rust-version = "1.93"
license = "Apache-2.0"
repository = "https://github.com/KyaniteLabs/Epoch"

[workspace.dependencies]
anyhow = "1"
schemars = "1.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Create `epoch-contract`**

Create `rust/crates/epoch-contract/Cargo.toml`:

```toml
[package]
name = "epoch-contract"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
schemars.workspace = true
serde.workspace = true
serde_json.workspace = true
```

Create `rust/crates/epoch-contract/src/lib.rs`:

```rust
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PublicSurfaceContract {
    pub package_name: String,
    pub mcp_tool_names: Vec<String>,
    pub write_tool_names: Vec<String>,
    pub http_routes: Vec<String>,
    pub cli_command_paths: Vec<String>,
}

impl PublicSurfaceContract {
    pub fn parse(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(raw)
    }

    pub fn validate_milestone_zero(&self) -> Result<(), String> {
        if self.package_name != "@kyanitelabs/epoch" {
            return Err(format!("unexpected package name: {}", self.package_name));
        }
        if self.mcp_tool_names.len() != 24 {
            return Err(format!("expected 24 MCP tools, got {}", self.mcp_tool_names.len()));
        }
        if self.write_tool_names != ["record_actual", "batch_record_actuals"] {
            return Err(format!("unexpected write tools: {:?}", self.write_tool_names));
        }
        if self.http_routes.len() != 11 {
            return Err(format!("expected 11 HTTP routes, got {}", self.http_routes.len()));
        }
        if self.cli_command_paths.len() != 39 {
            return Err(format!(
                "expected 39 CLI command paths, got {}",
                self.cli_command_paths.len()
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::PublicSurfaceContract;

    const SURFACE: &str =
        include_str!("../../../../docs/superpowers/contracts/epoch-public-surface.json");

    #[test]
    fn parses_exported_public_surface_contract() {
        let contract = PublicSurfaceContract::parse(SURFACE).expect("valid contract JSON");
        contract.validate_milestone_zero().expect("valid milestone 0 surface");
        assert_eq!(contract.mcp_tool_names[0], "get_current_time");
        assert_eq!(contract.mcp_tool_names[23], "feedback_health");
    }
}
```

- [ ] **Step 3: Create library skeleton crates**

For each of `epoch-core`, `epoch-data`, `epoch-mcp`, `epoch-cli`, `epoch-http`, and `epoch-canary`, create this `Cargo.toml` shape with the package name changed to the crate name:

```toml
[package]
name = "epoch-core"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
epoch-contract = { path = "../epoch-contract" }
```

Create `src/lib.rs` for each crate with the crate label changed to match the crate:

```rust
pub fn crate_label() -> &'static str {
    "epoch-core"
}

#[cfg(test)]
mod tests {
    use super::crate_label;

    #[test]
    fn reports_crate_label() {
        assert_eq!(crate_label(), "epoch-core");
    }
}
```

The six labels are:

```text
epoch-core
epoch-data
epoch-mcp
epoch-cli
epoch-http
epoch-canary
```

- [ ] **Step 4: Run Rust verification**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml --workspace
```

Expected: PASS for all Rust crates.

- [ ] **Step 5: Run TypeScript verification**

Run:

```bash
pnpm run typecheck && pnpm exec vitest run src/contract/public-surface.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the public leak audit for this task**

Run:

```bash
rg -n "/Users/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|API[_-]?KEY\\s*=|SECRET\\s*=|PASSWORD\\s*=|PRIVATE KEY|BEGIN (RSA|OPENSSH|PRIVATE)|PATH=|HOME=|TMPDIR=|100\\.[0-9]+\\.[0-9]+\\.[0-9]+" rust
```

Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add rust
git commit -m "build: add Rust Epoch workspace skeleton"
```

---

### Task 4: Rust Drift Gate

**Files:**
- Modify: `rust/Cargo.toml`
- Create: `rust/crates/xtask/Cargo.toml`
- Create: `rust/crates/xtask/src/main.rs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `epoch_contract::PublicSurfaceContract`.
- Produces: `cargo run --manifest-path rust/Cargo.toml -p xtask -- check` and `pnpm run verify:rust-milestone0`.

- [ ] **Step 1: Add `xtask` to the workspace**

Modify `rust/Cargo.toml` so the `members` list becomes:

```toml
members = [
  "crates/epoch-contract",
  "crates/epoch-core",
  "crates/epoch-data",
  "crates/epoch-mcp",
  "crates/epoch-cli",
  "crates/epoch-http",
  "crates/epoch-canary",
  "crates/xtask",
]
```

- [ ] **Step 2: Create `xtask` manifest**

Create `rust/crates/xtask/Cargo.toml`:

```toml
[package]
name = "xtask"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
anyhow.workspace = true
epoch-contract = { path = "../epoch-contract" }
```

- [ ] **Step 3: Create `xtask` command**

Create `rust/crates/xtask/src/main.rs`:

```rust
use anyhow::{bail, Context, Result};
use epoch_contract::PublicSurfaceContract;
use std::fs;
use std::path::{Path, PathBuf};

fn main() -> Result<()> {
    let command = std::env::args().nth(1).unwrap_or_else(|| "check".to_string());
    match command.as_str() {
        "check" => check_contract(Path::new(".")),
        other => bail!("unknown xtask command: {other}"),
    }
}

fn check_contract(repo_root: &Path) -> Result<()> {
    let contract_path: PathBuf = repo_root
        .join("docs")
        .join("superpowers")
        .join("contracts")
        .join("epoch-public-surface.json");

    let raw = fs::read_to_string(&contract_path)
        .with_context(|| format!("failed to read {}", contract_path.display()))?;
    let contract = PublicSurfaceContract::parse(&raw).context("invalid public surface JSON")?;
    contract
        .validate_milestone_zero()
        .map_err(anyhow::Error::msg)?;

    println!(
        "Epoch public surface OK: {} tools, {} HTTP routes, {} CLI command paths",
        contract.mcp_tool_names.len(),
        contract.http_routes.len(),
        contract.cli_command_paths.len()
    );

    Ok(())
}
```

- [ ] **Step 4: Add or confirm package scripts**

Ensure `package.json` contains these exact scripts inside `"scripts"`:

```json
"contract:inventory": "tsx src/contract/export-public-surface.ts",
"rust:check": "cargo test --manifest-path rust/Cargo.toml --workspace && cargo run --manifest-path rust/Cargo.toml -p xtask -- check",
"verify:rust-milestone0": "pnpm run contract:inventory && pnpm run typecheck && pnpm test && pnpm run rust:check"
```

If Task 2 already added `rust:check`, replace its value with the longer command above.

- [ ] **Step 5: Run the drift gate directly**

Run:

```bash
cargo run --manifest-path rust/Cargo.toml -p xtask -- check
```

Expected:

```text
Epoch public surface OK: 24 tools, 11 HTTP routes, 39 CLI command paths
```

- [ ] **Step 6: Run the full milestone verifier**

Run:

```bash
pnpm run verify:rust-milestone0
```

Expected: the contract artifact is regenerated, TypeScript checks pass, Vitest passes, Cargo tests pass, and `xtask check` prints the public-surface summary.

- [ ] **Step 7: Run the public leak audit for this task**

Run:

```bash
rg -n "/Users/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|API[_-]?KEY\\s*=|SECRET\\s*=|PASSWORD\\s*=|PRIVATE KEY|BEGIN (RSA|OPENSSH|PRIVATE)|PATH=|HOME=|TMPDIR=|100\\.[0-9]+\\.[0-9]+\\.[0-9]+" rust/crates/xtask package.json docs/superpowers/contracts/epoch-public-surface.json
```

Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add package.json rust/Cargo.toml rust/crates/xtask docs/superpowers/contracts/epoch-public-surface.json
git commit -m "build: add Rust public surface drift gate"
```

---

## Completion Gate

Before marking Milestone 0 complete, run:

```bash
pnpm run verify:rust-milestone0
git status --short
```

Expected:

```text
```

`git status --short` must print nothing after all task commits.

## Follow-On Plan Split

After Milestone 0 lands, create separate implementation plans in this order:

1. npm bridge and binary distribution decision.
2. Contract types and schemas for temporal/calendar tools.
3. Core Rust parity for temporal/calendar tools.
4. Contract types and schemas for estimation/risk/cost tools.
5. Core Rust parity for estimation/risk/cost tools.
6. Feedback and local-data read compatibility.
7. MCP adapter.
8. CLI adapter.
9. HTTP adapter and OpenAPI.
10. Local canary and replacement release gate.

Each follow-on plan must start from the tracked JSON contract artifact and must include a public leak audit before any commit.
