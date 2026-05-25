# Ship-Ready Polish — Implementation Plan

> **Historical archive:** This file preserves a 2026-05-01 planning snapshot. Tool counts and line references below are not the current release contract; use `README.md`, `docs/llms.txt`, `src/dispatcher/tool-registry.ts`, and `docs/plans/2026-05-09-epoch-audit-remediation-report.md` for current release truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full deep clean and expansion of the Epoch MCP Server — unified architecture, complete type safety, 100% CLI parity, publishable package, release infrastructure, and Matt Pocock-style TypeScript rigor.

**Architecture:** Unify the dual registration system (dispatcher/ + tools/) so that handler logic exists once. CLI and HTTP route through the unified handlers. Add branded types, ESLint, release workflows, and missing CLI commands. Phase order ensures each phase is independently verifiable.

**Tech Stack:** TypeScript 5.8 strict, Zod 3.24, MCP SDK 1.12, Hono 4.x, Commander.js, vitest 3.x, ESLint 9 flat config, tsup 8.x, pnpm 10.

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/internal/error-helpers.ts` | CREATE | Shared `makeError()` function |
| `src/lib/internal/urgency.ts` | CREATE | Shared `getUrgencyCategory()` function |
| `eslint.config.js` | CREATE | ESLint flat config |
| `.editorconfig` | CREATE | Editor consistency |
| `.npmignore` | CREATE | npm publish exclusion |
| `.github/workflows/release.yml` | CREATE | Tag-triggered publish workflow |
| `.github/ISSUE_TEMPLATE/bug_report.md` | CREATE | Bug report template |
| `.github/ISSUE_TEMPLATE/feature_request.md` | CREATE | Feature request template |
| `.github/PULL_REQUEST_TEMPLATE.md` | CREATE | PR template |
| `.github/dependabot.yml` | CREATE | Dependency update config |
| `CONTRIBUTING.md` | CREATE | Contribution guidelines |
| `CHANGELOG.md` | CREATE | Version history |
| `src/dispatcher/tool-registry.ts` | MODIFY | Unify with tools/ handlers |
| `src/dispatcher/index.ts` | MODIFY | Update dispatch() signatures |
| `src/tools/temporal.ts` | MODIFY | Extract dispatchTimeMath, use shared utils |
| `src/tools/estimation.ts` | MODIFY | Use shared utils, fix cocomo return type |
| `src/tools/analytics.ts` | MODIFY | Use shared utils |
| `src/entries/cli.ts` | MODIFY | Add 5 commands, extract getRootOpts helper |
| `src/entries/http.ts` | MODIFY | Rate limiter, 127.0.0.1, zod-to-openapi, fix counts |
| `src/entries/mcp.ts` | MODIFY | Add annotations parameter |
| `src/index.ts` | MODIFY | Type re-exports, CLI_SUBCOMMANDS update |
| `src/types/index.ts` | MODIFY | Branded types, remove unused EstimationInput |
| `src/lib/temporal.ts` | MODIFY | Use shared makeError |
| `src/lib/calendar.ts` | MODIFY | Use shared makeError + getUrgencyCategory |
| `src/lib/estimation.ts` | MODIFY | Use shared getUrgencyCategory, fix cocomo return type |
| `tsconfig.json` | MODIFY | Remove dead exclude |
| `package.json` | MODIFY | Add fields, eslint deps |

---

## Phase 1: Foundation (Sections 2, 4c-d, 6, 10)

### Task 1: Shared error helper utility

**Files:**
- Create: `src/lib/internal/error-helpers.ts`

- [ ] **Step 1: Create `src/lib/internal/error-helpers.ts`**

```typescript
import type { ToolError } from "../../types/index.js";

export function makeError(message: string, retryHint?: string): ToolError {
  return { isError: true, message, retryHint };
}
```

- [ ] **Step 2: Update `src/lib/temporal.ts` to use shared helper**

Replace the local `makeError` function (lines 18-20) with an import:

```typescript
// Remove lines 18-20 (local makeError function)
// Add import at top:
import { makeError } from "./internal/error-helpers.js";
```

The import goes after the existing imports at line 8. Remove the local function definition at lines 18-20.

- [ ] **Step 3: Update `src/lib/calendar.ts` to use shared helper**

Replace the local `makeError` function (lines 25-27) with an import:

```typescript
// Remove lines 25-27 (local makeError function)
// Add import at top (after existing imports around line 21):
import { makeError } from "./internal/error-helpers.js";
```

- [ ] **Step 4: Verify typecheck passes**

Run: `pnpm run typecheck`
Expected: PASS (zero errors)

- [ ] **Step 5: Verify tests pass**

Run: `pnpm test`
Expected: All 356+ tests pass

- [ ] **Step 6: Commit**

```
feat: extract shared makeError utility into src/lib/internal/error-helpers.ts
```

---

### Task 2: Shared urgency category utility

**Files:**
- Create: `src/lib/internal/urgency.ts`
- Modify: `src/lib/estimation.ts:13-17`
- Modify: `src/lib/calendar.ts:408-412`

- [ ] **Step 1: Create `src/lib/internal/urgency.ts`**

```typescript
import type { UrgencyCategory } from "../../types/index.js";

