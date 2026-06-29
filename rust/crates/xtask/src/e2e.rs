//! End-to-end public-surface promotion gate.
//!
//! Spawns the compiled `epoch-cli`, `epoch-mcp`, and `epoch-http` binaries and
//! exercises every surface the TypeScript oracle declares in
//! `docs/superpowers/contracts/epoch-public-surface.json`:
//!
//! - 24 MCP tools, called over MCP `tools/call`, HTTP `POST /v1/tools/:name`,
//!   and the CLI dispatcher.
//! - 39 CLI command paths, each run through the real `epoch-cli` binary.
//! - 11 HTTP routes, each hit against the real `epoch-http` server.
//! - HTTP deploy configuration compatibility with the TypeScript env contract.
//! - MCP function-calling metadata (`tools/list`: name, description,
//!   inputSchema, annotations) for all 24 tools.
//!
//! Unlike the in-process crate tests, this gate drives the binary entrypoints
//! as black boxes, so it catches missing wiring in `main.rs` argument parsing,
//! JSON-RPC framing, and HTTP routing. It writes a machine-readable summary to
//! `docs/superpowers/reports/rust-promotion-e2e.json` and fails the process if
//! any declared surface is not present and callable.

use anyhow::{Context, Result, anyhow, bail};
use epoch_contract::{PublicSurfaceContract, find_tool, tool_registry};
use hmac::{Hmac, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

const REPORT_PATH: &str = "docs/superpowers/reports/rust-promotion-e2e.json";
const CONTRACT_PATH: &str = "docs/superpowers/contracts/epoch-public-surface.json";
const COVERAGE_CATEGORIES: [&str; 6] = [
    "mcp_metadata",
    "mcp_tools",
    "http_tools",
    "cli_commands",
    "http_routes",
    "http_deploy_env",
];

/// One probed public surface and whether the Rust clone exposes and runs it.
struct Surface {
    category: &'static str,
    surface: String,
    adapter: &'static str,
    /// Present and dispatched (not an "unknown command/tool/route" response).
    wired: bool,
    /// Returned a successful, non-error response.
    ok: bool,
    detail: String,
}

impl Surface {
    fn passing(&self) -> bool {
        self.wired && self.ok
    }

    fn to_json(&self) -> Value {
        json!({
            "category": self.category,
            "surface": self.surface,
            "adapter": self.adapter,
            "wired": self.wired,
            "ok": self.ok,
            "detail": self.detail,
        })
    }
}

struct Binaries {
    cli: PathBuf,
    mcp: PathBuf,
    http: PathBuf,
}

struct McpOutcome {
    surfaces: Vec<Surface>,
    initialize_ok: bool,
    tools_listed: usize,
}

pub fn run(repo_root: &Path) -> Result<()> {
    let contract = load_contract(repo_root)?;
    let binaries = locate_binaries()?;

    let mut surfaces = cli_sweep(&binaries.cli, &contract)?;
    let mcp = mcp_sweep(&binaries.mcp, &contract)?;
    surfaces.extend(http_sweep(&binaries.http, &contract)?);
    surfaces.extend(http_deploy_env_sweep(&binaries.http)?);
    surfaces.extend(mcp.surfaces);

    let report = build_report(&contract, &surfaces, mcp.initialize_ok, mcp.tools_listed);
    write_report(repo_root, &report)?;
    print_summary(&report);

    if report["pass"].as_bool().unwrap_or(false) {
        Ok(())
    } else {
        bail!("Rust promotion e2e gate FAILED — see {REPORT_PATH}");
    }
}

fn load_contract(repo_root: &Path) -> Result<PublicSurfaceContract> {
    let path = repo_root.join(CONTRACT_PATH);
    let raw = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "failed to read TypeScript surface contract {}",
            path.display()
        )
    })?;
    let contract = PublicSurfaceContract::parse(&raw).context("invalid public surface JSON")?;
    contract
        .validate_milestone_zero()
        .map_err(anyhow::Error::msg)
        .context("TypeScript oracle contract drifted before e2e could run")?;
    Ok(contract)
}

