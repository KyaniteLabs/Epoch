# Epoch — Wave 3 vendor-surface package (STAGED, unsubmitted)

STAGED PACKAGING ONLY. Not submitted, not listed, not published.
Wave 3 vendor-surface packaging for in-repo review. CEO-gated per surface.
Voice assets are DO-NOT-COMMIT. Copy pack remains ungated draft.


Version: `0.5.2`

## Surfaces in this tree

- Claude Code: `.claude-plugin/plugin.json` + `.mcp.json`
- ZCode: `.zcode-plugin/plugin.json`
- MiniMax community format: `.minimax-plugin/plugin.json` (no icon.png — MiniMax incomplete)
- Grok catalog payload: `.grok-plugin/entry.json` (UNSUBMITTED)
- OpenCode npm source: `opencode-plugin/` (`private: true`)
- Kimi: `kimi-plugin/README.md`
- DSH: blocked

## MCP launch (stdio, if applicable)

```
npx -y @kyanitelabs/epoch
```

## Explicit non-actions

- No marketplace upload, directory submit, npm publish, or MCP registry publish.
- No GPU window. No CS candidate verdict.
- Publishing/listing remains CEO-gated per surface.

## Gaps still blocked

- No marketplace upload.
- MiniMax package missing icon.png (no accepted Wave 3 icon in this repo tip).
- Published npm `@kyanitelabs/epoch@0.5.2` still reports mcpName `io.github.KyaniteLabs/Epoch`; origin/main source is `tech.kyanitelabs/epoch`. Next npm publish is November-gated / NO-PUBLISH.
- Grok SHA unpinned.
- DSH schema unverified.
- Voice/copy gate BLOCKED; ungated copy pack not used.
