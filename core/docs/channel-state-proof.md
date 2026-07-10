# Channel State Proof

`src/channel-state-proof.mjs` is the verification layer after an external
adapter runner returns an `AdapterRunReceipt`.

The receipt is only the runner's claim. A `ChannelStateProof` records an
independent, current read of channel state that confirms the claim before the
core lifecycle can move forward.

## Inputs

A proof binds:

- the accepted `AdapterRunReceipt`
- the receipt hash
- platform state snapshot hash from the receipt
- dry-run replay hash from the receipt
- customer-message preview hash and human-feedback contract hash from the
  receipt when present, copied into the proof hash binding as well as the proof
  payload
- prompt-generation binding from the receipt when present, copied into the
  proof hash binding and payload; provider/model spend receipts must carry this
  binding, current-channel evidence must echo it, and stripping or partially
  deleting the binding while recomputing the receipt hash blocks proof
  verification
- canonical package/review role identity from the receipt when the feedback
  workflow is identified by role aliases
- normalized current-channel evidence
- action-specific external IDs
- artifact count or artifact names where applicable
- redacted evidence references

The module never fetches channel state itself. ZBJ, EPWK, Hepta, or another
owning adapter must do the read-only platform check and pass the normalized
evidence in.

## Action Evidence

Successful proofs require action-specific confirmation:

- `live_submit`: `worksId` / `submissionId`, verified landed state, and matching artifact count or names
- `live_prepare`: prepare result ID, `prepareEvidenceOk=true`, and matching uploaded artifacts
- `acceptance_apply`: acceptance result ID
- `customer_message`: sent message ID plus a matching `messagePreviewHash`, or
  observed message text that hashes to it, when the receipt was bound to an
  approved message preview
- human-feedback customer-facing actions additionally require the matching
  `humanFeedbackRevisionContractHash` for `customer_message`,
  `live_submit` / EPWK `workModifyLive`, and `acceptance_apply`
- `deployment`: deployment/build/url evidence
- `provider_spend`: provider run ID or cache key plus matching `promptGenerationBinding`
- `model_spend`: model run ID or cache key plus matching `promptGenerationBinding`

When receipts include additional aliases such as `externalResultId`, state
proof compares matching named fields first and treats aliases as supporting
evidence instead of forcing every alias to equal every channel ID.

Blocked, failed, cancelled, or tampered receipts cannot become verified proofs.
The proof builder, receipt-state transition builder, proof inboxes, transition
inboxes, and ledger inputs recompute receipt/proof/transition object hashes;
`accepted=true`, `verified=true`, or `ready=true` is not enough if the supplied
object body no longer hashes to its recorded `receiptHash`, `proofHash`, or
`transitionHash`.
Those objects must also preserve both their semantic hash aliases
(`receiptHash`, `proofHash`, `transitionHash`) and generic `hash` fields; a
generic `hash` alone is not accepted as a substitute for the semantic alias.
For preview-bound customer messages, a current channel read that proves only the
message ID is not enough: the proof must also bind the observed sent text hash
back to the approved preview hash carried through the receipt.
The proof builder rehashes `receipt.payload.messagePreview` against
`receipt.payload.messagePreviewHash` as well, so a forged receipt with a fresh
object hash but stale message preview metadata cannot become channel proof.
For human-feedback customer-facing actions, the proof must also carry the
same `humanFeedbackRevisionContractHash` as the receipt. A proof for the
right message text, submitted work, or acceptance ID but the wrong feedback
revision contract stays blocked.
For prompt-generation provider/model spend receipts, the proof keeps the same
`promptGenerationBinding` across hash binding, payload, and channel evidence.
The proof builder treats provider/model spend as binding-required even if a
direct receipt was rehashed after deleting every binding field.
It also checks receipt `hashBinding` and receipt payload independently, so one
complete copy cannot mask another binding copy that is missing a semantic field.
This prevents a post-action proof from confirming the provider run while losing
the resolver/compiler/readiness/production/generation-job chain that authorized
that spend.
If the proof includes both observed message text and `messagePreviewHash`, Core
recomputes the text hash and blocks the proof when the cleartext evidence and
reported hash disagree. The source helper is
`computeCustomerMessagePreviewHash(messagePreview)` from `src/contracts.mjs`;
raw state evidence objects use the shared
`computeCustomerMessagePreviewHashFromFields(value)` field helper.

## State Transition

`buildReceiptStateTransition()` can turn a verified proof into a local
state-machine transition using the receipt's state suggestion.
The proof builder canonicalizes the receipt `stateSuggestion.action` before it
stores the proof body or computes `proofHash`; proof summaries bucket actions by
the same canonical action ID. Direct receipts that spell human feedback as
`consumer-feedback-message`, `buyer-feedback-message`, or another supported
alias therefore publish and hash as `customer_message`.

The returned transition carries `transitionHash` / `hash`. Transition inboxes
and direct ledger inputs recompute that hash before accepting the transition, so
changing the suggested stage, task, or result after proof verification blocks
the post-action chain.
The transition builder and inboxes require the verified proof to keep both
`proofHash` and generic `hash`, and require transition objects to keep both
`transitionHash` and generic `hash`.
For provider/model spend, the transition builder also requires the verified
proof to carry `promptGenerationBinding`; a direct proof with a fresh proof hash
but stripped or incomplete hash-binding/payload/evidence copy cannot become
transition-ready.
For customer-message proofs, `buildReceiptStateTransition()` also rehashes the
proof payload/evidence raw `messagePreview` / `previewText` / `messageText`
fields before treating a verified proof as transition-ready. A direct proof
object with a fresh `proofHash` but stale `messagePreviewHash` metadata stays
blocked at transition creation.
The transition also carries a hash-bound `hashBinding` copied from the verified
proof. Customer-message transitions keep `messagePreviewHash` in the transition
body, and human-feedback customer-facing transitions keep
`humanFeedbackRevisionContractHash`, so the transition artifact remains
inspectable on its own instead of relying only on the surrounding inbox chain.

This is still local only. It does not retry, upload, submit, send messages,
apply acceptance, pay, or deploy. It only gives the control plane an auditable
state transition after the external action has already been independently
verified.

## Safety

`ChannelStateProof.safety.executesExternalAction` is always `false`.

`ChannelStateProof.safety.fetchesChannelState` is always `false`.

Real adapters must keep doing their own current-state reads and must not treat
old receipts, stale screenshots, or local package state as proof of platform
state.

The checked-in proof fixtures mirror the post-action evidence matrix too.
Selftest blocks if verified success fixtures omit any SDK
`actionEvidenceContract.stateProofFields` entry or if proof action IDs drift from
the 20 supported adapter routes.
