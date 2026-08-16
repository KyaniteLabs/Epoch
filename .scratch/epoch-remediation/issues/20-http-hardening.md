# 20 — HTTP entry hardening (CORS, body limits, rate limiting, batch parity)

**What to build:** The local HTTP server resists drive-by and DoS: CORS restricted to a configured allowlist (not `*` on every route); body-size limits enforced while reading (chunked transfer without content-length currently bypasses the limit; feedback endpoints have no check at all); rate limiter keyed on the connection address with XFF honored only behind explicit proxy config, `Retry-After` on 429, and `EPOCH_RATE_LIMIT=0` meaning disabled rather than block-everything; `GET /v1/feedback/pending?limit=abc` falls back to the default 50 (NaN currently bypasses the cap and returns the entire ledger); batch endpoint returns per-entry validation errors with aligned limits instead of silently dropping/truncating; cache headers on immutable doc endpoints.

**Blocked by:** 06 (error envelope split first).

**Status:** ready-for-agent

- [ ] CORS: no origin `*` by default; allowlist honored (preflight + actual)
- [ ] Oversize body under chunked transfer → 413; feedback endpoints enforce the same limit
- [ ] `limit=abc` → default 50 (not full ledger); per-IP bucket isolation test; 429 carries Retry-After; rate limit 0 disables
- [ ] Batch endpoint: per-entry errors returned, no silent drops; over-limit payload → explicit error; limits aligned with the tool schema
- [ ] `/llms.txt` and `/openapi.json` carry cache headers