export function getUrgencyCategory(hours: number): UrgencyCategory {
  if (hours < 2) return "short";
  if (hours <= 48) return "medium";
  return "long";
}
```

- [ ] **Step 2: Update `src/lib/estimation.ts`**

Remove the local `getUrgencyCategory` function (lines 13-17). Add import:

```typescript
// Remove lines 13-17
// Add import after existing imports:
import { getUrgencyCategory } from "./internal/urgency.js";
```

- [ ] **Step 3: Update `src/lib/calendar.ts`**

Remove the exported `getUrgencyCategory` function (lines 405-412). Add import:

```typescript
import { getUrgencyCategory } from "./internal/urgency.js";
```

Check if anything imports `getUrgencyCategory` from `calendar.ts` — if so, update those imports to point to `internal/urgency.js` instead.

- [ ] **Step 4: Verify typecheck + tests**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```
feat: extract shared getUrgencyCategory utility into src/lib/internal/urgency.ts
```

---

### Task 3: CLI getRootOpts helper

**Files:**
- Modify: `src/entries/cli.ts`

- [ ] **Step 1: Add `getRootOpts` helper after `resolveFormat` function (after line 31)**

```typescript
/** Resolve root options from Commander command chain. */
function getRootOpts(cmd: Command): Record<string, unknown> {
  return cmd.parent!.opts() as Record<string, unknown>;
}

function isQuiet(rootOpts: Record<string, unknown>): boolean {
  return rootOpts.quiet === true;
}
```

- [ ] **Step 2: Replace all 14 `cmd.parent!` patterns**

Replace every instance of:
```typescript
const root = cmd.parent!;
const format = resolveFormat(root.opts() as Record<string, unknown>);
const quiet = root.opts().quiet === true;
```

With:
```typescript
const rootOpts = getRootOpts(cmd);
const format = resolveFormat(rootOpts);
const quiet = isQuiet(rootOpts);
```

This occurs at approximately lines: 83-85, 100-102, 119-121, 144-146, 175-177, 197-199, 222-224, 248-250, 278-280, 311-313, 329-331, 348-350, 368-370, 386-388.

- [ ] **Step 3: Verify typecheck + tests**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```
refactor: extract getRootOpts helper to eliminate repeated cmd.parent! patterns
```

---

### Task 4: Package.json hygiene

**Files:**
- Modify: `package.json`
- Create: `.npmignore`
- Modify: `src/index.ts`
- Modify: `tsup.config.ts`

- [ ] **Step 1: Add missing fields to `package.json`**

Add after the `"bin"` field (after line 10):

```json
"files": ["dist"],
"exports": {
  ".": {
    "import": "./dist/index.js",
    "types": "./dist/index.d.ts"
  }
},
"types": "./dist/index.d.ts",
"engines": {
  "node": ">=20"
},
"bugs": {
  "url": "https://github.com/KyaniteLabs/Epoch/issues"
},
"homepage": "https://github.com/KyaniteLabs/Epoch#readme",
```

- [ ] **Step 2: Create `.npmignore`**

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
*.tsbuildinfo
tsconfig.json
tsup.config.ts
vitest.config.ts
eslint.config.js
.editorconfig
.github/
CLAUDE.md
AGENTS.md
CONTRIBUTING.md
CONTRIBUTING-data.md
CHANGELOG.md
```

- [ ] **Step 3: Add type re-exports to `src/index.ts`**

Add these lines after the existing imports (after line 4):

```typescript
// Re-export types for consumers
export type * from "./types/index.js";
```

- [ ] **Step 4: Verify build generates real type declarations**

Run: `pnpm run build`
Then check: `head -20 dist/index.d.ts`
Expected: Should contain exported types from `types/index.ts`, not just `export {}`.

If `export type *` doesn't work with tsup's dts, alternatively add:
```typescript
export type {
  UrgencyCategory,
  ConfidenceLevel,
  TimeUnit,
  TaskType,
  ToolError,
  ToolResult,
  LLMModel,
  ReasoningDepth,
  DeveloperProfile,
  // ... other public types
} from "./types/index.js";
```

- [ ] **Step 5: Verify typecheck + tests + build**

Run: `pnpm run typecheck && pnpm test && pnpm run build`
Expected: All pass

- [ ] **Step 6: Commit**

```
feat: add package.json exports, types, files, engines fields for npm publish
```

---

### Task 5: Remove dead code and fix tsconfig

**Files:**
- Modify: `src/types/index.ts:180-202`
- Modify: `tsconfig.json:23`

- [ ] **Step 1: Remove unused `EstimationInput` and `EstimationOperation` from `src/types/index.ts`**

Remove lines 180-202 (the `EstimationOperation` type and `EstimationInput` interface). These are not imported anywhere except possibly by dead code.

Verify no imports exist:
Run: `grep -rn "EstimationInput\|EstimationOperation" src/`
Expected: Only the definitions in types/index.ts. If other files import them, update those files to not need them.

- [ ] **Step 2: Fix `tsconfig.json` — remove dead `tests` from exclude**

Change line 23:
```json
"exclude": ["node_modules", "dist", "tests"]
```
To:
```json
"exclude": ["node_modules", "dist"]
```

