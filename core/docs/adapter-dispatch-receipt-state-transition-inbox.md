# Adapter Dispatch Receipt State Transition Inbox

`src/adapter-dispatch-receipt-state-transition-inbox.mjs` verifies that a local
`ReceiptStateTransition` belongs to a transition-ready dispatch proof inbox
item.

It exists because the dispatch path carries extra hashes that the standard
transition inbox does not see:

- dispatch proof inbox hash
- dispatch receipt inbox hash
- dispatch envelope hash
- outbox hash
- replay guard hash
- optional archive hash
- optional prior ledger hash
- receipt hash
- proof hash
- platform state snapshot hash
- dry-run replay hash
- customer-message `messagePreviewHash`
- human-feedback `humanFeedbackRevisionContractHash` when the proof inbox
  is feedback-contract-bound, including direct package/review role-only
  feedback handoffs
- prompt-generation `promptGenerationBinding` when the dispatch proof inbox or
  direct proof/transition/receipt identities are provider/model spend
- transition hash

## Flow

`buildAdapterDispatchReceiptStateTransitionInboxItem({
dispatchProofInboxItem, proof, transition, receipt })` returns an
`AdapterDispatchReceiptStateTransitionInboxItem`.

It accepts only dispatch proof inbox items that are:

- `received_dispatch_channel_state_proof`
- waiting for `receipt_state_transition_ready`
- backed by a verified `ChannelStateProof`
- paired with a ready `ReceiptStateTransition`
- proof preserves both `proofHash` and generic `hash`
- source dispatch proof inboxes preserve `dispatchReceiptInboxHash`,
  `dispatchEnvelopeHash`, `outboxHash`, `replayGuardHash`, `receiptHash`, and
  `proofHash`; optional archive/ledger hashes must continue matching when
  present, and recomputing `proofInboxHash` after stripping required bindings
  stays blocked
- carrying a transition body that preserves both `transitionHash` and generic
  `hash`, with `transitionHash` recomputing from the transition body
- carrying transition `hashBinding` that preserves proof/receipt, platform
  snapshot, dry-run replay, customer-message preview, and human-feedback
  contract hashes from the verified proof
- carrying transition `hashBinding` that preserves the dispatch proof inbox
  `promptGenerationBinding`; proof and optional receipt must also carry the same
  complete six-field binding, and stripping or partially deleting any binding
  copy while recomputing hashes is blocked
- aligned on channel/action/task/external ID, stage intent, and receipt/proof
  hashes
- declared dispatch proof-inbox identity and hash fields are required
  downstream; missing task/external/action/stage or receipt/proof/snapshot/replay
  hash values are blocked as mismatches
- preserving the required customer-message preview and human-feedback
  contract hashes from the dispatch proof inbox, and re-requiring the contract
  hash when the proof/receipt/transition only expose feedback identity through
  `packageRole`, `reviewType`, or `role`
- when a proof object is supplied, proof `hashBinding`, payload, and evidence
  must each preserve customer-message `messagePreviewHash`; human-feedback
  proofs require the same three-source binding for
  `humanFeedbackRevisionContractHash`
- rehashing direct proof payload/evidence and optional receipt payload/external
  raw `messagePreview` / `previewText` / `messageText` fields with
  `computeCustomerMessagePreviewHashFromFields(value)` before trusting
  `messagePreviewHash` or `messagePreviewContentHash` metadata

Successful transition inbox items advance only to
`external_action_ledger_ready`. The final ledger still has to verify the full
hash chain before any control plane can treat the external action as verified.

Dispatch replay-guard paths use the same transition inbox rule. A
repeat-approved dispatch proof inbox can become ledger-ready; proof inbox items
that came from a dispatch archive replay block or replay-candidate mismatch
remain blocked before final ledger handoff.
Archive-loop proof inbox fixtures also use this path: only repeat-approved loop
proofs become `external_action_ledger_ready`; replay, exact hash replay, and
candidate-mismatch proofs stay blocked.

## Boundary

The module never applies lifecycle state. It verifies the transition descriptor
as an inbox record only.

It never runs adapters, fetches channel state, uploads, submits, sends customer
messages, accepts delivery, pays, deploys, applies lifecycle state, or grants
execution permission.
