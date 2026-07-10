#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build a single-file, self-contained Epoch executable with `bun build --compile`.
#
# Motivation: `npx @kyanitelabs/epoch` has a cold-start (package fetch + node
# module resolution) slow enough that MCP client configs need timeout:15.
# A compiled binary starts in milliseconds with zero npm/node resolution.
#
# STATUS (2026-07-10, bun 1.3.14): BLOCKED upstream. See docs/BINARY.md for
# full reproduction and root-cause analysis. `bun build` currently produces
# an incorrectly-linked bundle whenever both the CLI entry (src/entries/cli.ts,
# which pulls in the full tool dispatcher/zod schemas) and the MCP entry
# (src/entries/mcp.ts, which pulls in @modelcontextprotocol/sdk — itself
# calling `z.custom()` at module top-level) are bundled together. Two
# symptom variants have been observed, both indicating a Bun linker defect
# (not an Epoch code issue):
#   - "SyntaxError: Exported binding 'loadConfig2' needs to refer to a
#     top-level declared variable."
#   - "TypeError: Class2 is not a constructor" (zod's lazy-init ZodCustom
#     class is referenced before Bun's bundle actually initializes it).
# Reproduces identically with --compile or plain `bun build`, esm or cjs
# format, bun or node target, with/without --keep-names. src/entries/cli.ts
# alone and src/entries/mcp.ts alone each bundle and run correctly in
# isolation — only the combination breaks. This script is left in a working
# state so it "just works" once upstream Bun fixes the bug (re-run this
# script after a `bun upgrade` to check).
#
# Usage: scripts/build-binary.sh [outfile]
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUTFILE="${1:-dist-bin/epoch}"
ENTRY="src/index.ts"

if ! command -v bun >/dev/null 2>&1; then
	echo "error: bun is required to build the compiled binary (https://bun.sh)" >&2
	exit 1
fi

mkdir -p "$(dirname "$OUTFILE")"

echo "==> bun build --compile ${ENTRY} --outfile ${OUTFILE}"
bun build --compile "$ENTRY" --outfile "$OUTFILE"

echo "==> smoke test: ${OUTFILE} --version"
if ! "$OUTFILE" --version; then
	cat >&2 <<'EOF'

Build succeeded but the compiled binary failed to run. As of 2026-07-10 this
is a known, reproducible Bun bundler defect (see docs/BINARY.md) — not an
Epoch runtime bug. Do not ship this binary. Re-check after upgrading bun.
EOF
	exit 1
fi

echo "==> smoke test: run from a foreign cwd with a temp EPOCH_DATA_DIR"
TMP_CWD="$(mktemp -d)"
TMP_DATA_DIR="$(mktemp -d)"
ABS_OUTFILE="$(cd "$(dirname "$OUTFILE")" && pwd)/$(basename "$OUTFILE")"
(
	cd "$TMP_CWD"
	EPOCH_DATA_DIR="$TMP_DATA_DIR" "$ABS_OUTFILE" data status
)
rm -rf "$TMP_CWD" "$TMP_DATA_DIR"

echo "==> OK: ${OUTFILE} is a working single-file binary"