(The `tests` directory does not exist — tests are collocated as `*.test.ts` in `src/`.)

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```
chore: remove unused EstimationInput/EstimationOperation types, fix tsconfig exclude
```

---

### Task 6: ESLint flat config

**Files:**
- Create: `eslint.config.js`
- Create: `.editorconfig`
- Modify: `package.json` (add devDependencies + update lint script)

- [ ] **Step 1: Install ESLint + TypeScript plugin**

Run: `pnpm add -D eslint @eslint/js typescript-eslint`

- [ ] **Step 2: Create `eslint.config.js`**

```javascript
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "coverage/", "*.config.*"],
  },
);
```

- [ ] **Step 3: Create `.editorconfig`**

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 4: Update `package.json` lint script**

Change:
```json
"lint": "tsc --noEmit"
```
To:
```json
"lint": "eslint src/",
```

Keep the `typecheck` script as `tsc --noEmit`.

- [ ] **Step 5: Run ESLint and check baseline**

Run: `pnpm run lint`
Note: This may report existing warnings/errors. That's expected — we'll fix them in Phase 3 when we eliminate `as any`. For now, if there are more than ~15 errors, add specific rules to warn level.

- [ ] **Step 6: Commit**

```
feat: add ESLint flat config with typescript-eslint, add .editorconfig
```

---

### Task 7: Repo hygiene — env var documentation

**Files:**
- Modify: `README.md`
- Verify: `.gitignore`

- [ ] **Step 1: Add Configuration section to README.md**

Add before the `## Installation` section:

