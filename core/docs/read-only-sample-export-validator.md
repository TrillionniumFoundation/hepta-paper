# Read-only Sample Export Validator

`src/read-only-sample-export-validator.mjs` validates a generated
`reports/read-only-samples-latest.json` payload without running any adapter or
fetching channel state.

It recomputes:

- `dashboardSnapshot.snapshotHash`
- `dashboardSnapshot.status`
- `dashboardSnapshot.readyForDashboard`
- `exportStatus.statusHash`
- `exportStatus.status`
- `exportStatus.ok`

The nested dashboard snapshot and export status must each preserve both their
semantic hash alias (`snapshotHash` / `statusHash`) and generic `hash`, and the
alias/generic pair must match before the validator copies those hashes into
closeout/release evidence.

It also checks that the top-level `status` and `ok` fields match the nested
`exportStatus`, that `summary.sampleCount` matches the sample array, and that
the payload does not claim external action capability. The validator also
checks `unsupportedInventory`: the inventory count must match both its item
count and the samples with plan-only blockers, and its safety flags must remain
read-only/non-executing. The compact validation metrics preserve dispatch
readiness totals, blocked handoff count, operator hint count, and dashboard
warning/blocker counts for closeout and release-health reports.

## CLI

Run the validator against the latest export:

```bash
npm run validate:samples
```

Or pass a specific JSON report:

```bash
npm run validate:samples -- reports/read-only-samples-latest.json
```

The command prints a compact validation report and exits non-zero on read
errors, hash mismatches, status mismatches, sample count drift, or unsafe
external-action claims.

## Boundary

The validator is report-only. It never executes adapters, uploads, submits,
sends messages, accepts delivery, pays, deploys, fetches channel state, applies
lifecycle state, or grants permission.
