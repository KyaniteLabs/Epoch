use anyhow::{Context, Result, bail};
use epoch_contract::PublicSurfaceContract;
use std::fs;
use std::path::{Path, PathBuf};

mod e2e;

fn main() -> Result<()> {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "check".to_string());
    match command.as_str() {
        "check" => check_contract(Path::new(".")),
        "e2e" => e2e::run(Path::new(".")),
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
        contract.cli_command_paths.len(),
    );

    Ok(())
}
