# External Action Ledger

`src/external-action-ledger.mjs` is the append-only audit shape for one
external-action handoff.

It chains the non-executing core contracts:

```text
ChannelActionManifest
  -> AdapterRunPreview
  -> AdapterRunReceipt
  -> ChannelStateProof
  -> ReceiptStateTransition
```

Newer control-plane paths should also include the standard inbox chain:

```text
AdapterHandoffOutboxItem
  -> AdapterReceiptInboxItem
  -> ChannelStateProofInboxItem
  -> ReceiptStateTransitionInboxItem
```

Dispatch-path handoffs can use the replay-guarded inbox chain instead:

```text
AdapterDispatchEnvelope
  -> AdapterDispatchReceiptInboxItem
  -> AdapterDispatchChannelStateProofInboxItem
  -> AdapterDispatchReceiptStateTransitionInboxItem
```

## Why It Exists

The individual contracts each protect one boundary. The ledger entry gives the
control plane a single redacted record for review, replay analysis, and incident
audits.

It can represent:

- `pending_runner_receipt`: manifest and dry-run preview are ready, runner has
  not returned a receipt
- `pending_channel_state_proof`: receipt exists, independent platform proof is
  still missing
- `pending_state_transition`: platform proof exists, local lifecycle transition
  has not been applied
- `verified_action_ledger`: the whole chain is complete and hash-bound
- `blocked_action_ledger`: a hash, receipt, proof, or transition mismatch exists

## Hash Chain

The ledger verifies:

- preview binds the manifest hash
- manifest and dry-run preview also carry the same handoff identity
  (`channelId`, `actionId`, action, task/external id, product/workflow, and
  package role). Recomputing both hashes after changing one snapshot's semantic
  identity leaves the ledger blocked with
  `ledger_handoff_snapshot_identity_mismatch`.
- receipt binds manifest, preview, approval, evidence, platform state snapshot,
  and dry-run replay hashes
- channel proof binds the receipt hash plus the receipt's snapshot/replay hashes
- receipt-state transition binds the proof hash and carries a recomputable
  `transitionHash`
- direct receipt/proof objects are rehashed before the ledger accepts them, so
  copied `accepted` / `verified` status with a stale hash cannot advance the
  audit chain. The ledger also requires direct receipt/proof/transition objects
  to keep their semantic hash aliases (`receiptHash`, `proofHash`,
  `transitionHash`) alongside the generic `hash`; deleting the semantic alias
  while keeping the generic hash leaves the ledger blocked
- `customer_message` receipts/proofs are semantically rechecked at the ledger
  entry too: when the manifest/preview carries a message preview hash, the
  receipt payload, runner external result, proof payload, and proof evidence
  must carry the same value. Human-feedback customer-facing actions
  (`customer_message`, `live_submit` / EPWK `workModifyLive`, and
  `acceptance_apply`) are also rechecked for
  `humanFeedbackRevisionContractHash` across the same receipt/proof sources.
  A forged direct receipt/proof with a recomputed object hash but missing
  feedback contract evidence remains `blocked_action_ledger`. The ledger also
  rehashes any available customer-message preview text/content hash in the
  manifest, preview, receipt payload, runner result, and proof evidence, so a
  forged direct object cannot keep a stale `messagePreviewHash` while mutating
  the customer-facing text. If a direct runner result or proof evidence includes
  raw `messagePreview` / `previewText` / `messageText`, the ledger recomputes
  that text and compares it with both the stored `messagePreviewContentHash` and
  the public `messagePreviewHash`; it does not trust a supplied content hash by
  itself. All of those content checks use
  `computeCustomerMessagePreviewHash(messagePreview)` and
  `computeCustomerMessagePreviewHashFromFields(value)` from `src/contracts.mjs`
  rather than local copies of the preview digest field list.
- direct transition objects are also rehashed and compared back to the verified
  proof's task/action/stage suggestion before the ledger accepts them. If the
  proof declares task, action, or from/to stage identity, the transition result
  must carry those same values; omission is blocked, not treated as unknown
- optional receipt/proof/transition inboxes bind their own handoff hashes, and
  the ledger recomputes each inbox item's content hash before trusting its
  `received` status. Customer-message preview/human-feedback contract hashes
  must also stay bound through the standard receipt, proof, and transition
  inboxes. Package/review role aliases such as `human-feedback-review` are
  treated as human-feedback identity when deciding whether the feedback
  contract hash is required. The final ledger fails closed if any standard
  receipt/proof/transition inbox item omits a required upstream
  `receiptInboxHash`, `receiptHash`, `proofInboxHash`, `proofHash`,
  `transitionHash`, platform snapshot hash, or dry-run replay hash, even when
  the mutated inbox item recomputes its own content hash. Inbox items must also
  preserve their semantic item hash aliases (`inboxHash`, `proofInboxHash`,
  `transitionInboxHash`) alongside generic `hash`.
- optional dispatch receipt/proof/transition inboxes also bind dispatch envelope,
  outbox, replay guard, optional archive, optional prior ledger, receipt, proof, and
  transition hashes; dispatch inbox content hashes are also recomputed, and
  customer-message preview/human-feedback contract hashes must stay bound
  through the dispatch receipt, proof, and transition inboxes. The dispatch
  final ledger uses the same fail-closed rule for required receipt/proof/
  transition inbox hash bindings, including the required dispatch envelope/
  outbox/replay lineage hashes, and for each dispatch inbox item's
  semantic item hash alias plus generic `hash`.
- prompt-generation provider/model spend chains keep
  `promptGenerationBinding` continuous through manifest, preview, receipt,
  proof, transition, standard inboxes, dispatch inboxes, ledger payload, and
  ledger chain. The binding must include all six prompt/reference/readiness/
  production/generation-job fields. If any present chain node drops, truncates,
  or changes the binding, the ledger stays `blocked_action_ledger`. If the
  chain still identifies itself as provider/model spend but every source has
  stripped the binding and recomputed its object hash, the ledger blocks with
  `ledger_prompt_generation_binding_required` instead of treating the binding as
  optional; incomplete bindings block with
  `ledger_prompt_generation_binding_incomplete`.
  The ledger also checks sibling copies inside each direct source: preview
  payload vs adapter required hashes, receipt `hashBinding` vs payload, proof
  `hashBinding` vs payload vs evidence, transition `hashBinding`, and each
  standard/dispatch inbox `hashBinding` must all be six-field complete and
  match the chain binding. One intact copy cannot hide a recomputed object whose
  adjacent binding copy lost a semantic prompt-generation field.

Dispatch replay-guard fixtures run through the full dispatch inbox chain. A
repeat-approved dispatch archive guard can end in `verified_action_ledger`, while
dispatch archive replay or replay-candidate mismatch chains remain blocked.
Archive-loop fixtures extend that path after replay-guard bundles have been
archived: only repeat-approved loop chains can verify; archived replay, exact
hash replay, and candidate mismatch remain blocked before audit-bundle use.

It also carries the channel action ID, task key, product line, workflow,
canonical package role, message preview hash, human-feedback revision
contract hash, prompt-generation binding, artifact names, and blocker codes.

## Boundary

The ledger never executes adapters. It does not retry, upload, submit, send,
accept delivery, pay, or deploy. It only records whether the handoff chain is
complete and internally consistent.
