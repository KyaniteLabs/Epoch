# 17 — Ledger read cache (flat latency as history grows)

**What to build:** Memoize ledger reads keyed on file size+mtime (append-only files make this exact): stat per read catches external appends and rename rewrites; own writes invalidate. Today a single estimation call parses the whole ledger ~3×, growing linearly (then some) with history. The W2 accuracy suites must re-run green under the cache before this merges (correctness pinned before cache, per the plan's rejected Option C).

**Blocked by:** 11, 12 (reader-writer overlap lands first).

**Status:** ready-for-agent

- [ ] Estimation call with a 5k-row ledger performs a bounded file-parse count (instrumented readLine counter)
- [ ] External append between calls is picked up (size+mtime refresh test)
- [ ] Own writes invalidate immediately (write-then-read consistency test)
- [ ] All W2 accuracy suites green under the cache; cache age surfaced in data_status
