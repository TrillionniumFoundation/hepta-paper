# Adapter Handoff Outbox

`src/adapter-handoff-outbox.mjs` is the queue item contract between core and
the real channel-owned adapter runner.

It packages:

- a ready `ChannelActionManifest`
- a `dry_run_ready` `AdapterRunPreview`
- hash-bound `handoffSnapshots.manifest` and `handoffSnapshots.preview`
- an optional `pending_runner_receipt` ledger entry
- command preview, required flags, and hash bindings
- artifact names, action metadata, and canonical `packageRole` identity
- redacted prompt/generation binding when the handoff is for prompt-driven
  provider/model spend

## Status

Outbox items can be:

- `queued_for_external_adapter`: ready for an external adapter runner to inspect
- `blocked_outbox_item`: manifest, preview, ledger, or hash binding is unsafe

Only a pending-runner ledger can be queued. A ledger that already has a receipt,
channel proof, transition, verified state, or blocked state cannot be queued
again.

Queued handoffs require their source objects to keep semantic hash aliases and
generic `hash` together. A manifest must preserve `manifestHash`, a preview must
preserve `previewHash`, and an attached ledger must preserve `ledgerHash`; each
alias must match the object's generic `hash`.
The outbox also compares manifest and preview snapshot identity, not just their
content hashes. A hash-intact manifest/preview pair with different
channel/action/task/external/product/workflow/package-role identity is blocked
with `outbox_handoff_snapshot_identity_mismatch`.

Prompt-driven provider/model spend handoffs must also preserve the complete
`promptGenerationBinding` in the manifest payload, preview payload, and preview
adapter `requiredHashes`. A forged ready manifest/preview pair that deletes the
binding and recomputes `manifestHash` / `previewHash` is blocked at the outbox
with `outbox_prompt_generation_binding_required`, before dispatch assignment.
Customer-message handoffs have the same source-copy rule for
`messagePreviewHash`: manifest payload, preview payload, and preview adapter
`requiredHashes` must all carry the same value. Customer-facing feedback
handoffs also require those three sources to bind
`humanFeedbackRevisionContractHash` for `customer_message`,
`live_submit` / EPWK `workModifyLive`, and `acceptance_apply`. A forged ready
manifest/preview pair
that deletes one source copy and recomputes the object hashes is blocked at the
outbox with `outbox_message_preview_hash_required` or
`outbox_human_feedback_contract_hash_required`.

## Boundary

The outbox never executes commands. It keeps `readyForExecution=false` and
records only the redacted command preview.

Its safety declaration keeps the external-runner boundary explicit:

- `requiresExternalAdapter=true`
- `externalRunnerMustRecheckApproval=true`
- `externalRunnerMustRecheckEvidence=true`
- `externalRunnerMustRecheckChannelState=true`
- `externalRunnerMustAppendReceipt=true`
- `currentChatApprovalStillRequired=true`

The real runner must live outside core and must still re-check:

- current-chat approval
- approval hash
- evidence hash
- `messagePreviewHash` for customer-message handoffs
- `humanFeedbackRevisionContractHash` for human-feedback customer-facing
  handoffs
- `promptGenerationBinding` for prompt-driven provider/model spend handoffs
- package/review role identity such as `human_feedback_review`, when the
  feedback workflow is identified by role rather than product/workflow fields
- manifest hash
- preview hash
- attached pending ledger hash, when present
- the manifest/preview snapshots by recomputing their content hashes
- the manifest/preview snapshots by comparing their task/action identity
- current channel state

After it acts, it must append an `AdapterRunReceipt`; core then requires
`ChannelStateProof` before local lifecycle state advances.
