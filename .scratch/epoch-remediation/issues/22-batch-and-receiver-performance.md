# 22 — Batch + receiver performance (O(n²) → single-pass, in-memory dedup)

**What to build:** Bulk paths stop being the slowest paths: `batch_record_actuals` loads both ledgers once, dedupes in memory, and appends once (currently re-reads both full files per entry — up to 1000 full parses per call, each over a file the batch itself is growing); the telemetry receiver keeps its dedup key set in memory with periodic flush and per-installation + total record caps (currently re-parses the whole key file on every POST — also a memory-amplification vector).

**Blocked by:** 18 (write paths stable).

**Status:** ready-for-agent

- [ ] Batch of k entries → ≤2 file reads total (instrumented); per-entry results preserved
- [ ] Receiver dedup served from memory; concurrent duplicate POSTs → one accepted (sandbox test)
- [ ] Per-installation and total caps enforced; over-cap → explicit rejection (not silent drop)
- [ ] Existing feedback e2e dedup suite green