```markdown
## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `EPOCH_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `EPOCH_PORT` | `3000` | HTTP server port |
| `EPOCH_HOST` | `127.0.0.1` | HTTP server bind address |
| `EPOCH_DATA_DIR` | `~/.epoch/` | Data directory for feedback and self-improvement |
| `EPOCH_COMMUNITY_DIR` | `data/community/` | Community data directory |
| `EPOCH_RATE_LIMIT` | `100` | Max requests per minute per IP (HTTP only) |
```

- [ ] **Step 2: Verify `.gitignore` includes data directories**

Run: `cat .gitignore`
Ensure it includes: `.omc/`, `.omx/`, `canary-report.json`, `dist/`, `node_modules/`

If any are missing, add them.

- [ ] **Step 3: Commit**

```
docs: add Configuration section with all environment variables
```

---

## Phase 2: Architecture Unification (Section 1)

### Task 8: Unify dual registration — extract shared handlers

**Files:**
- Modify: `src/dispatcher/tool-registry.ts`
- Modify: `src/dispatcher/index.ts`
- Modify: `src/tools/temporal.ts`
- Modify: `src/tools/estimation.ts`
- Modify: `src/tools/analytics.ts`

This is the largest refactor. The key insight: the `tools/*.ts` files call lib functions with **properly typed** params (Zod parses them). The `dispatcher/tool-registry.ts` calls the same lib functions with `Record<string, unknown>` and `as` casts. The solution is to have the dispatcher call into the same handler functions that `tools/*.ts` use, but wrapped to accept `Record<string, unknown>` and return `ToolResult<unknown>`.

- [ ] **Step 1: Define a shared handler type in `src/dispatcher/tool-registry.ts`**

Replace the `ToolDefinition` interface (lines 56-62) with:

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: Record<string, unknown>;
  /** Typed handler that receives Zod-parsed input. */
  handler: (input: Record<string, unknown>) => ToolResult<unknown>;
}
```

This keeps the same signature for now (the dispatcher still receives `Record<string, unknown>` after Zod parse), but the implementation changes below.

- [ ] **Step 2: Rewrite `tool-registry.ts` handlers to use lib functions directly**

The handlers in `tool-registry.ts` already call the same lib functions as `tools/*.ts`. The difference is the `as` casts. After Zod `safeParse` in `dispatch()`, the parsed data is actually typed — we just lost the type info.

Replace the handler wrappers. For example, `get_current_time`:

Before:
```typescript
(input) => getCurrentTime(input.timezone as string),
```

After (no change needed — Zod already validated it's a string):
```typescript
(input) => getCurrentTime(input.timezone as string),
```

The `as` casts remain because the handler receives `Record<string, unknown>`. Eliminating these completely requires making `ToolDefinition` generic, which is Phase 3 (Task 12). For now, the key change is ensuring handlers are **identical** between dispatcher and tools.

- [ ] **Step 3: Move `dispatchTimeMath` from `src/tools/temporal.ts` to `src/dispatcher/tool-registry.ts`**

The `time_math` handler in `tool-registry.ts` (lines 321-395) duplicates logic from `tools/temporal.ts` `dispatchTimeMath` (lines 264-360). Keep the version in `tool-registry.ts` (it's already there) and have `tools/temporal.ts` import and use it.

In `src/tools/temporal.ts`:
1. Remove the `dispatchTimeMath` function (lines 264-360) and `makeDispatchError` (lines 354-360)
2. Import `dispatchTimeMathViaRegistry` from the dispatcher, OR simply have the MCP tool call through the dispatcher.

The cleanest approach: have `tools/temporal.ts`'s `time_math` handler call the same lib functions directly (since it already does). The duplication is the dispatch switch — extract it into a shared function.

Create `src/lib/internal/time-math-dispatch.ts`:

```typescript
import type { ToolResult } from "../../types/index.js";
import { getCurrentTime, convertTimezone, parseDuration, formatElapsed, addDays, diffDates } from "../temporal.js";
import { addBusinessDays } from "../calendar.js";

type TimeMathOp = "add_days" | "add_business_days" | "diff" | "convert_tz" | "parse_nl" | "format_duration";

export function dispatchTimeMath(
  operation: TimeMathOp,
  operands: Record<string, unknown>,
): ToolResult<unknown> {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
  const num = (v: unknown, fallback?: number): number | undefined =>
    typeof v === "number" ? v : typeof v === "string" ? Number(v) : fallback;

  switch (operation) {
    case "add_days": {
      const date = str(operands.start_date) ?? str(operands.date) ?? str(operands.from_date) ?? str(operands.startDate);
      const days = num(operands.days);
      if (!date || days === undefined) {
        return { ok: false, error: { isError: true, message: "add_days requires operands: {start_date, days}.", retryHint: "Pass start_date as an ISO date string and days as a number." } };
      }
      return addDays(date, days);
    }
    case "diff": {
      const start = str(operands.start_date) ?? str(operands.date) ?? str(operands.from_date) ?? str(operands.startDate);
      const end = str(operands.end_date) ?? str(operands.to_date) ?? str(operands.endDate) ?? str(operands.end);
      if (!start || !end) {
        return { ok: false, error: { isError: true, message: "diff requires operands: {start_date, end_date}.", retryHint: "Pass both start_date and end_date as ISO date strings." } };
      }
      return diffDates(start, end);
    }
    case "convert_tz": {
      const ts = str(operands.timestamp);
      const tz = str(operands.target_tz);
      if (!ts || !tz) {
        return { ok: false, error: { isError: true, message: "convert_tz requires operands: {timestamp, target_tz}.", retryHint: "Pass an ISO timestamp and a target IANA timezone." } };
      }
      return convertTimezone(ts, tz);
    }
    case "parse_nl": {
      const dur = str(operands.duration_string);
      if (!dur) {
        return { ok: false, error: { isError: true, message: "parse_nl requires operands: {duration_string}.", retryHint: "Pass a duration string like '2h30m'." } };
      }
      return parseDuration(dur);
    }
    case "format_duration": {
      const ms = num(operands.milliseconds);
      if (ms === undefined) {
        return { ok: false, error: { isError: true, message: "format_duration requires operands: {milliseconds}.", retryHint: "Pass a number of milliseconds." } };
      }
      return { ok: true, data: formatElapsed(ms) };
    }
    case "add_business_days": {
      const start = str(operands.start_date) ?? str(operands.date) ?? str(operands.from_date) ?? str(operands.startDate);
      const days = num(operands.days);
      if (!start || days === undefined) {
        return { ok: false, error: { isError: true, message: "add_business_days requires operands: {start_date, days, country?}.", retryHint: "Pass start_date and days." } };
      }
      return addBusinessDays(start, days, (operands.country as string) ?? "US");
    }
    default:
      return {
        ok: false,
        error: {
          isError: true,
          message: `Unknown time_math operation: ${operation}`,
          retryHint: "Use one of: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.",
        },
      };
  }
}
```

- [ ] **Step 4: Update `tool-registry.ts` to use shared `dispatchTimeMath`**

Replace the inline `time_math` handler (lines 321-395) with:

```typescript
import { dispatchTimeMath } from "../lib/internal/time-math-dispatch.js";

// In the tool registry:
tool(
  "time_math",
  "Performs time arithmetic: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration...",
  timeMathSchema,
  timeMathOutput,
  (input) => {
    const operation = input.operation as "add_days" | "add_business_days" | "diff" | "convert_tz" | "parse_nl" | "format_duration";
    let ops = input.operands as Record<string, unknown>;
    if (typeof ops === "string") {
      try { ops = JSON.parse(ops); } catch { /* use as-is */ }
    }
    if (!ops || typeof ops !== "object") ops = {};
    return dispatchTimeMath(operation, ops);
  },
),
```

- [ ] **Step 5: Update `tools/temporal.ts` to use shared `dispatchTimeMath`**

Replace the `dispatchTimeMath` function (lines 264-352) and `makeDispatchError` (lines 354-360) with an import:

```typescript
import { dispatchTimeMath } from "../lib/internal/time-math-dispatch.js";

// In the time_math handler:
async ({ operation, operands }) => {
  const result = dispatchTimeMath(operation, operands);
  if (!result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
  };
},
```

- [ ] **Step 6: Verify all 3 transports work**

Run: `pnpm run typecheck && pnpm test`
Expected: All pass

Manual test:
```bash
# MCP (stdio)
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | pnpm run dev

# CLI
pnpm run dev pert-estimate --optimistic 2 --most-likely 4 --pessimistic 12 --unit hours

# HTTP
EPOCH_TRANSPORT=http pnpm run dev &
curl -X POST http://localhost:3000/v1/tools/time_math \
  -H "Content-Type: application/json" \
  -d '{"operation":"add_days","operands":{"start_date":"2026-05-01","days":7}}'