fn locate_binaries() -> Result<Binaries> {
    let exe = std::env::current_exe().context("failed to locate xtask executable")?;
    let dir = exe
        .parent()
        .ok_or_else(|| anyhow!("xtask executable has no parent directory"))?
        .to_path_buf();
    let suffix = std::env::consts::EXE_SUFFIX;
    let resolve = |name: &str| dir.join(format!("{name}{suffix}"));
    let binaries = Binaries {
        cli: resolve("epoch-cli"),
        mcp: resolve("epoch-mcp"),
        http: resolve("epoch-http"),
    };
    for (label, path) in [
        ("epoch-cli", &binaries.cli),
        ("epoch-mcp", &binaries.mcp),
        ("epoch-http", &binaries.http),
    ] {
        if !path.exists() {
            bail!(
                "missing {label} binary at {}\nBuild the adapters first: \
                 cargo build --manifest-path rust/Cargo.toml -p epoch-cli -p epoch-mcp -p epoch-http",
                path.display()
            );
        }
    }
    Ok(binaries)
}

// --- sample inputs ----------------------------------------------------------

fn pert_body() -> Value {
    json!({ "optimistic": 1, "most_likely": 2, "pessimistic": 4 })
}

/// Valid sample input for each tool, mirroring the dispatcher unit tests.
fn sample_input(tool: &str) -> Option<Value> {
    let value = match tool {
        "get_current_time" => json!({ "timezone": "UTC" }),
        "convert_timezone" => {
            json!({ "timestamp": "2026-06-24T12:00:00Z", "target_tz": "America/Los_Angeles" })
        }
        "parse_duration" => json!({ "duration_string": "1h" }),
        "time_math" => {
            json!({ "operation": "diff", "operands": { "start_date": "2026-06-24", "end_date": "2026-06-25" } })
        }
        "add_business_days" => json!({ "start_date": "2026-06-24", "days": 2 }),
        "count_business_days" => json!({ "start_date": "2026-06-24", "end_date": "2026-06-30" }),
        "pert_estimate" => pert_body(),
        "cocomo_estimate" => json!({ "kloc": 2 }),
        "sprint_forecast" => json!({ "backlog_points": 20, "velocity_history": [8, 10, 9] }),
        "critical_path" => {
            json!({ "tasks": [{ "name": "A", "duration": 1, "predecessors": [] }] })
        }
        "monte_carlo_schedule" => {
            json!({ "tasks": [{ "name": "A", "optimistic": 1, "most_likely": 2, "pessimistic": 4 }], "iterations": 10 })
        }
        "reference_class_estimate" => json!({ "task_type": "feature", "complexity": 3 }),
        "calibrate_estimates" => json!({ "team_id": "team-a" }),
        "token_time_bridge" => json!({ "tokens": 1000, "model": "gpt-4o-mini" }),
        "token_cost_estimate" => json!({ "tokens": 1000, "model": "gpt-4o-mini" }),
        "compare_models" => json!({ "tokens": 1000 }),
        "accuracy_trend" => json!({}),
        "schedule_risk" => json!({ "estimated_hours": 8 }),
        "cocomo_validate" => json!({ "dataset_filter": ["NASA93"] }),
        "cocomo_ground_truth" => json!({ "dataset_filter": ["NASA93"] }),
        // record_actual does not require the estimate to pre-exist; a fresh CLI
        // process still records a non-synthetic id successfully.
        "record_actual" => json!({ "estimate_id": "rust-estimate-1", "actual_hours": 2 }),
        "get_pending_estimates" => json!({}),
        "batch_record_actuals" => {
            json!({ "entries": [{ "estimate_id": "rust-estimate-2", "actual_hours": 3 }] })
        }
        "feedback_health" => json!({}),
        _ => return None,
    };
    Some(value)
}

fn tool_for_cli_command(command: &str) -> Option<&'static str> {
    tool_registry()
        .iter()
        .find(|tool| tool.cli_command == command)
        .map(|tool| tool.name)
}

// --- CLI sweep --------------------------------------------------------------

