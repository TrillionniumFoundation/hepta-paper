# Read-only Closeout Summary

`src/read-only-closeout-summary.mjs` turns a verbose
`ReadOnlyCoreGateReport` plus its `ReadOnlyCoreGateValidationReport` into a
compact dashboard record.

It preserves the important closeout facts:

- gate status and failed-step count
- source and fixture file counts
- public API module count from selftest
- read-only sample count and plan-only blocker count
- dispatch readiness totals, blocked handoff count, dashboard warning count,
  and unknown operator-hint count so role-only human-feedback handoff
  blockers stay visible after sample export
- gate hash, recomputed gate hash, validation hash, sample validation hash,
  dashboard snapshot hash, and export status hash
- required semantic aliases plus generic hashes for the source gate report and
  gate validation report before those hashes are copied into the closeout chain
- dashboard snapshot and export status hashes only from
  `validate_samples.hashChecks`, not from display-only generic `hash` values in
  the sample export summary
- latest gate/sample report artifact paths
- blockers and warnings that a dashboard should display

Run:

```bash
npm run summarize:closeout
```

The CLI reads `reports/read-only-core-gate-latest.json`, validates it, writes
`reports/read-only-closeout-latest.json` and `reports/read-only-closeout-latest.md` plus timestamped copies, and
prints a compact JSON summary. Pass `--stdout-only` to avoid writing the
closeout report.

Run `npm run validate:closeout` after writing the report to recompute the
closeout summary hash, verify report-file bindings, and block unsafe
external-action claims before dashboard ingestion.

## Boundary

The closeout summary is dashboard-only. It reads local report evidence and
recomputes local hashes only. It never executes adapters, uploads, submits,
sends messages, accepts delivery, pays, deploys, fetches channel state, applies
lifecycle state, grants permission, or replaces external-runner approval,
evidence, replay, duplicate, channel-state, and current-chat checks.
