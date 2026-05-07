# Contributing to Epoch

Thank you for your interest in contributing to Epoch!

## Development Setup

```bash
git clone https://github.com/KyaniteLabs/Epoch.git
cd Epoch
pnpm install
pnpm run build
pnpm test
```

## Pull Request Process

1. Fork the repository and create a feature branch
2. Make your changes with tests
3. Ensure `pnpm run typecheck` and `pnpm test` pass
4. Submit a PR with a clear description

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation changes
- `refactor:` code restructuring
- `test:` test additions/changes
- `chore:` build, tooling, or CI changes

## Code Requirements

- TypeScript strict mode with `noUncheckedIndexedAccess`
- All new tools must have Zod schemas with `.describe()` on every field
- Co-located test files (`*.test.ts`) with vitest
- Zero `any` types

## Community Data

See [CONTRIBUTING-data.md](./CONTRIBUTING-data.md) for guidelines on contributing estimation data.

<!-- EMPOWER_ORCHESTRATOR:START -->
## Agent-law contribution rule

This repository follows the Empower Orchestrator law in `docs/agent-law/empower-orchestrator.md`.

If a change exposes a repeated task or repeated agent failure, contributors and agents should either ship the smallest durable prevention artifact or explain why this PR is intentionally one-off.

Automation and durable system changes require the scale/severity/reversibility/predictability blast-radius check before dispatch.
<!-- EMPOWER_ORCHESTRATOR:END -->
