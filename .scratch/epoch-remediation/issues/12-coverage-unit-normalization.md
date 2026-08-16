# 12 — Coverage scored in consistent units

**What to build:** `feedback_health` coverage compares hours-denominated actuals against hours-converted intervals: PERT rows recorded in days/weeks/months get their intervals converted with the same unit table used at ingest before scoring, so non-hour estimates stop being systematically marked as misses.

**Blocked by:** None — can start immediately (coordinate with 11 on shared fixtures).

**Status:** ready-for-agent

- [ ] Golden fixture: 2-day estimate vs actualHours=16 flips from miss to hit
- [ ] Unit table conversion applied at the coverage join for all units (hours/days/weeks/months)
- [ ] Coverage stats over a mixed-unit fixture match hand-computed expected coverage
