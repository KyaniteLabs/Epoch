# 07 — OpenAPI schemas that aren't empty (zod v4 native conversion)

**What to build:** Replace the hand-rolled zod-v3-internals walker (`_def.typeName`, dead under zod 4) with zod v4's native JSON-schema conversion, with a per-tool fallback so one unrepresentable schema degrades that tool's entry instead of failing the whole `/openapi.json`. Every tool path gets real typed properties and correct required/optional fields.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Test converts all 25 tool schemas without throwing
- [ ] ≥1 tool's request schema has typed properties; optional fields not listed in `required`
- [ ] Fixture with an unrepresentable schema degrades to per-tool fallback; document still returns 200
- [ ] HTTP seam test asserts schema contents (not just path existence)
