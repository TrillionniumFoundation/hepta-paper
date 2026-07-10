# Dispatch Replay Cycle Invariant

`src/dispatch-replay-cycle-invariant.mjs` is a finite audit summary for the
dispatch replay-guard archive loop.

It consumes already-built core records:

- a ready dispatch audit archive
- replay guard decisions for archived replay, repeat approval, and exact hash
  replay
- dispatch envelopes
- dispatch receipt / proof / transition inbox records
- dispatch ledgers, audit bundles, and the next audit archive

The report proves the loop properties without adding another execution layer:

- archived same task/action stays blocked unless repeat approval exists
- exact `bundleHash` / `ledgerHash` replay never clears
- every chain hash in the summary is read from its semantic alias
  (`archiveHash`, `replayGuardHash`, `dispatchEnvelopeHash`, `ledgerHash`,
  `bundleHash`, and the dispatch inbox aliases). Generic `hash` is not used as
  a substitute when an alias is stripped.
- repeat approval can clear only the same task/action case
- candidate mismatch blocks at the dispatch envelope and cannot advance
- only the repeat-approved chain can produce a verified ledger, verified bundle,
  and ready next archive
- customer-message repeat cycles keep one `messagePreviewHash` across the
  repeat envelope, receipt/proof/transition inboxes, ledger, bundle, and next
  archive repeat entry
- human-feedback customer-facing repeat cycles keep one
  `humanFeedbackRevisionContractHash` across the same repeat chain for
  `customer_message`, `live_submit` / EPWK `workModifyLive`, and
  `acceptance_apply`. Feedback identity is detected from action/product/workflow
  fields and role-only fields such as `packageRole`, `reviewType`, and `role`,
  so repeat chains cannot hide feedback identity behind a generic external
  action
- the ready envelope is still not execution permission

## Boundary

The invariant report is audit-only. It never runs adapters, uploads, submits,
sends messages, accepts delivery, pays, deploys, fetches channel state, applies
local lifecycle state, or grants permission.

This module exists to stop the replay work from becoming an infinite sequence of
new wrappers. Future dispatch replay changes should update this summary when
they change a loop property, rather than adding another mechanical archive ->
guard -> envelope layer.
