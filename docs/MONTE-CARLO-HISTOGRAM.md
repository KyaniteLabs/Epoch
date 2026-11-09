# Monte Carlo terminal histogram

Use the table format (or `--pretty`) to see the distribution of the actual simulated totals:

```sh
epoch --pretty monte-carlo-schedule \
  --tasks '[{"name":"api","optimistic":1,"most_likely":3,"pessimistic":9},{"name":"ui","optimistic":2,"most_likely":4,"pessimistic":12}]' \
  --iterations 5000 --seed 42
```

```text
8h days · 5,000 runs · seed 42
[ 3.81,  4.59)  23 █▊
[ 4.59,  5.36)  83 ██████▍
[ 5.36,  6.14) 170 ████████████▉
[ 6.14,  6.92) 286 █████████████████████▊
[ 6.92,  7.70) 401 ██████████████████████████████▌
[ 7.70,  8.48) 458 ██████████████████████████████████▉
[ 8.48,  9.26) 496 █████████████████████████████████████▊
[ 9.26, 10.04) 539 █████████████████████████████████████████
[10.04, 10.81) 525 ███████████████████████████████████████▉  ◀ P50 10.09
[10.81, 11.59) 459 ██████████████████████████████████▉
[11.59, 12.37) 436 █████████████████████████████████▏
[12.37, 13.15) 331 █████████████████████████▏
[13.15, 13.93) 258 ███████████████████▋
[13.93, 14.71) 206 ███████████████▋                          ◀ P90 14.03
[14.71, 15.49) 141 ██████████▊
[15.49, 16.27)  95 ███████▎
[16.27, 17.04)  50 ███▊
[17.04, 17.82)  27 ██
[17.82, 18.60)  10 ▊
[18.60, 19.38]   6 ▌
Bins [lo, hi); the last includes max.
Simulated spread, not observed outcomes.
```

## How to read it

- **Header**: unit (8-hour working days), the number of simulated runs and the seed, so the chart can be reproduced with `--seed`.
- **Rows**: 20 equal-width bins spanning the observed minimum and maximum. Each row is `[lower, upper)` (the last bin also includes the maximum), then the exact count, then a bar scaled to the largest count with 1/8-block resolution. Any non-empty bin shows at least a sliver. Edges are printed with the fewest decimals that keep neighbouring bins distinct.
- **Markers**: `◀ P50` and `◀ P90` sit in the bin holding the nearest-rank median and 90th percentile, and show the same rounded strings as the `p50` / `p90` fields above the chart. When both fall in one bin they share the row. Markers line up in a single column.
- No smoothing, fitted curve or synthetic samples. Counts sum to the completed iterations.

## Edge cases

- **One iteration**: `No distribution: one iteration (X days).`
- **Identical totals** (for example optimistic = most likely = pessimistic): one labelled point-mass line instead of 20 empty bins.

## Width and glyphs

The chart fits the terminal: the live TTY width, else `$COLUMNS`, else 80 columns, clamped to 40–160. Bars use Unicode block elements. Plain ASCII (`#` bars, `<` markers) is used when `TERM=dumb` or the locale is Japanese, Chinese or Korean: those terminals often draw block elements double-width, which would push an 80-column chart to about 129 columns. `EPOCH_CHART_ASCII=1` or `=0` forces either style.

## Contract

JSON remains the default. JSON, MCP and HTTP responses keep their existing fields and types. Histogram metadata is process-local, weakly keyed by the simulation result, and never serialized, so a saved JSON result cannot reconstruct a histogram. Raw samples are not retained after the simulation returns.
