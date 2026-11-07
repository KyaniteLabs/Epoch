# Monte Carlo terminal histogram

Use the existing table format (or `--pretty`) to see the distribution of actual completed simulation totals:

```sh
epoch --format table monte-carlo-schedule \
  --tasks '[{"name":"work","optimistic":1,"most_likely":3,"pessimistic":9}]' \
  --iterations 1000
```

The histogram has 20 equal-width bins spanning the observed minimum and maximum in **8-hour working days**. Intervals include the lower endpoint and exclude the upper endpoint, except the final bin includes the maximum. Each row gives its exact endpoints and count; bars scale to the largest count (32 blocks maximum). No smoothing, fitted curve, or percentile-derived synthetic samples are used.

Median (p50) and p90 markers show the unrounded nearest-rank observed values. The existing string percentile fields above the chart remain rounded exactly as before. Counts sum to completed iterations. One completed iteration prints only its exact value instead of a distribution. For repeated identical totals, all counts occupy the first of 20 zero-width bins; this degenerate case is explicitly labelled.

JSON remains the default. JSON, MCP and HTTP responses keep their existing fields and types; histogram metadata is process-local, weakly keyed by the simulation result, and is not serialized. A saved JSON result cannot reconstruct a histogram. Raw samples are not retained after the simulation returns. Exporting samples or bins is not part of this feature.