```

- [ ] **Step 7: Commit**

```
refactor: extract shared dispatchTimeMath, unify time_math handler between dispatcher and tools
```

---

## Phase 3: Type Safety (Sections 4a-b, 4e-f, 9)

### Task 9: Branded types for domain concepts

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Add branded type helpers and domain types to `src/types/index.ts`**

Add after the existing primitives section (after line 15):

```typescript
// ---- Branded Types (Matt Pocock Pattern) ----------------------------------

type Brand<T, B extends string> = T & { readonly __brand: B };

/** Branded number representing hours. */
export type Hours = Brand<number, "Hours">;
/** Branded number representing calendar days. */
export type Days = Brand<number, "Days">;
/** Branded number representing weeks. */
export type Weeks = Brand<number, "Weeks">;
/** Branded number representing thousands of lines of code. */
export type Kloc = Brand<number, "Kloc">;
/** Branded number representing USD cost. */
export type CostUsd = Brand<number, "CostUsd">;
/** Branded number representing a token count. */
export type Tokens = Brand<number, "Tokens">;
/** Branded number representing tokens per second throughput. */
export type TokensPerSecond = Brand<number, "TokensPerSecond">;
/** Branded number representing a percentage (0-100). */
export type Percentage = Brand<number, "Percentage">;

// ---- Brand constructors (use at module boundaries only) ---------------------

export function hours(n: number): Hours { return n as Hours; }
export function days(n: number): Days { return n as Days; }
export function weeks(n: number): Weeks { return n as Weeks; }
export function kloc(n: number): Kloc { return n as Kloc; }
export function costUsd(n: number): CostUsd { return n as CostUsd; }
export function tokens(n: number): Tokens { return n as Tokens; }
export function tokensPerSecond(n: number): TokensPerSecond { return n as TokensPerSecond; }
export function percentage(n: number): Percentage { return n as Percentage; }

// ---- Unbrand (extract raw number for arithmetic) ---------------------------

