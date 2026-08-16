# 11 — Estimate-basis unification (displayed == recorded == calibrated)

**What to build:** One estimate basis end-to-end: the number shown is the number recorded and the number quantiles are calibrated against. Empirical intervals apply ratio quantiles on the same basis they were computed on; ratio populations are never pooled across bases. Local-ledger transition: post-unification rows carry a basis-version stamp; per-basis ratio populations stay split (permanent until an explicit future decision — no automatic aging-out); read-side normalization where cheap. Community dataset keeps schema stability via dual labeled fields for one minor version. Mixed-era ledger fixtures pin the boundary. CHANGELOG migration note. Breaking output change — rides 0.5.0.

**Blocked by:** 03 (authoritative surface), 04 (feedback path stable).

**Status:** ready-for-agent

- [ ] Displayed estimate == recorded hours/units for PERT, reference-class, and context estimates
- [ ] Interval endpoints == quantiles × same-basis estimate (golden: 10h estimate with quantiles [0.6,1.5] → 6–15, not 5.34–13.35)
- [ ] Reference-class output no longer carries two inconsistent estimate bases
- [ ] Basis-version stamp on new rows; mixed-era fixture keeps populations split; coverage consistent across eras
- [ ] Community dataset schema unchanged (dual fields); dataset verification script green in CI
