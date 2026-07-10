# Read-only Sample Export Status

`src/read-only-sample-export-status.mjs` owns the final export status contract
for `npm run export:samples`.

It consumes:

- read-only sample `summary`
- top-level `ReadOnlyDashboardSnapshot`

It emits a `ReadOnlySampleExportStatus` with:

- `status`
- `ok`
- `readyForExport`
- metrics
- human-feedback sample coverage and contract/customer-facing validation
  metrics
- blockers and warnings
- deterministic `statusHash`

## Ready Rules

The status is `ready_readonly_sample_export` only when:

- `summary.validationOk === true`
- `summary.humanFeedback` proves human-feedback samples for ZBJ, EPWK,
  and Hepta
- role-only human-feedback samples have already been counted into that
  summary by the export/validator path
- every human-feedback sample has a ready contract validation and a ready
  customer-facing validation
- `dashboardSnapshot.readyForDashboard === true`
- neither input claims external action capability

Otherwise it is `blocked_readonly_sample_export`.

## Blockers

The selftest fixtures cover:

- failed sample validation
- missing human-feedback sample coverage
- dashboard snapshot not ready
- unsafe dashboard snapshot input

Warnings such as plan-only blocked samples and dashboard snapshot warnings are
kept visible because they are useful dashboard/operator information, not
external action permission.

## Boundary

This module is status-only. It never executes adapters, uploads, submits,
sends messages, accepts delivery, pays, deploys, fetches channel state, applies
lifecycle state, or grants permission.
