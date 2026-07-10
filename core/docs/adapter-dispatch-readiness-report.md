# Adapter Dispatch Readiness Report

`src/adapter-dispatch-readiness-report.mjs` builds a bounded, read-only
`AdapterDispatchReadinessReport` from the final handoff descriptors:

- `AdapterRunnerRegistry`
- `AdapterRunnerSelection`
- `AdapterDispatchEnvelope`
- `AdapterDispatchAssignment`

The report is for control-plane dashboards and external runner operators. It
answers whether a dispatch envelope, selected runner, and assignment are
compatible before a runner inspects the handoff.

## Checks

The report blocks when any required stage is not ready, when hashes are missing,
or when the chain does not bind cleanly:

- registry hash must match the registry content
- selection hash must match the selection content
- selection registry hash must match the registry hash
- assignment dispatch envelope hash must match the envelope hash
- assignment selection hash and registry hash must match the selection
- assignment hash must match the assignment content
- dispatch envelope hash must match the dispatch envelope content
- assignment runner location must be an external workspace path
- selection channel/action must match the dispatch envelope
- selection runner ID and capability hash must match the assignment runner
- registry route must match the selected runner and assignment
- dispatch envelope must still expose outbox/replay/manifest/preview/approval/evidence hashes
- human-feedback customer-facing envelopes must also expose the same
  `humanFeedbackRevisionContractHash` that the manifest/preview/SDK require
  for `customer_message`, `live_submit` / EPWK `workModifyLive`, and
  `acceptance_apply`
- human-feedback detection includes canonical product/workflow fields and
  package/review role aliases such as `human-feedback-review`; a role-only
  feedback handoff must still bind the feedback contract hash
- customer-message envelopes must bind `messagePreviewHash` to the cleartext
  preview, required hash binding, both manifest/preview handoff snapshots, and
  the preview adapter required hashes
- human-feedback customer-facing envelopes must bind
  `humanFeedbackRevisionContractHash` through the preview adapter required
  hashes as well as payload, required hashes, and manifest/preview handoff
  snapshots
- prompt-generation provider/model spend envelopes must bind the same redacted
  `promptGenerationBinding` across payload, required hashes, manifest snapshot,
  preview snapshot, and preview adapter required hashes with all six semantic
  fields present; stripping or truncating binding fields and recomputing the
  envelope/snapshot hashes still blocks readiness
- dispatch envelope must carry manifest/preview handoff snapshots whose stored
  hashes match both the required hashes and their recomputed content hashes

Manifest and preview content hashes are recomputed with the same source helpers
used by their builders: `computeChannelActionManifestHash()` and
`computeAdapterRunPreviewHash()`. Readiness does not carry its own parallel
field list.

Registry, selection, dispatch envelope, and assignment content hashes are also
recomputed with their source helpers: `computeAdapterRunnerRegistryHash()`,
`computeAdapterRunnerSelectionHash()`, `computeAdapterDispatchEnvelopeHash()`,
and `computeAdapterDispatchAssignmentHash()`. Readiness therefore rejects edited
runner routes, selected runner identity, dispatch envelope bodies, or assignment
bindings even when the old stored hash string is still present.

`computeAdapterDispatchReadinessReportHash(report)` is the source helper for the
readiness report digest. Its hash input canonicalizes customer-message
action aliases and human-feedback product/workflow aliases in the handoff
plus package/review role aliases in the handoff and manifest/preview snapshots
before digesting, so direct
`consumer-feedback-message` / `consumer_feedback` descriptors hash to the same
identity as builder-created `customer_message` / `human_feedback` reports.
Downstream SDK contract generation reuses this helper to reject a readiness
report whose body has changed while the old `reportHash` is still present.

It also fails if any input claims core execution, platform fetch, local state
application, or execution permission.

## Operator Hints

Each report includes deterministic `operatorHints` resolved through the
catalog in `src/dispatch-readiness-operator-hints.mjs`.

Ready reports include `external_runner_inspect_and_recheck` to make the boundary
explicit: a ready report is only descriptor-compatible. Blocked reports map
failed checks to local repair hints such as:

- `select_supported_runner_route`
- `select_matching_runner_route`
- `rebuild_dispatch_assignment`
- `refresh_dispatch_envelope_after_replay_guard`
- `restore_required_handoff_hashes`

These hints are labels for dashboards/operators. They are not commands and never
authorize execution. Selftests require every report hint and compact dashboard
hint code to resolve through the catalog before it can be shown as ready data.
See `dispatch-readiness-operator-hints.md`.

The report's `runner` block exposes `runnerLocationExternalWorkspace` so
dashboards can display the external-workspace boundary directly instead of
recomputing it from the path string.

## Boundary

Readiness reports never execute adapters, upload, submit, send messages, accept
delivery, pay, deploy, fetch channel state, apply lifecycle state, or grant
permission. A ready report only says the descriptors are internally consistent
for an external runner to inspect. The external runner must still re-check
current approval, fresh evidence, replay guard, duplicate/channel state,
prompt-generation binding when present, and current-chat authorization before
any external action.
