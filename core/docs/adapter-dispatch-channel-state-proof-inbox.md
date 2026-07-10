# Adapter Dispatch Channel State Proof Inbox

`src/adapter-dispatch-channel-state-proof-inbox.mjs` verifies that a
`ChannelStateProof` belongs to a successful `AdapterDispatchReceiptInboxItem`.

It exists because dispatch-path receipts include extra handoff hashes:

- dispatch receipt inbox hash
- dispatch envelope hash
- outbox hash
- replay guard hash
- optional archive hash
- optional prior ledger hash
- receipt hash
- proof hash
- platform state snapshot and dry-run replay hashes
- customer-message `messagePreviewHash`
- human-feedback `humanFeedbackRevisionContractHash` when the receipt
  inbox or verified proof is feedback-contract-bound, including direct
  package/review role-only feedback handoffs
- prompt-generation `promptGenerationBinding` from the dispatch receipt inbox
  into the proof and optional receipt, with provider/model spend chains blocked
  if every binding is stripped and the receipt/proof hashes are recomputed
- every provider/model spend binding copy in proof `hashBinding`, proof
  payload, proof evidence, optional receipt `hashBinding`, and optional receipt
  payload must be six-field complete and match the dispatch receipt inbox
  binding

## Flow

`buildAdapterDispatchChannelStateProofInboxItem({
dispatchReceiptInboxItem, proof, receipt })` returns an
`AdapterDispatchChannelStateProofInboxItem`.

It accepts only dispatch receipt inbox items that are:

- `received_dispatch_receipt`
- waiting for `channel_state_proof_required`
- backed by a verified `ChannelStateProof`
- proof preserves both `proofHash` and generic `hash`; optional receipts
  preserve both `receiptHash` and generic `hash`
- source dispatch receipt inboxes preserve `dispatchEnvelopeHash`, `outboxHash`,
  `replayGuardHash`, `receiptHash`, `platformStateSnapshotHash`, and
  `dryRunReplayHash`; optional archive/ledger hashes must continue matching
  when present, and a recomputed dispatch receipt `inboxHash` cannot substitute
  for stripped required source hash bindings
- aligned on channel/action/task/external ID and receipt hash
- declared dispatch receipt-inbox identity and hash fields must be present on
  the proof and optional receipt; missing task/external/action or
  receipt/snapshot/replay hash values are blocked as mismatches
- carrying the required customer-message preview hash, and the required
  human-feedback contract hash when this is a feedback-message route or a
  role-only human-feedback handoff
- proof `hashBinding`, proof payload, and proof evidence must each carry the
  same customer-message `messagePreviewHash`; human-feedback proofs require
  the same three-source binding for `humanFeedbackRevisionContractHash`
- carrying the required prompt-generation binding when the dispatch receipt
  inbox or direct proof/receipt identities are provider/model spend; proofs or
  receipts that omit, partially delete, or change it stay blocked
- if a direct proof payload/evidence or optional receipt payload/external result
  includes raw `messagePreview` / `previewText` / `messageText`, the inbox
  recomputes it with `computeCustomerMessagePreviewHashFromFields(value)` from
  `src/contracts.mjs` before trusting `messagePreviewContentHash` or
  `messagePreviewHash`

Successful proof inbox items advance only to `receipt_state_transition_ready`.
They still do not apply the transition.

Dispatch replay-guard envelopes are covered by the same proof inbox rule. A
repeat-approved dispatch guard can produce a receipt inbox item that accepts
verified proof; a receipt inbox produced from a blocked dispatch archive replay
or replay-candidate mismatch remains blocked before transition.
Archive-loop receipt inbox fixtures use the same proof path: only the
repeat-approved loop receipt can become `receipt_state_transition_ready`; replay,
exact hash replay, and candidate-mismatch receipts stay blocked.

## Boundary

The module never fetches platform state. It verifies normalized proof supplied by
the owning channel adapter and keeps all effects outside core.

It never runs adapters, uploads, submits, sends customer messages, accepts
delivery, pays, deploys, applies lifecycle state, or grants execution
permission.