fn cli_sweep(bin: &Path, contract: &PublicSurfaceContract) -> Result<Vec<Surface>> {
    let mut out = Vec::new();
    let data_dir = isolated_data_dir("cli");
    for command in &contract.cli_command_paths {
        let input = match tool_for_cli_command(command) {
            Some(tool) => {
                sample_input(tool).ok_or_else(|| anyhow!("missing sample input for tool {tool}"))?
            }
            None => json!({}),
        };
        let mut args: Vec<String> = command.split(' ').map(str::to_string).collect();
        args.push(serde_json::to_string(&input)?);

        let mut cli = Command::new(bin);
        cli.env("EPOCH_DATA_DIR", &data_dir).args(&args);
        let output = cli
            .output()
            .with_context(|| format!("failed to spawn epoch-cli for `{command}`"))?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        let ok = output.status.success();
        let wired = ok || !stderr.contains("Unknown Rust CLI command");
        let detail = if ok {
            "exit 0".to_string()
        } else {
            format!(
                "exit {:?}: {}",
                output.status.code(),
                stderr.lines().next().unwrap_or("").trim()
            )
        };
        out.push(Surface {
            category: "cli_commands",
            surface: command.clone(),
            adapter: "cli",
            wired,
            ok,
            detail,
        });
    }
    remove_dir_if_exists(&data_dir);
    Ok(out)
}

// --- MCP sweep --------------------------------------------------------------

fn mcp_sweep(bin: &Path, contract: &PublicSurfaceContract) -> Result<McpOutcome> {
    let mut lines = vec![
        json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize" }).to_string(),
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }).to_string(),
    ];
    for (index, name) in contract.mcp_tool_names.iter().enumerate() {
        let input =
            sample_input(name).ok_or_else(|| anyhow!("missing sample input for tool {name}"))?;
        lines.push(
            json!({
                "jsonrpc": "2.0",
                "id": 2 + index,
                "method": "tools/call",
                "params": { "name": name, "arguments": input },
            })
            .to_string(),
        );
    }
    let payload = format!("{}\n", lines.join("\n"));

    let data_dir = isolated_data_dir("mcp");
    let mut child = Command::new(bin)
        .env("EPOCH_DATA_DIR", &data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to spawn epoch-mcp at {}", bin.display()))?;
    child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("epoch-mcp stdin unavailable"))?
        .write_all(payload.as_bytes())
        .context("failed to write MCP request stream")?;
    let output = child
        .wait_with_output()
        .context("failed to read epoch-mcp output")?;
    remove_dir_if_exists(&data_dir);
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut by_id: BTreeMap<i64, Value> = BTreeMap::new();
    for frame in parse_frames(&stdout) {
        if let Some(id) = frame.get("id").and_then(Value::as_i64) {
            by_id.insert(id, frame);
        }
    }

    let initialize_ok = by_id
        .get(&0)
        .and_then(|r| r.get("result"))
        .and_then(|r| r.get("serverInfo"))
        .and_then(|s| s.get("name"))
        .and_then(Value::as_str)
        .is_some();

    let listed: Vec<Value> = by_id
        .get(&1)
        .and_then(|r| r.get("result"))
        .and_then(|r| r.get("tools"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tools_listed = listed.len();
    let metadata: BTreeMap<String, Value> = listed
        .into_iter()
        .filter_map(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .map(|name| (name.to_string(), tool.clone()))
        })
        .collect();

    let mut surfaces = Vec::new();
    for name in &contract.mcp_tool_names {
        let complete = metadata.get(name).is_some_and(metadata_complete);
        surfaces.push(Surface {
            category: "mcp_metadata",
            surface: name.clone(),
            adapter: "mcp",
            wired: complete,
            ok: complete,
            detail: if complete {
                "name+description+inputSchema+annotations present".to_string()
            } else {
                "incomplete function-calling metadata".to_string()
            },
        });
    }
    for (index, name) in contract.mcp_tool_names.iter().enumerate() {
        let response = by_id.get(&((2 + index) as i64));
        let (wired, ok, detail) = classify_mcp_call(response);
        surfaces.push(Surface {
            category: "mcp_tools",
            surface: name.clone(),
            adapter: "mcp",
            wired,
            ok,
            detail,
        });
    }

    Ok(McpOutcome {
        surfaces,
        initialize_ok,
        tools_listed,
    })
}

