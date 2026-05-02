# Epoch Ship-Ready Polish — Full Design Spec

**Date:** 2026-05-01
**Status:** Approved (9/10 sections; Section 5 — Test Coverage — deferred)
**Scope:** Full deep clean + full expansion. "Most polished, most amazing repo."

---

## Section 1: Unify Dual Registration Architecture

### Problem

Every tool is registered twice through completely separate paths:

1. `src/dispatcher/tool-registry.ts` (669 lines) — registers all 19 tools with handler functions for CLI and HTTP
2. `src/tools/*.ts` (temporal.ts, estimation.ts, analytics.ts) — registers the same 19 tools with `McpServer` for MCP stdio

Consequences:
- 10 inline Zod schemas in tool-registry.ts duplicate `schemas/index.ts`
- 130+ lines of duplicated `time_math` handler logic
- 30+ `as string`/`as number` type assertions because dispatcher handlers receive `Record<string, unknown>`
- Bug fixes must be applied in two places

### Solution

Make `server.tool()` calls the single source of truth. The dispatcher routes CLI and HTTP requests through the same handler functions that MCP uses.

**Implementation:**
- Extract handler functions from `tools/*.ts` into shared handler modules
- `tool-registry.ts` imports and calls the same handlers — no duplication
- Handler functions receive properly typed Zod-inferred input instead of `Record<string, unknown>`
- Eliminate 10 inline schemas — dispatcher reads from `schemas/index.ts`
- `tool-registry.ts` shrinks from ~669 to ~200 lines

### Files
- `src/dispatcher/tool-registry.ts` — rewrite to use shared handlers
- `src/tools/temporal.ts` — extract handlers, keep MCP registration
- `src/tools/estimation.ts` — extract handlers, keep MCP registration
- `src/tools/analytics.ts` — extract handlers, keep MCP registration
- `src/dispatcher/index.ts` — update dispatch() to use new handler signatures

---

## Section 2: Package Hygiene

### Problem

`package.json` is missing fields required for a proper npm package. Publishing today would ship test files, scripts, data directories, and config. Type declarations are empty (`export {}`).

### Solution

```jsonc
// Add to package.json
{
  "files": ["dist"],
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "types": "./dist/index.d.ts",
  "engines": { "node": ">=20" },
  "bugs": { "url": "https://github.com/KyaniteLabs/Epoch/issues" },
  "homepage": "https://github.com/KyaniteLabs/Epoch#readme"
}
```

Fix empty type declarations:
- `src/index.ts` currently has no named exports (only calls `main()`)
- Add re-export of types: `export type * from './types/index.js'` and `export type * from './schemas/index.js'`
- tsup's `dts: true` will then generate real declarations

Add `.npmignore`:
```
src/
*.test.ts
docs/
data/
scripts/
.omc/
.omx/
site/
coverage/
canary-*
Research/
*.md
!README.md
!LICENSE
```

### Files
- `package.json` — add 6 fields
- `src/index.ts` — add type re-exports
- `.npmignore` — new file

---

## Section 3: CLI Parity + Stale References

### Problem

5 of 19 tools have no CLI subcommands. HTTP discovery endpoints say "14 tools" (stale). `index.ts` hardcodes `CLI_SUBCOMMANDS` with only 15 entries.

### Solution

Add 5 CLI commands following existing pattern in `cli.ts`:
- `token-cost-estimate` — tokens, model, tool-calls, reasoning-depth
- `compare-models` — tokens, tool-calls, reasoning-depth, sort-by
- `accuracy-trend` — window-size, team-id
- `schedule-risk` — estimated-hours, task-type, team-id, confidence-level
- `cocomo-validate` — dataset-filter

Update stale references:
- `http.ts:18` — AI plugin: "14 tools" → "19 tools"
- `http.ts:29` — llms.txt: "14 tools" → "19 tools"
- `http.ts:332` — OpenAPI: "14 tools" → "19 tools"
- `src/index.ts` — `CLI_SUBCOMMANDS` array: add 5 entries

Audit for hardcoded versions and npm references.

### Files
- `src/entries/cli.ts` — add 5 subcommands
- `src/entries/http.ts` — fix 3 stale counts
- `src/index.ts` — update CLI_SUBCOMMANDS

---

## Section 4: Type Safety Overhaul

### Problem

2 `as any` casts in http.ts (hand-rolled Zod-to-JSON-Schema converter). `cocomoEstimate` returns bare `CocomoResult` instead of `ToolResult<CocomoResult>`. Duplicated utility functions. Unused types. Dead tsconfig entries.

