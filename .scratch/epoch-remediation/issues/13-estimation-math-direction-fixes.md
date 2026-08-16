# 13 — Estimation math direction fixes (sign, monotonicity, parity, percentiles, risk metrics)

**What to build:** Every confirmed math defect fixed with a direction-asserting test: cocomo-validate's coefficient adjustments move in the bias-correcting direction (currently inverted — they amplify bias); `iterative_cycles` becomes monotonic non-decreasing with no cliff at 2.0 (currently 2.0→2.0× but 2.01→1.201×); `weightedMedian` matches the unweighted median for even n (currently lower-median); percentile indexing uses ceil-rank or interpolation (currently biased one-high; p95 of small samples returns the max); `criticalPathProbability` replaced with a real metric — P(total ≤ caller-supplied target deadline) — and per-task `impactDays` computed per task instead of copying the project-level p95−p50 onto every row.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] cocomo adjustment reduces |bias| on synthetic over- and under-prediction sets (direction test, both signs)
- [ ] iterative_cycles multiplier monotonic non-decreasing over [0,10], no discontinuity at 2.0
- [ ] weightedMedian([1,3]) == 2 == median([1,3]); equal-weight reduction equals unweighted median
- [ ] Percentile p95 of an n=20 sample < max; median rank correct at n=1000
- [ ] Critical-path metric reflects a supplied deadline (≈0% impossible, high for loose); per-task impactDays differ across tasks on a crafted graph; docs/type updated for the new semantics
