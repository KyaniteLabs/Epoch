# 16 — unit_suspect lifecycle (persist, surface, symmetric exclusion)

**What to build:** The `unit_suspect` flag (ratio > threshold — e.g. person-months entered as hours) becomes real: persisted on the actual record, surfaced in the tool response, and exclusion applied symmetrically (high-side outliers currently pass into calibration while only low-side ones are excluded). Dry-run mode checks the dry-run ledger for duplicates and joins against dry-run estimates (currently reads production files while writing dry-run ones).

**Blocked by:** 04 (record-path vocabulary).

**Status:** ready-for-agent

- [ ] 50×-overrun actual → flagged, persisted on the record, and visible in the tool response
- [ ] Exclusion bounds symmetric across provenances (high-side outliers excluded like low-side)
- [ ] Dry-run duplicate check and estimate join use dry-run files (repeated dry-run records can't accumulate unbounded)
- [ ] Notes-substring classification: explicit structured provenance/usage fields override note-sniffing heuristics
