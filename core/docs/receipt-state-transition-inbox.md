# Receipt State Transition Inbox

`src/receipt-state-transition-inbox.mjs` is the intake contract for a local
`ReceiptStateTransition` after a successful `ChannelStateProofInboxItem`.

It verifies that the local transition belongs to the proof inbox chain:

- proof inbox is `received_channel_state_proof`
- proof inbox is waiting for `receipt_state_transition_ready`
- transition is a ready `ReceiptStateTransition`
- transition preserves both `transitionHash` and generic `hash`, and
  `transitionHash` recomputes from the transition body
- optional proof preserves both `proofHash` and generic `hash`
- proof hash matches between proof inbox, transition, and optional proof
- source proof inboxes must preserve `receiptInboxHash`, `receiptHash`, and
  `proofHash`; recomputing `proofInboxHash` after stripping those source
  bindings stays blocked
- declared proof-inbox identity and hash fields are required downstream; a
  transition or optional proof that omits a declared task/action/stage or
  receipt/proof/snapshot/replay hash is blocked as a mismatch
- transition `hashBinding` keeps the proof/receipt hash, platform snapshot hash,
  dry-run replay hash, customer-message `messagePreviewHash`, and customer
  feedback `humanFeedbackRevisionContractHash` continuous from the verified
  proof
- prompt-generation `promptGenerationBinding` stays continuous from proof inbox
  through the transition `hashBinding` and optional proof object; provider/model
  spend chains that strip every binding from the proof inbox, transition, and
  optional proof are blocked before ledger handoff even after hash recomputation
- transition `hashBinding` plus optional proof `hashBinding`, payload, and
  evidence must each carry the same complete six-field provider/model spend
  binding; one intact copy cannot mask a partially deleted sibling copy
- platform state snapshot and dry-run replay hashes continue from the verified
  proof inbox into the transition inbox hash binding
- customer-message transition intake keeps `messagePreviewHash` continuous from
  the proof inbox; human feedback transition intake also keeps
  `humanFeedbackRevisionContractHash` continuous. Human-feedback intake is
  detected from action/product/workflow identity and from role-only fields such
  as `packageRole`, `reviewType`, and `role`, so a canonical `customer_message`
  with `packageRole=human_feedback_review` cannot advance without the
  feedback contract hash
- when an optional proof object is supplied, its `hashBinding`, payload, and
  evidence must each keep the same customer-message `messagePreviewHash` and,
  for human-feedback proofs, the same
  `humanFeedbackRevisionContractHash`
- customer-message transition intake rehashes direct proof payload/evidence raw
  `messagePreview` / `previewText` / `messageText` fields with
  `computeCustomerMessagePreviewHashFromFields(value)` before trusting proof
  `messagePreviewHash` or `messagePreviewContentHash` metadata
- task, action, and requested stages match the verified proof
- the generated `transitionInboxHash` is a recomputable content hash and the
  final external action ledger rechecks it before trusting
  `received_receipt_state_transition`

## Next Step

The transition inbox classifies transition intake:

- `external_action_ledger_ready`: the transition is bound to the proof inbox and
  may proceed to the external action ledger chain check
- `blocked`: the transition is stale, mismatched, blocked, missing a valid
  self hash, or not for a transition-ready proof inbox item

## Boundary

The transition inbox does not apply lifecycle state and does not execute any
external action.

It only verifies a local transition artifact. The final audit chain still needs
the external action ledger check before a runner handoff is considered fully
verified.