### Solution

4a. Replace `zodToJsonSchema` (http.ts:137-238, 100 lines) with `@asteasolutions/zod-to-openapi`:
- Package is already in devDependencies
- Eliminates 2 `as any` casts and fragile Zod internal API access
- Production-grade OpenAPI 3.1 output

4b. Fix `cocomoEstimate` return type:
- Change from `CocomoResult` to `ToolResult<CocomoResult>` for consistency
- Return `{ ok: false, error: ... }` on invalid input instead of zeroed result

4c. Extract shared utilities:
- `src/lib/internal/error-helpers.ts` — shared `makeError()` (currently duplicated in temporal.ts and calendar.ts)
- `src/lib/internal/urgency.ts` — shared `getUrgencyCategory()` (currently duplicated in estimation.ts and calendar.ts)

4d. CLI cleanup:
- Extract `getRootOpts(cmd)` helper — eliminates 14 identical `cmd.parent!` patterns

4e. Remove dead code:
- Delete unused `EstimationInput` type from `types/index.ts`
- Fix `tsconfig.json` — remove dead `exclude: ["tests"]` (no such directory)

4f. Add `satisfies` on output schema objects in tool-registry.ts

### Files
- `src/entries/http.ts` — replace zodToJsonSchema
- `src/lib/estimation.ts` — fix cocomoEstimate return type
- `src/lib/internal/error-helpers.ts` — new
- `src/lib/internal/urgency.ts` — new
- `src/lib/temporal.ts` — use shared makeError
- `src/lib/calendar.ts` — use shared makeError + getUrgencyCategory
- `src/lib/estimation.ts` — use shared getUrgencyCategory
- `src/entries/cli.ts` — extract getRootOpts helper
- `src/types/index.ts` — remove EstimationInput
- `tsconfig.json` — fix exclude

---

## Section 5: ~~Test Coverage to 90%+~~ — DEFERRED

Deferred per user direction. Will revisit after all other sections are complete.

---

## Section 6: Developer Experience Tooling

### Problem

No linter, no editor config. Code style enforced only by TypeScript strict mode.

### Solution

6a. ESLint flat config (`eslint.config.js`):
- `@eslint/js` recommended rules
- `typescript-eslint` strict rules
- No Prettier — ESLint + TypeScript strict is sufficient for this project
- Rules: no explicit `any` (error), consistent type imports, no unused vars

6b. `.editorconfig`:
```ini
root = true
[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
```

### Files
- `eslint.config.js` — new
- `.editorconfig` — new
- `package.json` — add `lint` script update, eslint devDependencies

---

## Section 7: HTTP Server Hardening

### Problem

No rate limiting. Unstructured 404s for non-tool paths. Binds to `0.0.0.0` with no auth.

### Solution

7a. Rate limiting middleware using a lightweight in-memory sliding window:
- Default: 100 requests/minute per IP
- Configurable via `EPOCH_RATE_LIMIT` env var
- Returns 429 with `retry-after` header

7b. Structured JSON 404 for all unmatched routes:
```json
{ "error": "Not found", "availableEndpoints": ["/health", "/v1/tools/{tool_name}", ...] }
```

7c. Default bind to `127.0.0.1` instead of `0.0.0.0`:
- Explicit `--host 0.0.0.0` flag or `EPOCH_HOST` env var to override
- Protects default deployments from network exposure

7d. MCP annotations on all 19 tools (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)

### Files
- `src/entries/http.ts` — add rate limiter, fix 404, change default host, add annotations
- `src/tools/temporal.ts` — add annotations to temporal tools
- `src/tools/estimation.ts` — add annotations to estimation tools
- `src/tools/analytics.ts` — add annotations to analytics tools

---

## Section 8: Release Infrastructure

### Problem

No contribution guide, no changelog, no release workflow, no issue templates.

### Solution

8a. `CONTRIBUTING.md`:
- PR process: fork → branch → PR → CI must pass
- Commit convention: conventional commits
- Code requirements: typecheck + tests pass
- Community data contribution pointer to CONTRIBUTING-data.md

8b. `CHANGELOG.md`:
- Keep a Changelog format
- Sections: Added, Changed, Fixed, Deprecated, Removed, Security
- Initial entry for 0.1.0 with all 19 tools

8c. GitHub release workflow (`.github/workflows/release.yml`):
- Triggers on tag `v*`
- Runs: typecheck → test → build → pnpm publish
- Uses `NODE_AUTH_TOKEN` secret

