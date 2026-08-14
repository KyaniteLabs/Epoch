# 14 — Calendar truth for 2026-2027 (holidays + memoized holiday sets)

**What to build:** Business-day math correct on real holiday weeks: JP equinox dates from a per-year table (or astronomical calculation) replacing the inverted ternaries; US/UK observed/substitute-day rules (Saturday → preceding Friday, Sunday/bank-holiday → next weekday) so July 3 2026 and Dec 28 2026 exist; Good Friday removed from the US federal set (changelog note); holiday sets memoized per (country, year) instead of rebuilt every loop iteration (~15 allocations per day walked today). Calendar version stamp in outputs.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Golden tables 2024–2027: JP Shunbun/Shubun official dates; US observed Jul 3 2026, Dec 24 2027, Jun 18 2027; UK substitute Dec 28 2026
- [ ] `addBusinessDays("2026-06-29", 4, "US")` → 2026-07-06; `countBusinessDays("2026-06-29","2026-07-03","US")` → 3
- [ ] Good Friday absent from US federal set; changelog notes the behavior change
- [ ] Holiday set computed once per (country, year) — call-count assertion; multi-year countBusinessDays no longer allocates per-day
- [ ] Outputs carry a calendar version stamp
