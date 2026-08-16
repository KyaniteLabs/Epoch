# 08 — Input safety bounds (kill the single-call server freeze)

**What to build:** Bound every adversarial numeric/array input: `days` on business-day tools (a tool call with `days: 1e9` currently hangs the stdio server indefinitely), task-array sizes, Monte Carlo iteration counts, the iterations×tasks product, context length, and `time_math` operand validation. Bounds reject with clear messages, asserted as bounded-latency rejections.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `days` beyond cap rejected with clear error, asserted as bounded-latency rejection (no event-loop hang)
- [ ] Task arrays, iteration counts, iterations×tasks product, and context length all capped with actionable errors
- [ ] `time_math` operands validated per-operation (e.g. numeric country no longer reaches `toUpperCase`)
- [ ] Canary existing edge cases stay green (huge-iteration-count already covered; new caps covered)