export function unbrand<T extends Brand<number, string>>(branded: T): number {
  return branded as number;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm run typecheck`
Expected: PASS (branded types are additive — nothing breaks)

- [ ] **Step 3: Commit**

```
feat: add branded types for Hours, Days, Kloc, CostUsd, Tokens, Percentage
```

---

### Task 10: Replace hand-rolled zodToJsonSchema with @asteasolutions/zod-to-openapi

**Files:**
- Modify: `src/entries/http.ts` (remove lines 131-261, replace with library usage)

- [ ] **Step 1: Verify `@asteasolutions/zod-to-openapi` is installed**

Run: `grep "asteasolutions" package.json`
If not present: `pnpm add -D @asteasolutions/zod-to-openapi`

- [ ] **Step 2: Replace `zodToJsonSchema` in `src/entries/http.ts`**

Remove the entire `zodToJsonSchema`, `resolveField`, and `withDescription` functions (lines 131-261).

Add import at top:
```typescript
import { ZodType } from "zod";
import { zodToJsonSchema } from "@asteasolutions/zod-to-openapi";
```

Update `buildOpenApiSpec()` to use the imported `zodToJsonSchema`:

In the function (line 271-273), change:
```typescript
const requestSchema = definition
  ? zodToJsonSchema(definition.inputSchema)
  : { type: "object" };
```

The library's `zodToJsonSchema` returns a `JsonSchema7Type` — convert to plain object:
```typescript
const requestSchema = definition
  ? (zodToJsonSchema(definition.inputSchema, { target: "openApi3" }) as Record<string, unknown>)
  : { type: "object" };
```

- [ ] **Step 3: Remove the local `JsonSchema` interface (lines 133-135)**

No longer needed — the library returns its own type.

- [ ] **Step 4: Verify HTTP server starts and OpenAPI spec generates**

Run: `pnpm run build && EPOCH_TRANSPORT=http node dist/index.js &`
Then: `curl http://localhost:3000/openapi.json | head -50`
Expected: Valid OpenAPI 3.1 JSON with all 19 tool schemas

- [ ] **Step 5: Verify typecheck + tests**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```
refactor: replace hand-rolled zodToJsonSchema with @asteasolutions/zod-to-openapi
```

---

### Task 11: Fix cocomoEstimate return type

**Files:**
- Modify: `src/lib/estimation.ts` (around line 152)
- Modify: `src/tools/estimation.ts` (cocomo_estimate handler)

- [ ] **Step 1: Change `cocomoEstimate` to return `ToolResult<CocomoResult>`**

In `src/lib/estimation.ts`, find the `cocomoEstimate` function. Currently it returns `CocomoResult` directly. Change it to:

```typescript
export function cocomoEstimate(params: CocomoParams): ToolResult<CocomoResult> {
  if (params.kloc <= 0) {
    return {
      ok: false,
      error: {
        isError: true,
        message: "KLOC must be positive.",
        retryHint: "Provide a positive number for thousands of lines of code.",
      },
    };
  }
  // ... existing calculation logic ...
  return { ok: true, data: { kloc: params.kloc, personMonthsNominal, personMonthsLlmAdjusted, effortMultipliers, assumptions } };
}
```

- [ ] **Step 2: Update `src/tools/estimation.ts` cocomo handler**

Change the handler (around line 60-76) from:
```typescript
const output = {
  ...result,
  developerProfile: { ... },
};
```

To:
```typescript
if (!result.ok) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result.error) }], isError: true };
}
const output = {
  ...result.data,
  developerProfile: { mode: profile.mode, correctionFactor: profile.correctionFactor },
};
return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
```

- [ ] **Step 3: Update `src/dispatcher/tool-registry.ts` cocomo handler**

Similarly update the cocomo handler in the dispatcher to unwrap the `ToolResult`.

- [ ] **Step 4: Update existing cocomo tests**

Find any tests that call `cocomoEstimate()` directly and update assertions to handle the new `ToolResult` wrapper.

Run: `grep -rn "cocomoEstimate" src/ --include="*.test.ts"`
Update those tests.

- [ ] **Step 5: Verify typecheck + tests**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```
fix: cocomoEstimate returns ToolResult<CocomoResult> for consistency with all other estimation functions
```

---

### Task 12: Add `satisfies` and exhaustiveness checks

**Files:**
- Modify: `src/dispatcher/tool-registry.ts` (output schemas)
- Modify: `src/types/index.ts` (if needed)

- [ ] **Step 1: Add `satisfies` to output schema objects in `tool-registry.ts`**

Change each output schema from:
```typescript
const temporalOutput = {
  type: "object",
  properties: { ... },
};
```

To:
```typescript
const temporalOutput = {
  type: "object",
  properties: { ... },
} satisfies Record<string, unknown>;
```

Apply to all 12 output schemas: `temporalOutput`, `durationOutput`, `businessDayOutput`, `pertOutput`, `cocomoOutput`, `sprintOutput`, `criticalPathOutput`, `monteCarloOutput`, `tokenTimeOutput`, `referenceClassOutput`, `calibrateOutput`, `timeMathOutput`.

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```
refactor: add satisfies annotations to output schema definitions
```

---

## Phase 4: Features + Polish (Sections 3, 7, 8)

### Task 13: Fix stale "14 tools" references in http.ts

**Files:**
- Modify: `src/entries/http.ts:18, 29, 332`

- [ ] **Step 1: Update AI plugin manifest (line 18)**

Change:
```
"...14 tools across 5 layers."
```
To:
```
"...19 tools across 5 layers."
```

- [ ] **Step 2: Update llms.txt (line 29)**

Change:
```
"Epoch provides 14 tools across 5 layers"
```
To:
```
"Epoch provides 19 tools across 5 layers"
```

Also update the llms.txt content to include the 5 missing tools:
- `token_cost_estimate`
- `compare_models`
- `accuracy_trend`
- `schedule_risk`
- `cocomo_validate`

Add their descriptions after the `token_time_bridge` section in the llms.txt string, following the existing format.

- [ ] **Step 3: Update OpenAPI description (line 332)**

Change:
```
"...14 tools across 5 layers."
```
To:
```
"...19 tools across 5 layers."
```

- [ ] **Step 4: Update default host from 0.0.0.0 to 127.0.0.1**

Change line 479:
```typescript
const resolvedHost = host ?? process.env["HOST"] ?? "0.0.0.0";
```
To:
```typescript
const resolvedHost = host ?? process.env["EPOCH_HOST"] ?? "127.0.0.1";
```

- [ ] **Step 5: Commit**

```
fix: update stale 14 tools references to 19, default bind to 127.0.0.1
```

---

### Task 14: Add rate limiting to HTTP server

**Files:**
- Modify: `src/entries/http.ts`

- [ ] **Step 1: Add in-memory rate limiter before routes**

Add a rate limiter middleware after `app.use("*", cors())` (after line 344):

```typescript
// ---- Rate limiter (in-memory sliding window) ------------------------------
const rateLimitWindowMs = 60_000;
const rateLimitMax = parseInt(process.env["EPOCH_RATE_LIMIT"] ?? "100", 10);
const requestCounts = new Map<string, { count: number; resetAt: number }>();

app.use("/v1/*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? "unknown";
  const now = Date.now();
  const entry = requestCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + rateLimitWindowMs });
    return next();
  }
  entry.count++;
  if (entry.count > rateLimitMax) {
    return c.json(
      { ok: false, error: { isError: true, message: "Rate limit exceeded.", retryHint: `Max ${rateLimitMax} requests per minute. Retry after ${Math.ceil((entry.resetAt - now) / 1000)}s.` } },
      429,
    );
  }
  return next();
});
```

- [ ] **Step 2: Add structured 404 for non-tool paths**

Add a catch-all 404 handler after the error handler (after line 469):

```typescript
app.notFound((c) => {
  return c.json({
    ok: false,
    error: {
      isError: true,
      message: `Not found: ${c.req.path}`,
      retryHint: "Available endpoints: /health, /openapi.json, /llms.txt, /.well-known/ai-plugin.json, /v1/tools/{tool_name}, /v1/feedback/record-actual, /v1/feedback/pending",
    },
  }, 404);
});
```

- [ ] **Step 3: Verify HTTP server works**

Run: `pnpm run build`
Then test:
```bash
EPOCH_TRANSPORT=http node dist/index.js &
# Test rate limit
for i in $(seq 1 110); do curl -s http://localhost:3000/health > /dev/null; done
# Last should return 429
curl -s http://localhost:3000/health | head -5
# Test 404
curl -s http://localhost:3000/nonexistent
```

- [ ] **Step 4: Commit**

```
feat: add in-memory rate limiting (100/min default) and structured 404 handler
```

---

### Task 15: Add MCP annotations to all tools

**Files:**
- Modify: `src/tools/estimation.ts`
- Modify: `src/tools/analytics.ts`
- Verify: `src/tools/temporal.ts` (already has annotations)

- [ ] **Step 1: Verify temporal tools have annotations**

Check `src/tools/temporal.ts` — it already has `TOOL_ANNOTATIONS` passed to each `server.tool()` call. Confirm all 6 temporal tools pass it.

- [ ] **Step 2: Verify estimation tools have annotations**

Check `src/tools/estimation.ts` — it has `annotations` at lines 7-12. Verify all 6 estimation tools (`pert_estimate`, `cocomo_estimate`, `sprint_forecast`, `critical_path`, `monte_carlo_schedule`, `cocomo_validate`) pass the annotations.

- [ ] **Step 3: Add annotations to analytics tools if missing**

Check `src/tools/analytics.ts` — it has `readOnlyAnnotations` at lines 10-15. Verify all 7 analytics tools pass it.

- [ ] **Step 4: Commit (if changes were needed)**

```
feat: add MCP annotations (readOnlyHint, destructiveHint) to all 19 tools
```

If all already have annotations, skip this commit.

---

### Task 16: Add 5 missing CLI commands

**Files:**
- Modify: `src/entries/cli.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add `token-cost-estimate` command**

Add after the `token-time-bridge` command (after line 400):

```typescript
  program
    .command("token-cost-estimate")
    .description("Estimates wall-clock time AND dollar cost from token count and LLM model.")
    .requiredOption("--tokens <n>", "Total number of tokens", parseFloat)
    .requiredOption("--model <model>", "LLM model identifier")
    .option("--tool-calls <n>", "Number of expected tool calls", parseFloat)
    .option("--reasoning-depth <depth>", "Reasoning depth (shallow|moderate|deep)")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = { tokens: opts.tokens, model: opts.model };
      if (opts.toolCalls !== undefined) input.tool_calls = opts.toolCalls;
      if (opts.reasoningDepth !== undefined) input.reasoning_depth = opts.reasoningDepth;
      await runAndExit("token_cost_estimate", input, format, quiet);
    });
