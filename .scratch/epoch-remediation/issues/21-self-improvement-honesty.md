# 21 — Self-improvement honesty (watermarks, honest sampleSize, off the request path)

**What to build:** The learning loop stops inflating itself: per-tool watermarks so only new data merges (the 90-day window is currently re-merged on every daily update — sampleCount inflates ~90× per 90 days and means converge on their own history); `sampleSize` recomputed from merged benchmark counts (the shipped DB already carries 8,432 phantom samples); the update moved off the request path (currently a full synchronous stall inline on the 100th tool call); the failure path logs instead of swallowing.

**Blocked by:** 17 (shares the read/telemetry paths).

**Status:** ready-for-agent

- [ ] Repeated updates with an unchanged window leave sampleCount unchanged (was: re-merged)
- [ ] sampleSize == sum of merged benchmark counts; bundled DB count reconciled (phantom delta removed)
- [ ] 100th-dispatch latency assertion: update deferred (setImmediate/queueMicrotask), no inline sync stall
- [ ] Update failure logs with context (no silent `.catch(() => {})`)
