# Read-only Dashboard Snapshot

`src/read-only-dashboard-snapshot.mjs` builds a bounded dashboard payload from
read-only sample export summary data and the synthetic control-plane dispatch
readiness summary.

It is for UI/dashboard code that needs one stable object instead of interpreting
several summary sections independently.

## Inputs

- sample summary from the read-only sample export
- `controlPlane` from `buildDispatchReadinessControlSamples()`
- optional compact sample rows for display

## Output

`ReadOnlyDashboardSnapshot` includes:

- overall dashboard status
- sample, plan-only, dispatch, and hint-catalog metrics
- human-feedback sample metrics, including cross-channel coverage and
  contract/customer-facing validation counts
- source/product/workflow/status summaries; product/workflow summary bucket
  keys are canonicalized so feedback aliases such as `consumer_feedback` and
  `buyer-feedback` roll up as `human_feedback`
- human-feedback sample source summaries
- compact sample rows, including canonical `packageRole`/`reviewType`/`role`
  fields when a sample carries role-only human-feedback identity
- compact dispatch rows, including human-feedback contract/message-preview
  hashes for `zbj.customerMessagePreview`; dispatch action/product/workflow
  identity is canonicalized before it reaches the dashboard payload
- blockers and warnings
- a deterministic snapshot hash

Plan-only blockers and blocked dispatch handoffs are warnings when the data is
safe to display. Unknown operator hints, failed sample validation, missing
control-plane status, missing ZBJ/EPWK/Hepta human-feedback sample coverage,
missing human-feedback contract/customer-facing validation, or any input
claiming external execution become blockers.

Selftests cover the ready path plus blocked fixtures for failed sample
validation, unknown operator hints, missing human-feedback sample coverage,
and unsafe input claims.

## Boundary

The snapshot is dashboard display data only. It never executes adapters, uploads,
submits, sends messages, accepts delivery, pays, deploys, fetches channel state,
applies lifecycle state, grants permission, or replaces external-runner
approval/evidence/replay/duplicate/channel/current-chat checks.
