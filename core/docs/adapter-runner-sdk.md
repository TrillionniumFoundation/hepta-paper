# Adapter Runner SDK Contract

`src/adapter-runner-sdk.mjs` turns a ready
`AdapterDispatchReadinessReport` into an `AdapterRunnerSdkContract` for an
external channel runner implementer.

It standardizes the runner interface as five phases:

- `inspect`
- `prepare`
- `execute`
- `receipt`
- `stateProof`

## What It Solves

The earlier core layers can prove that a manifest, outbox, replay guard,
runner selection, dispatch envelope, assignment, and readiness report bind
together. They do not tell a real runner exactly what to implement next.

The SDK contract fills that gap. It gives the external runner a stable phase
checklist, required hashes, required rechecks, expected output kinds, and
acceptance criteria. Each phase also exposes `requiredEvidenceKinds` so runner
implementers can wire platform snapshots, dry-run replay, receipts, and channel
state proof without treating readiness as execution permission. The contract
also exposes an action-specific evidence checklist for receipt result fields and
read-only state proof fields.

## Required Hashes

A ready SDK contract requires the readiness report to expose:

- `outboxHash`
- `replayGuardHash`
- `manifestHash`
- `previewHash`
- `approvalHash`
- `evidenceHash`
- `messagePreviewHash` for customer-message handoffs
- `humanFeedbackRevisionContractHash` for human-feedback customer-facing
  handoffs
- `promptGenerationBinding` for prompt-generation provider/model spend handoffs

It also binds the readiness report hash, dispatch envelope hash, and assignment
hash. Missing hashes block the SDK contract, because a runner would not be able
to prove what it inspected or executed against.

The SDK builder recomputes the readiness report body with
`computeAdapterDispatchReadinessReportHash()` before accepting `reportHash`.
Changing the readiness handoff, runner identity, hash binding, checks, or safety
claims without rebuilding the report now blocks SDK generation with
`dispatch_readiness_report_hash_content_mismatch`.

`computeAdapterRunnerSdkContractHash(contract)` is the source helper for the SDK
contract digest. Its hash input canonicalizes customer-message action aliases,
human-feedback product/workflow aliases, and package/review role aliases in
the handoff, phase rows, action-evidence contract, and manifest/preview
snapshots before digesting.
External runners and local reports should use this helper when they re-check an
SDK contract body instead of copying the digest field list.

The contract also carries `handoffSnapshots.manifest` and
`handoffSnapshots.preview`. Their stored `manifestHash`/`previewHash` must match
the required hashes. The SDK builder recomputes those snapshot content hashes
with `computeChannelActionManifestHash()` and `computeAdapterRunPreviewHash()`
before it can mark the contract ready, and the external runner must recompute
them again before writing an `AdapterRunReceipt`. This prevents a bridge from
handing a runner only copied hashes or from reconstructing a different
manifest/preview object later.

When the handoff is a customer-message preview, the manifest/preview snapshots
and SDK handoff also carry the approved `messagePreview` and
`messagePreviewHash`, including the preview adapter required-hash copy, and the
SDK builder rehashes that preview before it marks the contract ready. The source
helper is
`computeCustomerMessagePreviewHash(messagePreview)` from `src/contracts.mjs`.
A runner must send the snapshot text it inspected and bind its receipt to the
same approval/evidence/message hashes. If the handoff carries a
`messagePreviewHash`, both `AdapterRunReceipt` and `ChannelStateProof` must
return that same hash; a message ID alone does not prove the approved text was
the text that was sent.

For human-feedback customer-facing actions, including role-only handoffs
identified by `packageRole`, `reviewType`, or `role`, the SDK also carries
`humanFeedbackRevisionContractHash` in the handoff, required hashes, and
preview adapter required hashes. This applies to `customer_message`,
`live_submit` / EPWK `workModifyLive`, and `acceptance_apply`; only
`customer_message` additionally carries `messagePreviewHash`. The runner must
propagate the same contract hash into receipt result evidence and channel state
proof, so a submit, acceptance, or sent message is tied to the exact revision
contract rather than only to a generic external action.

For prompt-generation provider/model spend, the SDK carries the redacted
`promptGenerationBinding` through the handoff, required hashes, and phase hash
bindings. The runner must re-check that binding before inspect/prepare/execute
and keep receipts/state proof tied to the same generation job and prompt
production chain instead of only to generic approval/evidence hashes. The
state-proof phase lists `promptGenerationBinding` as required evidence for
provider/model spend. A provider/model spend readiness report that strips every
`promptGenerationBinding` field and recomputes `reportHash` still blocks SDK
generation with `prompt_generation_binding_required`; one that carries an
incomplete binding blocks with `prompt_generation_binding_incomplete`.

## Phase Boundary

The SDK contract may describe phases that an external runner can perform, but
core does not perform them:

- `inspect`: read and recompute the handoff, approval, evidence, replay, and
  channel identity hashes, including manifest/preview handoff snapshots.
- `prepare`: bind a read-only platform state snapshot and dry-run replay, stage
  or upload only when the external action allows it, then stop on any mismatch.
- `execute`: perform a real external action only outside core, with explicit
  current-chat action approval, fresh platform state, dry-run replay, and fresh
  gates.
- `receipt`: record success, failure, cancellation, or terminal blocked result
  as an `AdapterRunReceipt` bound to the snapshot and dry-run replay hashes,
  including the action-specific result id fields.
- `stateProof`: verify the current channel state read-only and bind it to the
  receipt before any local lifecycle transition, including the action-specific
  proof fields.

## Action Evidence

`actionEvidenceContract` names the receipt and state-proof fields expected for
the concrete handoff action, such as `worksId`/`submissionId` for live submit,
`messageId` plus any preview-bound `messagePreviewHash` for customer messages,
`acceptanceId` for acceptance, provider/model run IDs for spend, and
deployment/build/url fields for deployments. It also
requires receipts to bind platform-state snapshot and dry-run replay hashes, and
requires state proof to bind the receipt hash.

The `runtime:post-action-evidence-matrix` report consumes these field lists and
proves all ready adapter routes can produce accepted synthetic receipts plus
verified synthetic state proofs, while missing or tampered fields fail closed.

## Boundary

The SDK contract never executes adapters, uploads, submits, sends messages,
accepts delivery, pays, deploys, fetches channel state, applies lifecycle state,
or grants permission.

A ready contract only says the external runner has enough descriptor material
to implement the five-phase handoff. The runner still must re-check current
approval, fresh evidence, replay guard, duplicate/channel state, and
prompt-generation binding when present, plus current-chat authorization before
doing anything external.

The SDK also refuses a ready report whose runner location points back into
`design-production-core`. Runner implementations must live outside core and
receive the handoff as an external workspace contract.

`runner.runnerLocationExternalWorkspace` is part of the SDK contract so runner
implementers and dashboards can check the same boundary before preparing or
executing any external phase.
