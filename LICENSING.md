# Licensing

Current grant: Apache License 2.0. See [LICENSE](./LICENSE). This file records history; it does not change any grant.

## Timeline

| When (UTC) | Commit | What |
| --- | --- | --- |
| 2026-05-01 | `029d50f66` | Initial MIT `LICENSE`. |
| 2026-05-01 14:23 | `395148450` | Temporarily BSL-1.1 (`Change Date: 2029-01-01`, `Change License: MIT`; Additional Use Grant: non-production use). **Never published** as an npm version or GitHub Release. |
| 2026-05-01 16:09 | `fe8a5694b` | Reverted to MIT. The BSL detour lasted about two hours. |
| 2026-06-02 | `ee5591648` (PR #129) | Relicensed MIT → Apache-2.0. HEAD remains Apache-2.0. |

## Why the BSL detour was reverted

Epoch is an MCP time-estimation server intended as a permissive open-source tool. BSL-1.1 is source-available, not OSI-approved, and would have blocked listing in a permissive catalogue. The switch was reverted the same day, before any artifact shipped under those terms.

## Published artifacts

npm `@kyanitelabs/epoch` versions **0.2.1–0.2.9** (published 2026-05-07 through 2026-05-26) ship `license=MIT` with an MIT `LICENSE` inside the tarball. Consumers of those versions hold MIT terms. Versions **0.3.0 and later** ship Apache-2.0.

No published artifact was labelled BSL-1.1.

An MIT → BSL → MIT → Apache sequence does not automatically reach previously published MIT-licensed copies. Copies obtained under MIT remain under MIT.
