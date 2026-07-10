# Action Manifest

`src/action-manifest.mjs` is the final local descriptor before a channel-owned
adapter is allowed to run.

It combines:

- an allowed `ExecutionGateDecision`
- an allowed `StateTransitionResult`
- the normalized channel task, plan, package, and review metadata

The output is a `ChannelActionManifest`. It is still local and descriptive:
it does not call providers, models, browsers, uploads, submits, customer
messages, acceptance, payments, or deployments.

## Adapter Action IDs

Current descriptor IDs:

- `zbj.pitchPrepareOnly`
- `zbj.pitchSubmitLive`
- `zbj.acceptanceApplyLive`
- `zbj.customerMessagePreview`
- `epwk.prepareOnly`
- `epwk.submitLive`
- `epwk.acceptanceApplyLive`
- `epwk.customerMessageLive`
- `hepta.customerMessagePreview`
- `hepta.deliveryDeploy`
- guarded provider/model spend descriptors per channel

Unsupported combinations stay blocked. EPWK `live_submit` now resolves to
`epwk.submitLive`, but it is still only a manifest/outbox handoff: the
channel-owned runner must re-check approval, fresh evidence, account/shop gates,
duplicate preflight, and receipt/proof hashes before any external action.

## Manifest Rules

A manifest becomes `ready_for_adapter` only when:

- the channel/action pair has a known adapter action ID
- the execution gate is `allow`
- the state transition is `allow`
- approval and evidence hashes are present
- task/channel/external identity is present, including the case where a
  human-feedback manifest is built from plan/package/review records without a
  separate `channelTask` object. For any external action, the allowed gate
  snapshot must carry the same task/channel/external scope as the manifest.
- action names match across gate, state transition, and manifest after
  customer-message action aliases such as `consumer-feedback-message` and
  `buyer-feedback-message` are canonicalized
- gate hashes are present in both the execution gate and the state transition's
  gate snapshot, and those hashes match any supplied approval/evidence packet
  objects. A transition result that drops task identity or strips approval /
  evidence hash bindings cannot produce a ready manifest.
- supplied `ApprovalPacket` / `FreshEvidenceBundle` objects and legacy
  approval/evidence-like objects must expose identity through semantic hash
  aliases (`approvalHash` / `evidenceHash`). Formal objects must also preserve
  the matching generic `hash`. A body with only a generic `hash` is treated as
  stripped identity, not as an approval/evidence source.
- human-feedback customer-facing manifests carry concrete `ApprovalPacket` and
  `FreshEvidenceBundle` objects whose own approval/evidence hash is present and
  matches the allowed gate hash, and the manifest builder rehashes those object
  contents before trusting them. Those objects must also carry top-level
  task/channel/external identity matching the manifest scope; copied hash
  strings, kind-only shell objects, scope-stripped objects, or mutated objects
  carrying an old hash stay blocked. A supplied packet or bundle whose
  metadata/digests indicate human feedback is enough to trigger this stricter
  manifest path even when plan/package metadata is not present in the manifest
  builder call. That includes direct/prebuilt top-level `packageRole`,
  `reviewType`, or `role` aliases such as `human-feedback-review` and
  `human-feedback-referee`; those aliases trigger the human-feedback
  contract requirement and cannot produce a ready manifest without a bound
  `humanFeedbackRevisionContractHash`. The contract-bound customer-facing
  action set includes `customer_message`, `live_submit` / EPWK
  `workModifyLive`, and `acceptance_apply`; explicit feedback-message action
  aliases still canonicalize to `customer_message`.
- every `customer_message` manifest carries the current customer-facing
  `messagePreview` and `messagePreviewHash` from the execution gate. Approval
  and evidence snapshots must match when supplied, but they cannot substitute
  for the gate preview; the manifest also rehashes the gate text and rejects a
  stale or tampered `messagePreviewHash`. Missing or mismatched message
  snapshots block the manifest so the external runner receives the same text
  that approval/evidence covered. The source helper for this content hash is
  `computeCustomerMessagePreviewHash(messagePreview)` from `src/contracts.mjs`.
- human-feedback customer-facing manifests carry exactly one
  `humanFeedbackRevisionContractHash` across gate, plan/package/review,
  approval packet, and evidence bundle. Missing or drifting contract hashes block
  the manifest before any adapter handoff.
- provider/model spend manifests include a redacted `promptGenerationBinding`
  object with
  `DesignReferenceRetrieval`, prompt compiler, readiness, prompt production
  contract, generation job id, and generation prompt-production hashes. The
  binding must match across the current plan, approval packet, and fresh
  evidence bundle when those formal objects are supplied; missing or drifting
  fields block the manifest. A provider/model spend approval or evidence plan
  copy that omits the entire binding is treated as a source-binding failure; a
  complete plan binding cannot mask an absent approval/evidence copy.

Otherwise it is `blocked_manifest`.

## Safety

`ChannelActionManifest.safety.executesExternalAction` is always `false`.
Adapter runners must require an explicit execute flag and must verify the
manifest hashes before doing any external action.

The manifest only carries redacted payload data plus customer-facing text that is
already approved for a customer-message handoff: task key, product line,
workflow, artifact names, approval hash, evidence hash, optional
`messagePreview` / `messagePreviewHash`, optional
`humanFeedbackRevisionContractHash`, optional `promptGenerationBinding`, and
stage transition summary.

Every manifest also carries `manifestHash`, a deterministic hash over the
redacted handoff payload. The source helper is
`computeChannelActionManifestHash(manifest)` from `src/action-manifest.mjs`; it
canonicalizes customer-message action aliases plus human-feedback
product/workflow/package-role aliases before hashing, so a hand-built
`consumer-feedback-message` / `consumer_feedback` descriptor hashes to the same
identity as the canonical `customer_message` / `human_feedback` manifest.
Feedback-message `adapter.hints.actionVariant` values are also normalized to
`human_feedback_message` before output and hashing, while non-feedback
adapter variants such as `work_modify_live` remain distinct.
Manifest summaries use the same canonical action ID for `byAction` buckets, so
direct alias descriptors do not publish separate human-feedback action rows.
Adapter previews and receipts must bind that helper hash before any
channel-owned runner can be trusted.
