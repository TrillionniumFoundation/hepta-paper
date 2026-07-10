# Adapter Receipt

`src/adapter-receipt.mjs` is the local verification contract for results
returned by a channel-owned adapter runner.

It does not execute the runner. It validates and records what the external
runner claims happened after a `ChannelActionManifest` and `AdapterRunPreview`.

## Inputs

An `AdapterRunReceipt` should bind:

- the original `ChannelActionManifest`
- the `AdapterRunPreview`
- manifest hash
- preview hash
- approval hash
- evidence hash
- platform state snapshot hash
- dry-run replay hash
- optional dispatch-envelope, outbox, replay-guard, archive, and ledger hashes
  when the result returns through an `AdapterDispatchEnvelope`
- `promptGenerationBinding` when the manifest/preview came from a
  prompt-generation provider/model spend chain
- external result evidence

External result evidence is redacted and action-specific. Examples:

- ZBJ live submit: `worksId` / `submissionId`
- live prepare: prepare evidence ok plus uploaded artifact names
- acceptance apply: acceptance result ID
- customer message: message ID plus the `messagePreviewHash`, or a raw
  message preview that Core hashes, when the handoff carried an approved
  message preview
- human-feedback customer-facing actions: the matching
  `humanFeedbackRevisionContractHash` for `customer_message`,
  `live_submit` / EPWK `workModifyLive`, and `acceptance_apply`
- Hepta deployment: deployment/build/url evidence
- provider/model spend: provider/model run ID or cache key

The post-action evidence matrix keeps these receipt fields aligned with the SDK
contract and with `ChannelStateProof` by exercising every supported adapter
route with synthetic success and missing-field fixtures.

The checked-in receipt fixtures also mirror the same 20-route action matrix.
Selftest now blocks if accepted success fixtures omit any SDK
`actionEvidenceContract.receiptResultFields` entry or if fixture action IDs drift
from the post-action matrix.

## Receipt Rules

A receipt becomes `accepted_receipt` only when:

- preview kind is `AdapterRunPreview`
- preview status is `dry_run_ready`
- the original manifest and preview preserve both their semantic hash aliases
  (`manifestHash` / `previewHash`) and their generic `hash`, with each alias
  matching the generic hash
- stored manifest and preview hashes match recomputed content hashes from
  `computeChannelActionManifestHash()` and `computeAdapterRunPreviewHash()`
- manifest / preview / approval / evidence hashes match
- all external-action receipts explicitly report approval/evidence hashes from
  the runner; the receipt verifier does not silently substitute the local
  expected values for those action hashes
- customer-message previews are rehashed from the preview payload, and
  `preview.payload.messagePreviewHash`,
  `preview.adapter.requiredHashes.messagePreviewHash`, and manifest
  `messagePreviewHash` must agree before result evidence is considered
- customer-message receipts with a preview-bound handoff report a matching
  `messagePreviewHash` or a raw preview that hashes to that value; a runner
  cannot return only a message ID for a hash-bound customer-facing text
- human-feedback customer-facing receipts, including role-only handoffs
  identified by `packageRole`, `reviewType`, or `role`, require the manifest
  payload, preview payload, and preview adapter `requiredHashes` to carry the
  same `humanFeedbackRevisionContractHash`, and the runner must report that
  matching hash for `customer_message`, `live_submit` / EPWK `workModifyLive`,
  and `acceptance_apply`, so a receipt cannot be reused across a different
  feedback revision contract
- package/review role identity is preserved from the preview into the receipt,
  and role aliases are canonicalized in the receipt hash input so downstream
  ledgers can still detect role-only feedback handoffs
- if a customer-message receipt includes both raw preview text and a
  `messagePreviewHash`, Core recomputes the raw preview hash and blocks the
  receipt when the two disagree. The source helper is
  `computeCustomerMessagePreviewHash(messagePreview)` from `src/contracts.mjs`;
  raw runner result objects use the shared
  `computeCustomerMessagePreviewHashFromFields(value)` field helper
- platform state snapshot and dry-run replay hashes are present
- provider/model spend receipts always carry a complete prompt-generation
  snapshot binding; Core blocks a hash-intact manifest/preview pair that strips
  every `promptGenerationBinding` field with
  `prompt_generation_binding_required`, even when the runner reports a provider
  or model run ID
- prompt-generation receipts preserve the same
  `designReferenceRetrievalHash`, `promptCompilerHash`,
  `promptReadinessHash`, `promptProductionContractHash`, `generationJobId`, and
  generation production-contract hash carried by the manifest and preview; a
  receipt that drops or rewrites that binding is blocked before post-action
  proof
- the result status is known
- successful external actions include the required external evidence

Otherwise it is `blocked_receipt`.

`failed` results must carry a `failureCode`. `blocked` and `cancelled` results
can be recorded, but they do not advance the lifecycle.

## State Suggestion

For successful results, the receipt copies the manifest transition target into
`stateSuggestion`. For blocked or failed results, it suggests no automatic
transition and keeps the task out of execution.

The receipt itself does not apply the transition. The owning control plane must
feed the receipt into the state machine after verifying the current channel
state again.

Receipt inboxes recompute the `AdapterRunReceipt` object hash before accepting
an externally supplied receipt object. A receipt with `accepted=true` and a
copied `receiptHash` is still blocked when its body no longer hashes to that
value.

## Safety

`AdapterRunReceipt.safety.executesExternalAction` is always `false`.

Receipts are audit records and verification inputs. They are not permission to
retry, resubmit, upload, message, accept delivery, pay, or deploy.