fn metadata_complete(tool: &Value) -> bool {
    let has_text = |key: &str| {
        tool.get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    has_text("name")
        && has_text("description")
        && tool.get("inputSchema").and_then(Value::as_object).is_some()
        && tool.get("annotations").and_then(Value::as_object).is_some()
}

fn classify_mcp_call(response: Option<&Value>) -> (bool, bool, String) {
    let Some(response) = response else {
        return (false, false, "no MCP response".to_string());
    };
    if let Some(error) = response.get("error") {
        return (false, false, format!("json-rpc error: {error}"));
    }
    let result = response.get("result");
    let is_error = result
        .and_then(|value| value.get("isError"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !is_error {
        return (true, true, "structuredContent ok".to_string());
    }
    let message = result
        .and_then(|value| value.get("structuredContent"))
        .and_then(|value| value.get("error"))
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("unknown tool error");
    let wired = !message.contains("Unknown tool");
    (wired, false, format!("tool error: {message}"))
}

fn parse_frames(input: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    let mut rest = input;
    while let Some(start) = rest.find("Content-Length:") {
        rest = &rest[start..];
        let Some((header_len, separator)) = rest
            .find("\r\n\r\n")
            .map(|index| (index, 4))
            .or_else(|| rest.find("\n\n").map(|index| (index, 2)))
        else {
            break;
        };
        let content_length = rest[..header_len].lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        });
        let Some(length) = content_length else { break };
        let body_start = header_len + separator;
        let body_end = body_start + length;
        if body_end > rest.len() {
            break;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&rest[body_start..body_end]) {
            frames.push(value);
        }
        rest = &rest[body_end..];
    }
    frames
}

// --- HTTP sweep -------------------------------------------------------------

fn http_sweep(bin: &Path, contract: &PublicSurfaceContract) -> Result<Vec<Surface>> {
    let port = free_port()?;
    let addr = format!("127.0.0.1:{port}");
    let data_dir = isolated_data_dir("http");
    let mut child = Command::new(bin)
        .env("EPOCH_DATA_DIR", &data_dir)
        .arg(&addr)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to spawn epoch-http at {}", bin.display()))?;

    let work = (|| -> Result<Vec<Surface>> {
        wait_for_server(&addr)?;
        let mut out = Vec::new();

        for name in &contract.mcp_tool_names {
            let (status, body) = http_tool_request(&addr, name)?;
            out.push(http_tool_surface(
                "http_tools",
                format!("POST /v1/tools/{name}"),
                status,
                &body,
            ));
        }
        for route in &contract.http_routes {
            let (status, _) = http_route_request(&addr, route)?;
            out.push(http_surface("http_routes", route.clone(), status));
        }
        Ok(out)
    })();

    let _ = child.kill();
    let _ = child.wait();
    remove_dir_if_exists(&data_dir);
    work
}

fn http_deploy_env_sweep(bin: &Path) -> Result<Vec<Surface>> {
    let checks = [
        HttpDeployCheck::env_port("EPOCH_HOST + EPOCH_PORT", "EPOCH_PORT")?,
        HttpDeployCheck::env_port("PORT fallback", "PORT")?,
        HttpDeployCheck::env_addr("EPOCH_HTTP_ADDR")?,
        HttpDeployCheck::help(),
    ];
    checks
        .into_iter()
        .map(|check| check.run(bin))
        .collect::<Result<Vec<_>>>()
}

struct HttpDeployCheck {
    surface: &'static str,
    env: Vec<(&'static str, String)>,
    mode: HttpDeployCheckMode,
}

enum HttpDeployCheckMode {
    Health { addr: String },
    Help,
}

impl HttpDeployCheck {
    fn env_port(surface: &'static str, port_var: &'static str) -> Result<Self> {
        let port = free_port()?;
        Ok(Self {
            surface,
            env: vec![
                ("EPOCH_HOST", "127.0.0.1".to_string()),
                (port_var, port.to_string()),
            ],
            mode: HttpDeployCheckMode::Health {
                addr: format!("127.0.0.1:{port}"),
            },
        })
    }

    fn env_addr(surface: &'static str) -> Result<Self> {
        let port = free_port()?;
        let addr = format!("127.0.0.1:{port}");
        Ok(Self {
            surface,
            env: vec![("EPOCH_HTTP_ADDR", addr.clone())],
            mode: HttpDeployCheckMode::Health { addr },
        })
    }

    fn help() -> Self {
        Self {
            surface: "--help",
            env: Vec::new(),
            mode: HttpDeployCheckMode::Help,
        }
    }

    fn run(self, bin: &Path) -> Result<Surface> {
        match self.mode {
            HttpDeployCheckMode::Health { ref addr } => Ok(self.run_health(bin, addr)),
            HttpDeployCheckMode::Help => self.run_help(bin),
        }
    }

    fn run_health(&self, bin: &Path, addr: &str) -> Surface {
        let data_dir = isolated_data_dir("http-deploy");
        let mut command = Command::new(bin);
        clear_http_env(&mut command);
        command.env("EPOCH_DATA_DIR", &data_dir);
        for (name, value) in &self.env {
            command.env(name, value);
        }
        command.stdout(Stdio::null()).stderr(Stdio::null());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return http_deploy_surface(self.surface, false, format!("spawn failed: {error}"));
            }
        };
        let result = (|| -> Result<(u16, String)> {
            wait_for_server(addr)?;
            http_request(addr, "GET", "/health", None)
        })();
        let _ = child.kill();
        let _ = child.wait();
        remove_dir_if_exists(&data_dir);

        match result {
            Ok((status, body)) => {
                let ok = status == 200 && health_body_ok(&body);
                http_deploy_surface(self.surface, ok, format!("status {status}, health {ok}"))
            }
            Err(error) => http_deploy_surface(self.surface, false, error.to_string()),
        }
    }

    fn run_help(&self, bin: &Path) -> Result<Surface> {
        let mut command = Command::new(bin);
        clear_http_env(&mut command);
        let output = command
            .arg("--help")
            .output()
            .with_context(|| format!("failed to run {} --help", bin.display()))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let ok = output.status.success()
            && stdout.contains("EPOCH_PORT")
            && stdout.contains("PORT")
            && stdout.contains("EPOCH_HTTP_ADDR");
        Ok(http_deploy_surface(
            self.surface,
            ok,
            format!(
                "exit {:?}, documents env {}",
                output.status.code(),
                stdout.contains("EPOCH_PORT")
            ),
        ))
    }
}