```

- [ ] **Step 2: Add `compare-models` command**

```typescript
  program
    .command("compare-models")
    .description("Compares all LLM models side-by-side for a given token budget.")
    .requiredOption("--tokens <n>", "Token count to estimate", parseFloat)
    .option("--tool-calls <n>", "Number of tool calls", parseFloat)
    .option("--reasoning-depth <depth>", "Reasoning depth (shallow|moderate|deep)")
    .option("--sort-by <field>", "Sort by cost or time", "cost")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = { tokens: opts.tokens };
      if (opts.toolCalls !== undefined) input.tool_calls = opts.toolCalls;
      if (opts.reasoningDepth !== undefined) input.reasoning_depth = opts.reasoningDepth;
      if (opts.sortBy !== undefined) input.sort_by = opts.sortBy;
      await runAndExit("compare_models", input, format, quiet);
    });
```

- [ ] **Step 3: Add `accuracy-trend` command**

```typescript
  program
    .command("accuracy-trend")
    .description("Tracks estimation accuracy over time with sliding-window MAPE.")
    .option("--team-id <id>", "Team identifier")
    .option("--window-size <n>", "Records per sliding window", parseFloat)
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = {};
      if (opts.teamId !== undefined) input.team_id = opts.teamId;
      if (opts.windowSize !== undefined) input.window_size = opts.windowSize;
      await runAndExit("accuracy_trend", input, format, quiet);
    });
```

- [ ] **Step 4: Add `schedule-risk` command**

```typescript
  program
    .command("schedule-risk")
    .description("Assesses schedule risk using historical accuracy data.")
    .requiredOption("--estimated-hours <n>", "Estimated effort in hours", parseFloat)
    .option("--task-type <type>", "Task type for accuracy lookup")
    .option("--team-id <id>", "Team identifier")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = { estimated_hours: opts.estimatedHours };
      if (opts.taskType !== undefined) input.task_type = opts.taskType;
      if (opts.teamId !== undefined) input.team_id = opts.teamId;
      await runAndExit("schedule_risk", input, format, quiet);
    });
```

- [ ] **Step 5: Add `cocomo-validate` command**

```typescript
  program
    .command("cocomo-validate")
    .description("Validates COCOMO estimation model against 195 real historical projects.")
    .option("--dataset-filter <datasets>", "Comma-separated dataset names (COCOMO81,NASA93,Albrecht,Kemerer)")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = {};
      if (opts.datasetFilter !== undefined) {
        input.dataset_filter = opts.datasetFilter.split(",").map((s: string) => s.trim());
      }
      await runAndExit("cocomo_validate", input, format, quiet);
    });
