# KyaniteLabs Engineering Rules

**Repository**: Epoch
**Description**: Time Estimation MCP Server — 19 structured tools for PERT, COCOMO II, Monte Carlo simulation, sprint forecasting, token-to-time mapping, cost estimation, schedule risk analysis, and model comparison. Self-improving engine with community data pipeline. Built for LLMs and AI agents. MCP + CLI + REST API.
**Tech Stack**: TypeScript/Node

This file is loaded automatically by Claude Code when working in any KyaniteLabs repository. It supplements the global rules in `~/.claude/CLAUDE.md`.

See KyaniteLabs/.github for org-wide rules. Project-specific rules below:

## Project-Specific Context

This is the **Epoch** repository. It is Time Estimation MCP Server — 19 structured tools for PERT, COCOMO II, Monte Carlo simulation, sprint forecasting, token-to-time mapping, cost estimation, schedule risk analysis, and model comparison. Self-improving engine with community data pipeline. Built for LLMs and AI agents. MCP + CLI + REST API..

# KyaniteLabs Engineering Rules

This file is loaded automatically by Claude Code when working in any KyaniteLabs repository. It supplements the global rules in `~/.claude/CLAUDE.md`.

## Organization Principles

- **Local-first when it matters** — keep data, creative work, and knowledge close to the people who own it
- **Useful over flashy** — solve real workflow problems
- **Human-in-the-loop by design** — AI accelerates judgment, it doesn't erase it
- **Open where it helps** — public projects are documented for discovery and reuse
- **Craft matters** — README quality, tests, and maintenance are part of the product

## Issue-Driven Development

All contributions to KyaniteLabs repos flow through GitHub issues.

### Workflow

```
External contributor opens issue
  → Template applies: bug/enhancement + needs-triage label
  → Maintainer reviews, adds: approved label
  → Auto-triage promotes to: agent-ready label
  → Pipeline picks up → creates fix PR

Owner/member (simongonzalezdc) opens issue
  → Auto-triage detects member author
  → Promotes directly to agent-ready (skips triage)
  → Pipeline picks up → creates fix PR
```

### Label System

| Label | Meaning | Who sets it |
|-------|---------|------------|
| `needs-triage` | New issue, awaiting review | Issue template (auto) |
| `approved` | Maintainer approved for work | Maintainer (manual) |
| `agent-ready` | Ready for pipeline to pick up | Auto-triage (auto) |
| `bug` | Bug report | Issue template (auto) |
| `enhancement` | Feature request | Issue template (auto) |
| `repo-pipeline` | Created by pipeline scanner | Pipeline (auto) |
| `ci-failure` | CI broke on main branch | Pipeline (auto) |
| `severity:low/medium/high/critical` | Impact level | Pipeline (auto) |

### Rules for Agents Creating Issues

- Never create issues without the `repo-pipeline` label
- Always include reproduction steps or evidence
- Set severity based on: does it break main? does it affect users? is it cosmetic?
- Link to the relevant CI run, commit, or file

## Pipeline Awareness

The GITHUB_pipeline runs a triage cycle every 30 minutes. When working in KyaniteLabs repos, be aware:

1. **Your PRs will be monitored** by `pr-maintainer.py` — it fixes CI failures, rebases, and addresses review comments
2. **Do not delete `fix/issue-*` branches** — the pipeline manages these
3. **Pipeline-created issues** have the `repo-pipeline` label — treat them as real issues
4. **Circuit breaker** — if the pipeline enters RED state, all automated work stops until manually reset
5. **Issue priority** — pipeline sorts by severity (critical > high > medium > low), then by age

## CI Standards

All KyaniteLabs repos must have these CI checks (via GitHub Actions on Blacksmith runners):

### Required Checks (must pass before merge)

| Check | Tool | Config |
|-------|------|--------|
| Lint | ruff | `ruff check . && ruff format --check .` |
| Test | pytest | `pytest --tb=short -q` |
| Build | pip install | `pip install -e .` (Python) or equivalent |

### Recommended Checks (add when applicable)

| Check | Tool | When |
|-------|------|------|
| Security scan | bandit + pip-audit | Python repos |
| Type check | mypy | repos with type annotations |
| Docker build | docker build | repos with Dockerfile |
| Package surface | custom script | published packages |
| Compatibility matrix | multi-Python/Node | public packages |

### CI Rules

- All CI runs on `blacksmith-2vcpu-ubuntu-2404` runners
- CI must pass on all supported Python/Node versions
- Never skip CI (`--no-verify`) — if it fails, fix the root cause
- CI failures on main get auto-detected by the pipeline

## Branch Protection

All `main`/`master` branches in KyaniteLabs repos are protected:

- No direct pushes — everything through PRs
- Required status checks must pass
- Branches must be up-to-date before merge
- Force pushes blocked
- Linear history required (squash or rebase merge)

## Repository Standards

### Python Repos
- **Formatter**: ruff (not black)
- **Linter**: ruff
- **Config**: `pyproject.toml` (not setup.py/setup.cfg)
- **Python**: minimum 3.11, test on 3.11 and latest
- **Dependencies**: pin exact versions

### Node/TypeScript Repos
- **Package manager**: pnpm (not npm/yarn)
- **Formatter**: prettier
- **Linter**: eslint

### All Repos
- **README.md**: Must explain what it is, how to run it, how to test it
- **CHANGELOG.md**: Updated with every release
- **LICENSE**: MIT (org default)
- **CONTRIBUTING.md**: Points to org contributing guide

## Git Workspace Hygiene
- Delete feature branches after merge — no stale branches
- Remove worktrees when done — no orphaned worktrees
- Prune stale remote references (`git remote prune origin`)
- Clean working directory when task is done (`git status` clean)
- Delete abandoned branches — don't leave dead work behind
- Main branch is the only permanent artifact — everything else is temporary

## Epoch Data Tracking
- Use Epoch for time estimation before starting tasks (MCP, REST API, or CLI)
- Record actual time after completing tasks (`record_actual`)
- Every project feeds data to Epoch — it's how the system learns
- Epoch only works if everyone contributes estimate-vs-actual data

## Agent Coordination

When multiple agents work on the same repo:

1. **Claim your scope** — note in the issue which files/areas you're working on
2. **Don't edit files another agent is actively modifying** — check open PRs first
3. **Rebase frequently** — pull from main before pushing to avoid conflicts
4. **Test before pushing** — run the same CI checks locally first
5. **Communicate via issues** — leave comments on issues for context, not in code
