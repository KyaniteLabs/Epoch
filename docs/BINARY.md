# Single-file compiled binary (bun build --compile)

## Status: BLOCKED — do not ship

Building Epoch as a single-file `bun build --compile` executable currently
fails on **Bun 1.3.14 (latest as of 2026-07-10)**. This is a Bun bundler
defect, not an Epoch code bug — see [Root cause](#root-cause) below.

This document exists so the next person (human or agent) who picks this up
doesn't have to re-derive the diagnosis from scratch, and can re-check
quickly once a fixed Bun ships.

## Motivation

`npx @kyanitelabs/epoch@latest` has a cold-start slow enough that Simon's MCP
client config carries `timeout: 15` (seconds) to avoid handshake timeouts on
first launch. A `bun build --compile` executable starts in milliseconds —
no npm registry round-trip, no node module resolution walk, no `node_modules`
at all. That's the entire appeal: it's strictly a distribution/startup-time
optimization, no behavior change.

## Intended usage (once unblocked)

```bash
bun install -g bun   # or any bun >= 1.3
scripts/build-binary.sh              # -> dist-bin/epoch
scripts/build-binary.sh /tmp/epoch   # custom outfile
```

The script runs `bun build --compile src/index.ts --outfile dist-bin/epoch`
and then smoke-tests `--version` and a `data status` run from a foreign cwd
with a temp `EPOCH_DATA_DIR`, so a future green run of this script is by
itself sufficient evidence the binary works.

## Root cause

`bun build --compile src/index.ts --outfile dist-bin/epoch` compiles without
error, but the resulting binary throws immediately on any invocation:

```
SyntaxError: Exported binding 'loadConfig2' needs to refer to a top-level declared variable.
```

This is a genuine parse-time `SyntaxError` thrown by the JS engine against
Bun's own generated output — i.e. Bun produced structurally invalid
JavaScript. It is **not specific to `--compile`**: a plain
`bun build src/index.ts --outdir out --target node` bundle, when executed
with plain `node`, throws the equivalent linking error:

```
SyntaxError: Export 'batchRecordActuals2' is not defined in module
```

Both are members of the same bug family: Bun's bundler renames identifiers
to avoid scope collisions when concatenating everything into one file, but
in this specific module graph the renamed target either never gets declared
at the top level, or its lazy-init wrapper never runs before first use. A
third, more revealing variant surfaces once the barrel re-exports in
`src/index.ts` are bypassed with a minimal hand-written entry that only
statically imports `src/entries/mcp.ts` + `src/entries/cli.ts`:

```
TypeError: Class2 is not a constructor
    at _custom (.../zod's _custom(Class2, fn, _params) helper)
    at custom (.../zod's public custom() wrapper)
    at .../node_modules/@modelcontextprotocol/sdk/.../types.js
        (top-level: `var AssertObjectSchema = custom((v) => ...)`)
```

`@modelcontextprotocol/sdk`'s `types.js` calls `z.custom(...)` at **module
top level**. zod v4 wraps its class definitions in a lazy-init block (Bun's
own `__esm`-style lazy-module pattern, visible in the bundle as
`ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", ...)` inside an init
closure). In native ESM this is always safe — the loader guarantees zod
fully evaluates before `types.js` (which imports it) runs. In Bun's
single-file bundle, that guarantee breaks: the call site executes before
the `ZodCustom` assignment inside its lazy-init wrapper has run, so
`ZodCustom` is `undefined` at the call site and `new Class2(...)` throws.

### Isolation performed

| Entry bundled | Modules | Result |
|---|---|---|
| `src/entries/mcp.ts` alone | 573 | Runs cleanly (starts MCP stdio server) |
| `src/entries/cli.ts` alone | 439 | Runs cleanly (`--version`, subcommands work) |
| `src/entries/cli.ts` + `src/entries/http.ts` | 469 | Runs cleanly |
| `src/entries/mcp.ts` + `src/entries/cli.ts` | 586 | **Fails** (`Class2 is not a constructor`) |
| `src/index.ts` (real entry: mcp + http + cli + barrel re-exports) | 616 | **Fails** (`loadConfig2` linking error) |

The failure only appears once the CLI's tool dispatcher (which pulls in
Epoch's own zod schemas) and the MCP entry (which pulls in
`@modelcontextprotocol/sdk`'s zod usage) are bundled **together**. Each half
bundles and runs correctly on its own. That rules out a straightforward
Epoch-side fix — the defect lives in how Bun links the merged zod module
graph, not in any specific Epoch file.

### What was tried and did not help

- Latest Bun (`bun upgrade --dry-run` confirms 1.3.14 is current)
- `--target=node` vs `--target=bun` (default for `--compile`)
- `--format=esm` vs `--format=cjs`
- `--keep-names` (preserve original identifiers through minification)
- Reordering imports (`import "zod"` first in a scratch entry) — no effect,
  since the bug is in Bun's own dependency-graph linking, not source order
- Plain `bun build` (non-`--compile`) reproduces the same class of error
  when the output is run — rules out `--compile`-specific packaging as the
  cause

### Not attempted (out of scope for this pass)

- Bisecting older Bun point releases (no easy way to install a pinned
  older Bun version without extra tooling in this environment)
- Patching zod or `@modelcontextprotocol/sdk` locally to avoid the
  top-level `z.custom()` call (would mean carrying a patched dependency,
  a much larger commitment than "single binary via bun compile")
- Filing an upstream Bun issue (recommended next step — this repro is
  clean enough to distill into a minimal zod + MCP SDK reproduction case)

## Recommendation

Re-run `scripts/build-binary.sh` after any `bun upgrade`. If Bun ships a
fix for this class of linking bug, the script requires no changes — it will
just start passing. Until then, do not advertise or ship a compiled binary;
`npx` (with the existing `timeout: 15` MCP config) remains the supported
distribution path.

## Startup benchmark (context, not a binary comparison)

Measured on the dev machine while under heavy concurrent load from parallel
wave-2 agents (`uptime` load average ~50 during measurement — treat as
directional, not authoritative):

| Command | Median wall time |
|---|---|
| `node dist/index.js --version` (already built, warm disk cache) | ~1.4s |
| `npx -y @kyanitelabs/epoch@latest --version` (npm-cached, not first-ever install) | ~3.6s |
| `./dist-bin/epoch --version` (compiled binary) | **N/A — blocked, see above** |

The whole point of this exploration was to get the third row down to
low tens-of-milliseconds. That remains the expectation once the Bun bug is
fixed (single-file Bun executables of comparable size typically start in
under 50ms), but it isn't measurable evidence until the binary actually
runs — no number is reported here to avoid presenting a not-yet-real result
as fact.
