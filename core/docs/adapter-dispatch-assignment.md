# Adapter Dispatch Assignment

`src/adapter-dispatch-assignment.mjs` matches a ready
`AdapterDispatchEnvelope` to a ready `AdapterRunnerCapability`.

When a `AdapterRunnerSelection` is supplied, the assignment also binds the
selection hash and registry hash. The selected channel/action, runner ID, and
capability hash must match the envelope and capability.

It is the last core-owned check before an outside channel runner inspects a
handoff descriptor.

The assignment blocks when:

- the dispatch envelope is missing or not ready
- the dispatch envelope hash does not match the envelope content
- the dispatch envelope no longer exposes its core required runner hashes
  (`outboxHash`, `replayGuardHash`, `manifestHash`, `previewHash`,
  `approvalHash`, and `evidenceHash`), even if `dispatchEnvelopeHash` was
  recomputed after stripping them
- customer-message envelopes no longer expose the same `messagePreviewHash` in
  payload, required hashes, manifest snapshot, preview snapshot, and preview
  adapter required hashes
- human-feedback customer-facing envelopes no longer expose the same
  `humanFeedbackRevisionContractHash` in those same source copies for
  `customer_message`, `live_submit` / EPWK `workModifyLive`, or
  `acceptance_apply`
- provider/model spend envelopes no longer expose the same
  `promptGenerationBinding` in payload, required hashes, manifest snapshot,
  preview snapshot, and preview adapter required hashes with all six semantic
  fields present, even if all affected hashes were recomputed after stripping
  or truncating it
- the runner capability is missing or not ready
- the runner capability hash does not match the capability content
- the runner location is missing or points back into `design-production-core`
- the runner omits or mismatches the envelope channel
- the runner does not support the envelope action ID
- an attached registry selection is missing, blocked, omits the selected
  channel/action/runner/capability-hash binding, or mismatches the envelope and
  capability
- an attached registry selection hash does not match the selection content
- either input claims core execution permission

## Output

`buildAdapterDispatchAssignment({ dispatchEnvelope, runnerCapability })`
returns an `AdapterDispatchAssignment` with:

- `status`: `ready_adapter_dispatch_assignment` or
  `blocked_adapter_dispatch_assignment`
- `dispatch`: redacted envelope hash, channel/action/task identity, and required
  hashes for the runner
- `runner`: runner ID, runner location, capability hash, and supported actions
- `selection`: optional registry selection hash and selected runner identity
- `assignmentHash`: deterministic hash of the assignment descriptor

`computeAdapterDispatchAssignmentHash(assignment)` is the source helper for the
assignment digest. Its hash input canonicalizes customer-message action aliases
in the redacted dispatch identity before digesting, so a direct
`consumer-feedback-message` assignment hashes to the same identity as the
builder-created `customer_message` assignment. The assignment builder also
canonicalizes the public `dispatch.action` field before exposing the assignment,
so a direct alias dispatch envelope cannot leak raw human-feedback action
labels into runner assignment reports. It also recomputes source hashes from
`computeAdapterDispatchEnvelopeHash()`,
`computeAdapterRunnerCapabilityHash()`, and
`computeAdapterRunnerSelectionHash()` before it accepts upstream handoff
objects.

## Boundary

A ready assignment is still not execution permission. It only says a ready
envelope is compatible with a declared runner capability. The external runner
must still re-check current approval, fresh evidence, replay guard, duplicate
state, current channel state, and current-chat authorization before doing
anything external.

The module never runs adapters, uploads, submits, sends messages, accepts
delivery, pays, deploys, fetches channel state, applies lifecycle state, or
grants permission.
