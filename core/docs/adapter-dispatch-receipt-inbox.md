# Adapter Dispatch Receipt Inbox

`src/adapter-dispatch-receipt-inbox.mjs` verifies the receipt returned by an
external runner after the runner received an `AdapterDispatchEnvelope`.

It binds:

- dispatch envelope hash
- outbox hash
- replay guard hash
- optional archive hash
- optional ledger hash
- receipt hash
- manifest, preview, approval, evidence, platform state snapshot, and dry-run
  replay hashes
- customer-message `messagePreviewHash` when the dispatch envelope requires it
- human-feedback `humanFeedbackRevisionContractHash` when the dispatch
  envelope requires it, or when a direct receipt/envelope is a customer-message
  handoff identified only by `packageRole`, `reviewType`, or `role`
- customer-message dispatch envelopes must keep `messagePreviewHash` in envelope
  payload, runner required hashes, handoff manifest snapshot, handoff preview
  payload, and preview adapter required hashes; human-feedback envelopes
  require the same five-source binding for
  `humanFeedbackRevisionContractHash`
- prompt-generation `promptGenerationBinding` when the dispatch envelope or
  receipt identifies provider/model spend; stripping every binding and
  recomputing the dispatch envelope or receipt hash is blocked before
  channel-state proof
- provider/model spend bindings are checked per source copy: dispatch envelope
  payload, runner required hashes, handoff manifest/preview snapshots, receipt
  `hashBinding`, and receipt payload must each carry the same complete six-field
  `promptGenerationBinding`
- raw receipt payload / runner external result `messagePreview`,
  `previewText`, or `messageText` is recomputed with
  `computeCustomerMessagePreviewHashFromFields(value)` from `src/contracts.mjs`
  before the inbox trusts `messagePreviewContentHash` or `messagePreviewHash`
- channel/action/task/external ID identity
- declared dispatch envelope identity fields are required on the receipt;
  missing channel/action/task/external ID values are blocked as dispatch
  identity mismatches
- source dispatch envelopes must preserve core `runner.requiredHashes` for
  outbox, replay guard, manifest, preview, approval, and evidence. Recomputing
  `dispatchEnvelopeHash` after stripping those bindings is blocked before the
  receipt inbox can advance, while archive/ledger hashes remain optional and are
  compared when present.

## Flow

`buildAdapterDispatchReceiptInboxItem({ dispatchEnvelope, receipt })` returns an
`AdapterDispatchReceiptInboxItem`.

Statuses:

- `received_dispatch_receipt`: accepted success receipt, ready for independent
  channel-state proof
- `terminal_dispatch_result_recorded`: accepted non-success receipt, recorded as
  terminal with no channel-proof step
- `blocked_dispatch_receipt_inbox`: dispatch or receipt hash/identity mismatch

Dispatch replay-guard envelopes use the same inbox path. A repeat-approved
dispatch archive guard may produce a ready envelope whose receipt can advance to
`channel_state_proof_required`; an envelope blocked by a dispatch archive replay
or replay-candidate mismatch remains unable to accept a runner receipt.
Archive-loop dispatch envelope fixtures follow the same rule: only the
repeat-approved loop descriptor can accept a receipt, while archived replay,
exact hash replay, and candidate mismatch descriptors remain blocked.

The dispatch envelope hash check reuses
`computeAdapterDispatchEnvelopeHash(envelope)`, so direct/prebuilt descriptors
with canonical-equivalent human-feedback aliases are verified against the same
digest semantics as the envelope builder.

## Boundary

This module is still an inbox verifier only. It does not run the external
runner, fetch platform state, upload files, submit work, send customer messages,
accept delivery, pay, deploy, apply local lifecycle state, or grant execution
permission.

A successful dispatch receipt still requires a separate `ChannelStateProof`
before any lifecycle transition can be considered.
