# Channel State Proof Inbox

`src/channel-state-proof-inbox.mjs` is the intake contract for a verified
`ChannelStateProof` after a successful `AdapterReceiptInboxItem`.

It verifies that the proof belongs to the same receipt chain:

- receipt inbox is `received_adapter_receipt`
- receipt inbox is waiting for `channel_state_proof_required`
- proof is a verified `ChannelStateProof`
- proof preserves both `proofHash` and generic `hash`; optional receipts
  preserve both `receiptHash` and generic `hash`
- source receipt inboxes must preserve `receiptHash`,
  `platformStateSnapshotHash`, and `dryRunReplayHash`; a recomputed `inboxHash`
  cannot substitute for stripped source hash bindings
- receipt hash matches between receipt inbox, proof, and optional receipt
- declared receipt-inbox identity and hash fields are required downstream; a
  proof or optional receipt that omits a declared channel/action/task/external
  ID or receipt/snapshot/replay hash is blocked as a mismatch
- customer-message proof intake keeps `messagePreviewHash` continuous from the
  receipt inbox into the proof; human feedback proof intake also keeps
  `humanFeedbackRevisionContractHash` continuous
- customer-message proofs must carry `messagePreviewHash` in proof
  `hashBinding`, proof payload, and proof evidence; human-feedback proofs
  require the same three-source binding for
  `humanFeedbackRevisionContractHash`
- prompt-generation proof intake keeps `promptGenerationBinding` continuous
  from the receipt inbox into the proof and optional receipt; provider/model
  spend chains that strip every binding from the receipt inbox, proof, and
  optional receipt are blocked even after recomputing the source hashes
- every provider/model spend binding copy in proof `hashBinding`, proof
  payload, proof evidence, optional receipt `hashBinding`, and optional receipt
  payload must be six-field complete and match the receipt inbox binding
- if a direct proof payload/evidence or optional receipt payload/external result
  includes raw `messagePreview` / `previewText` / `messageText`, the inbox
  recomputes it with `computeCustomerMessagePreviewHashFromFields(value)` from
  `src/contracts.mjs` before trusting `messagePreviewContentHash` or
  `messagePreviewHash`
- channel, action, task, and external ID match
- the generated `proofInboxHash` is a recomputable content hash and the final
  external action ledger rechecks it before trusting `received_channel_state_proof`

## Next Step

The proof inbox classifies proof intake:

- `receipt_state_transition_ready`: the proof is bound to the received receipt
  and may proceed to the local receipt state transition step
- `blocked`: the proof is stale, mismatched, blocked, or not for a proof-waiting
  receipt inbox item

## Boundary

The proof inbox does not fetch platform state and does not apply lifecycle
transitions.

External adapters must provide the independent current-channel proof outside
core. Core still requires the local `ReceiptStateTransition` step after this
inbox accepts the proof.
