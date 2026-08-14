# 19 — Telemetry trust boundary (statistical validation + labeled integrity)

**What to build:** The receiver stops trusting self-authenticating payloads blindly: validate ratio ≈ actual/estimated within tolerance and bound magnitudes at receive; route received records through the same exclusion classification as recalculation; exclude non-trusted-source records from correction factors with a visible quarantinedRecords counter. The HMAC is documented as integrity-only (provenance trust impossible until a receiver secret exists — deferred infrastructure decision; residual poisoning risk stated as accepted and bounded by caps). Sender: version resolution uses the dist-safe resolver; flush clears buffer only on successful append; one malformed completedAt can't wedge submission forever.

**Blocked by:** 02 (dist-safe version resolver).

**Status:** ready-for-agent

- [ ] Payload with ratio ≠ actual/estimated → 4xx; magnitude caps enforced (verified with the 1e8-ratio forge fixture)
- [ ] quarantinedRecords counter increments and is visible; quarantined records absent from correction factors
- [ ] Receiver records pass the same exclusion classification as the recalculation path (smoke/synthetic provenance excluded)
- [ ] Installed-package telemetry reports the real version (dist-layout fixture); flush-on-failure keeps the buffer
- [ ] Malformed/empty completedAt filtered at extraction — first-ever submission cannot wedge; docs label the HMAC integrity-only with the accepted residual risk
