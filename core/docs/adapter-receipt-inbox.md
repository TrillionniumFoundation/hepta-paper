# Adapter Receipt Inbox

`src/adapter-receipt-inbox.mjs` is the intake contract for a receipt returned by
an external channel runner after an `AdapterHandoffOutboxItem`.

It verifies that the receipt actually belongs to the queued outbox item:

- outbox is `queued_for_external_adapter`
- receipt is an accepted `AdapterRunReceipt`
- channel, action, task, and external ID match
- declared outbox identity fields are required on the receipt; missing channel,
  action, task, or external ID values are treated as mismatches, not as
  optional blanks
- manifest, preview, approval, evidence, platform state snapshot, and dry-run
  replay hashes remain present on the receipt
- customer-message receipts preserve the outbox-required `messagePreviewHash`;
  human feedback receipts also preserve
  `humanFeedbackRevisionContractHash`
- customer-message outboxes are rechecked per source copy before a receipt can
  advance: outbox payload, runner required hashes, handoff manifest snapshot,
  handoff preview payload, and preview adapter required hashes must all carry
  the same `messagePreviewHash`; human-feedback handoffs require the same
  five-source binding for `humanFeedbackRevisionContractHash`
- prompt-generation provider/model spend receipts preserve the outbox-required
  `promptGenerationBinding`; if the outbox or receipt still identifies
  provider/model spend, stripping every binding and recomputing the source hash
  is blocked, and a runner receipt that omits or changes the binding is blocked
  even when the receipt object hash is otherwise valid
- provider/model spend bindings are checked per source copy: outbox payload,
  runner required hashes, handoff manifest/preview snapshots, receipt
  `hashBinding`, and receipt payload must each carry the same complete six-field
  `promptGenerationBinding`; a recomputed hash does not hide one incomplete copy
- if a direct receipt payload or runner external result includes raw
  `messagePreview` / `previewText` / `messageText`, the inbox recomputes it
  with `computeCustomerMessagePreviewHashFromFields(value)` from
  `src/contracts.mjs` before trusting `messagePreviewContentHash` or
  `messagePreviewHash`
- optional ledger is still `pending_runner_receipt`
- the generated `inboxHash` is a recomputable content hash and the final
  external action ledger rechecks it before trusting `received_adapter_receipt`

## Next Step

The inbox classifies valid receipts:

- `channel_state_proof_required`: the runner reports success, so core still
  needs independent current-channel proof before lifecycle state advances
- `terminal_result_recorded`: the runner reports failed, blocked, cancelled, or
  dry-run result; the receipt is recorded but does not advance to proof
- `blocked`: the receipt cannot be trusted for this outbox item

## Boundary

The inbox does not run adapter commands and does not fetch channel state.

Real channel runners must still append receipts outside core, and successful
receipts must still pass `ChannelStateProof` before any local state transition.