fn clear_http_env(command: &mut Command) {
    for name in ["EPOCH_HTTP_ADDR", "EPOCH_HOST", "EPOCH_PORT", "PORT"] {
        command.env_remove(name);
    }
}

fn isolated_data_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "epoch-rust-e2e-{label}-{}-{}",
        std::process::id(),
        nanos
    ))
}

fn remove_dir_if_exists(path: &Path) {
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn health_body_ok(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    value.get("status").and_then(Value::as_str) == Some("ok")
}

fn http_deploy_surface(surface: &'static str, ok: bool, detail: String) -> Surface {
    Surface {
        category: "http_deploy_env",
        surface: surface.to_string(),
        adapter: "http",
        wired: ok,
        ok,
        detail,
    }
}

fn http_surface(category: &'static str, surface: String, status: u16) -> Surface {
    Surface {
        category,
        surface,
        adapter: "http",
        wired: status != 404,
        ok: status == 200 || status == 202,
        detail: format!("status {status}"),
    }
}

fn http_tool_surface(category: &'static str, surface: String, status: u16, body: &str) -> Surface {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let has_success_envelope = parsed
        .as_ref()
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        == Some(true)
        && parsed
            .as_ref()
            .and_then(|value| value.get("data"))
            .is_some();

    Surface {
        category,
        surface,
        adapter: "http",
        wired: status != 404,
        ok: status == 200 && has_success_envelope,
        detail: format!("status {status}, successEnvelope {has_success_envelope}"),
    }
}

fn http_tool_request(addr: &str, tool: &str) -> Result<(u16, String)> {
    let body = match tool {
        "record_actual" => {
            json!({ "estimate_id": http_create_estimate(addr)?, "actual_hours": 2 })
        }
        "batch_record_actuals" => {
            json!({ "entries": [{ "estimate_id": http_create_estimate(addr)?, "actual_hours": 3 }] })
        }
        other => sample_input(other).ok_or_else(|| anyhow!("missing sample input for {other}"))?,
    };
    http_request(addr, "POST", &format!("/v1/tools/{tool}"), Some(&body))
}

fn http_route_request(addr: &str, route: &str) -> Result<(u16, String)> {
    let (method, template) = route
        .split_once(' ')
        .ok_or_else(|| anyhow!("malformed route `{route}`"))?;
    let (path, body): (String, Option<Value>) = match (method, template) {
        ("POST", "/v1/tools/:toolName") => {
            ("/v1/tools/pert_estimate".to_string(), Some(pert_body()))
        }
        ("POST", "/v1/telemetry") => return http_signed_telemetry_request(addr, template),
        ("POST", "/v1/feedback/record-actual") => (
            template.to_string(),
            Some(json!({ "estimate_id": http_create_estimate(addr)?, "actual_hours": 2 })),
        ),
        ("POST", "/v1/feedback/batch-record-actuals") => (
            template.to_string(),
            Some(json!({
                "entries": [{ "estimate_id": http_create_estimate(addr)?, "actual_hours": 3 }]
            })),
        ),
        (_, path) => (path.to_string(), None),
    };
    http_request(addr, method, &path, body.as_ref())
}

fn http_signed_telemetry_request(addr: &str, path: &str) -> Result<(u16, String)> {
    let installation_id = "epoch-rust-e2e-installation";
    let payload = json!({
        "schema_version": 1,
        "installation_id": installation_id,
        "epoch_version": "0.2.9-rust-e2e",
        "records": [{
            "task_type": "feature",
            "complexity": 3,
            "tool": "promotion-e2e",
            "estimated_hours": 4,
            "actual_hours": 5,
            "ratio": 1.25,
            "date": "2026-05-07",
            "completed_at": "2026-05-07T00:00:00.000Z"
        }],
        "generated_at": "2026-05-07T00:00:00.000Z",
    });
    let raw_body = payload.to_string();
    let signature = sign_payload(&raw_body, installation_id);
    http_request_with_headers(
        addr,
        "POST",
        path,
        &raw_body,
        &[
            ("X-Epoch-Signature", signature.as_str()),
            ("X-Epoch-Version", "0.2.9-rust-e2e"),
        ],
    )
}

/// Creates a fresh estimate over HTTP and returns its feedback reference, so
/// write-tool probes always target an existing, non-duplicate id.
fn http_create_estimate(addr: &str) -> Result<String> {
    let (_, body) = http_request(addr, "POST", "/v1/tools/pert_estimate", Some(&pert_body()))?;
    serde_json::from_str::<Value>(&body)
        .ok()
        .as_ref()
        .and_then(|value| value.get("data"))
        .and_then(|data| data.get("feedbackRef"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("pert_estimate over HTTP returned no feedbackRef"))
}

fn http_request(
    addr: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<(u16, String)> {
    let body = body.map(Value::to_string).unwrap_or_default();
    http_request_with_headers(addr, method, path, &body, &[])
}

fn http_request_with_headers(
    addr: &str,
    method: &str,
    path: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> Result<(u16, String)> {
    let extra_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\n\
         {extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut stream =
        TcpStream::connect(addr).with_context(|| format!("failed to connect to {addr}"))?;
    stream
        .write_all(request.as_bytes())
        .context("failed to write HTTP request")?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .context("failed to read HTTP response")?;
    let text = String::from_utf8_lossy(&raw);
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("missing HTTP status line in response"))?;
    let response_body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    Ok((status, response_body))
}

fn sign_payload(raw_body: &str, installation_id: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(installation_id.as_bytes()).expect("HMAC key is valid");
    mac.update(raw_body.as_bytes());
    hex_lower(&mac.finalize().into_bytes())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

fn free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").context("failed to reserve a local port")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn wait_for_server(addr: &str) -> Result<()> {
    for _ in 0..200 {
        if TcpStream::connect(addr).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    bail!("epoch-http did not start listening on {addr}");
}

// --- report -----------------------------------------------------------------

fn build_report(
    contract: &PublicSurfaceContract,
    surfaces: &[Surface],
    initialize_ok: bool,
    tools_listed: usize,
) -> Value {
    let mut coverage = Map::new();
    let mut failures = Vec::new();
    let mut total_expected = 0_usize;
    let mut total_passing = 0_usize;

    for category in COVERAGE_CATEGORIES {
        let items: Vec<&Surface> = surfaces.iter().filter(|s| s.category == category).collect();
        let expected = items.len();
        let wired = items.iter().filter(|s| s.wired).count();
        let ok = items.iter().filter(|s| s.ok).count();
        let passing = items.iter().filter(|s| s.passing()).count();
        total_expected += expected;
        total_passing += passing;
        for surface in &items {
            if !surface.passing() {
                failures.push(surface.to_json());
            }
        }
        coverage.insert(
            category.to_string(),
            json!({
                "expected": expected,
                "wired": wired,
                "ok": ok,
                "passing": passing,
                "percent": round2(percent(passing, expected)),
            }),
        );
    }

    let write_tools = contract
        .write_tool_names
        .iter()
        .map(|name| {
            let cli_command = find_tool(name).map(|tool| tool.cli_command).unwrap_or("");
            let adapter_ok = |category: &str, surface_match: &dyn Fn(&Surface) -> bool| {
                surfaces
                    .iter()
                    .any(|s| s.category == category && s.passing() && surface_match(s))
            };
            (
                name.clone(),
                json!({
                    "mcp": adapter_ok("mcp_tools", &|s: &Surface| s.surface == *name),
                    "http": adapter_ok("http_tools", &|s: &Surface| {
                        s.surface == format!("POST /v1/tools/{name}")
                    }),
                    "cli": adapter_ok("cli_commands", &|s: &Surface| s.surface == cli_command),
                }),
            )
        })
        .collect::<Map<String, Value>>();

    let tool_count = contract.mcp_tool_names.len();
    let pass = failures.is_empty() && initialize_ok && tools_listed == tool_count;

    json!({
        "gate": "rust-promotion-e2e",
        "pass": pass,
        "package_name": contract.package_name,
        "source_of_truth": CONTRACT_PATH,
        "claim": "Rust clone exposes >=100% of the TypeScript public surface",
        "expected": {
            "tools": tool_count,
            "cli_commands": contract.cli_command_paths.len(),
            "http_routes": contract.http_routes.len(),
            "write_tools": contract.write_tool_names.len(),
        },
        "mcp": {
            "initialize_ok": initialize_ok,
            "tools_listed": tools_listed,
        },
        "coverage": Value::Object(coverage),
        "overall_surface_percent": round2(percent(total_passing, total_expected)),
        "write_tool_adapters": Value::Object(write_tools),
        "failures": failures,
        "surfaces": surfaces.iter().map(Surface::to_json).collect::<Vec<_>>(),
    })
}

fn percent(part: usize, whole: usize) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 / whole as f64 * 100.0
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn write_report(repo_root: &Path, report: &Value) -> Result<()> {
    let path = repo_root.join(REPORT_PATH);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let serialized = serde_json::to_string_pretty(report)?;
    std::fs::write(&path, format!("{serialized}\n"))
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn print_summary(report: &Value) {
    println!(
        "Rust promotion e2e: {} ({}% of declared surfaces callable)",
        if report["pass"].as_bool().unwrap_or(false) {
            "PASS"
        } else {
            "FAIL"
        },
        report["overall_surface_percent"]
    );
    if let Some(coverage) = report["coverage"].as_object() {
        for category in COVERAGE_CATEGORIES {
            if let Some(entry) = coverage.get(category) {
                println!(
                    "  {category:<13} {}/{} passing ({}%)",
                    entry["passing"], entry["expected"], entry["percent"]
                );
            }
        }
    }
    if let Some(failures) = report["failures"].as_array() {
        for failure in failures {
            println!(
                "  FAIL {} [{}] {}",
                failure["surface"], failure["adapter"], failure["detail"]
            );
        }
    }
    println!("  report: {REPORT_PATH}");
}