```

- [ ] **Step 6: Update `CLI_SUBCOMMANDS` in `src/index.ts`**

Add the 5 new commands to the set (after line 20):

```typescript
"token-cost-estimate",
"compare-models",
"accuracy-trend",
"schedule-risk",
"cocomo-validate",
```

- [ ] **Step 7: Verify CLI commands work**

Run: `pnpm run build && node dist/index.js --help`
Expected: Help output lists all 20 commands (19 tools + list-tools)

Run: `node dist/index.js token-cost-estimate --tokens 50000 --model claude-sonnet-4-20250514`
Expected: JSON output with cost estimate

- [ ] **Step 8: Commit**

```
feat: add 5 missing CLI commands (token-cost-estimate, compare-models, accuracy-trend, schedule-risk, cocomo-validate)
```

---

### Task 17: Release infrastructure

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `CHANGELOG.md`
- Create: `.github/workflows/release.yml`
- Create: `.github/ISSUE_TEMPLATE/bug_report.md`
- Create: `.github/ISSUE_TEMPLATE/feature_request.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Create `CONTRIBUTING.md`**

```markdown
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
```

- [ ] **Step 2: Create `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-01

### Added
- 19 structured MCP tools across 5 layers (temporal, calendar, estimation, analytics, cost/risk)
- Triple surface: MCP stdio server, CLI (Commander.js), REST API (Hono)
- PERT three-point estimation with confidence intervals
- COCOMO II with LLM-adapted cost drivers
- Monte Carlo schedule simulation with seeded PRNG
- Sprint velocity forecasting
- Critical Path Method with merge-bias adjustment
- Reference class forecasting with planning fallacy correction
- Token-to-time bridge for 12 LLM model families
- Token cost estimation and model comparison
- Accuracy trend tracking with sliding-window MAPE
- Schedule risk scoring with confidence intervals
- COCOMO validation against 195 historical projects
- Self-improving engine with feedback loop
- Community data pipeline with JSON Schema validation
- `ai_native` mode for dual human/AI estimation
- Built-in AI discoverability (llms.txt, OpenAPI 3.1, ai-plugin.json)
- Holiday-aware business day calculations (US, UK, FR, DE, JP)
- CI workflow with pnpm
- 356 tests with vitest
```

- [ ] **Step 3: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    name: Build and publish to npm
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: pnpm
          registry-url: "https://registry.npmjs.org"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm run typecheck

      - name: Test
        run: pnpm test

      - name: Build
        run: pnpm run build

      - name: Publish
        run: pnpm publish --no-git-checks --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 4: Create issue/PR templates**

`.github/ISSUE_TEMPLATE/bug_report.md`:
```markdown
---
name: Bug report
about: Report a bug in Epoch
---

**Describe the bug**
A clear description of what the bug is.

**To Reproduce**
Steps to reproduce:
1. Run `epoch ...`
2. Observe ...

**Expected behavior**
What you expected to happen.

**Environment**
- Node.js version:
- Epoch version:
- Transport (MCP/CLI/HTTP):
```

`.github/ISSUE_TEMPLATE/feature_request.md`:
```markdown
---
name: Feature request
about: Suggest a feature for Epoch
---

**Problem**
What problem does this feature solve?

**Proposed solution**
What would you like to see?

**Alternatives considered**
Other approaches you've thought about.
```

`.github/PULL_REQUEST_TEMPLATE.md`:
```markdown
## Summary
<!-- 1-3 bullet points -->

## Test plan
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm test` passes
- [ ] Manual test: <!-- describe -->
```

- [ ] **Step 5: Create `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

- [ ] **Step 6: Commit**

```
feat: add CONTRIBUTING.md, CHANGELOG.md, release workflow, issue/PR templates, dependabot
```

---

## Final Verification

### Task 18: Full verification pass

- [ ] **Step 1: Typecheck**

Run: `pnpm run typecheck`
Expected: Zero errors

- [ ] **Step 2: Lint**

Run: `pnpm run lint`
Expected: Zero errors (or only pre-existing warnings)

- [ ] **Step 3: Test**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 4: Build**

Run: `pnpm run build`
Expected: Clean build with real type declarations

- [ ] **Step 5: Verify type declarations**

Run: `head -30 dist/index.d.ts`
Expected: Contains actual type exports (not just `export {}`)

- [ ] **Step 6: Test MCP server starts**

Run: `echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js`
Expected: JSON response listing all 19 tools

- [ ] **Step 7: Test HTTP server starts**

Run: `EPOCH_TRANSPORT=http node dist/index.js &`
Then: `curl http://localhost:3000/health`
Expected: `{"status":"ok","version":"0.1.0","tools":19,...}`

- [ ] **Step 8: Test new CLI commands**

```bash
node dist/index.js token-cost-estimate --tokens 50000 --model claude-sonnet-4-20250514
node dist/index.js compare-models --tokens 50000
node dist/index.js accuracy-trend
node dist/index.js schedule-risk --estimated-hours 40
node dist/index.js cocomo-validate
```

All should return valid JSON.

- [ ] **Step 9: Final commit (if any fixes needed)**

```
chore: final verification fixes
```