8d. Issue/PR templates:
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/PULL_REQUEST_TEMPLATE.md`

8e. `.github/dependabot.yml`:
- npm ecosystem, weekly checks, pnpm compatible

### Files
- `CONTRIBUTING.md` — new
- `CHANGELOG.md` — new
- `.github/workflows/release.yml` — new
- `.github/ISSUE_TEMPLATE/bug_report.md` — new
- `.github/ISSUE_TEMPLATE/feature_request.md` — new
- `.github/PULL_REQUEST_TEMPLATE.md` — new
- `.github/dependabot.yml` — new

---

## Section 9: Deep TypeScript Patterns (Matt Pocock Style)

### Problem

Domain concepts like hours, days, KLOC are plain `number` — nothing prevents mixing them up. Some functions bypass the discriminated union pattern. Escape hatches (`as unknown as`) exist.

### Solution

9a. Branded types for domain concepts:
```typescript
type Brand<T, B> = T & { __brand: B };
type Hours = Brand<number, "Hours">;
type Days = Brand<number, "Days">;
type Weeks = Brand<number, "Weeks">;
type Kloc = Brand<number, "Kloc">;
type CostUsd = Brand<number, "CostUsd">;
type Tokens = Brand<number, "Tokens">;
type TokensPerSecond = Brand<number, "TokensPerSecond">;
type Percentage = Brand<number, "Percentage">;
```

Factory functions: `hours(n)`, `days(n)`, etc. Only applied at module boundaries (user input parsing, external data). Internal code uses branded types throughout.

9b. Exhaustive switch patterns:
- Tool name routing uses `switch` with `never` exhaustiveness check
- Task type discriminated unions with exhaustive matching

9c. `satisfies` on all object literals:
- Schema definitions
- Tool registration options
- Configuration objects

9d. Total functions — no more `as unknown as Record<string, unknown>` escape hatches. All handler return types are `ToolResult<T>`.

### Files
- `src/types/index.ts` — add branded types and factory functions
- `src/schemas/index.ts` — apply satisfies
- `src/lib/estimation.ts` — use branded types
- `src/lib/cost.ts` — use branded types
- `src/lib/analytics.ts` — use branded types
- `src/lib/risk.ts` — use branded types
- All handler files — enforce ToolResult<T> return type

---

## Section 10: Repo Hygiene

### Problem

Dead code, undocumented env vars, potential npm references, untracked patterns in git.

### Solution

10a. Remove dead code:
- Unused `EstimationInput` type (covered in Section 4)
- Any other unused exports

10b. Document environment variables:
- `EPOCH_DATA_DIR` — data directory (default `~/.epoch/`)
- `EPOCH_TRANSPORT` — transport mode (`stdio` | `http`)
- `EPOCH_PORT` — HTTP server port
- `EPOCH_HOST` — HTTP bind address
- `EPOCH_RATE_LIMIT` — requests per minute
- `EPOCH_COMMUNITY_DIR` — community data directory

Add to README.md in a new "Configuration" section.

10c. Verify zero npm references:
- Grep for `npm` in all source files and configs
- Ensure all docs, scripts, and CI use pnpm exclusively

10d. Clean gitignore:
- Add `.omc/`, `.omx/`, `canary-report.json` if not already present
- Verify `dist/` is gitignored

### Files
- `src/types/index.ts` — remove unused types
- `README.md` — add Configuration section
- `.gitignore` — verify/add entries
- All files — grep for npm references

---

## Implementation Order

Execute in 4 phases:

### Phase 1: Foundation (Sections 2, 4c-d, 6, 10)
Package hygiene, shared utilities, ESLint, editorconfig, repo cleanup.
No functional changes — pure infrastructure.

### Phase 2: Architecture (Section 1)
Unify dual registration. Largest refactor. All 3 transports must still work.

### Phase 3: Type Safety (Sections 4a-b, 4e-f, 9)
Replace zodToJsonSchema, fix cocomoEstimate, branded types, satisfies patterns.

### Phase 4: Features + Polish (Sections 3, 7, 8)
CLI parity, HTTP hardening, release infrastructure, stale reference fixes.

### Verification (after each phase)
- `pnpm run typecheck` — zero errors
- `pnpm test` — all 356+ tests pass
- `pnpm run build` — clean build
- `node dist/index.js` — MCP server starts
- `EPOCH_TRANSPORT=http pnpm run dev` — HTTP server starts
- Manual CLI test of each new subcommand
