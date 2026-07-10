# External Action Lifecycle Schema

`src/external-action-lifecycle-schema.mjs` is the canonical read-only schema for
external action control-plane order. It does not run adapters, fetch channel
state, upload, submit, message, accept delivery, pay, or deploy.

The schema names the shared phases that used to be spread across separate
receipt, proof, inbox, dispatch, ledger, audit, archive, and replay modules.
Those modules can stay physically separate, but their order now has one public
source of truth.

Channel adapters should normally import the schema through the package root,
which exposes the stable lifecycle facade alongside the receipt/proof/inbox/
dispatch/ledger helper builders.

## Profiles

- `minimal_verified`: plan/reference, approval/evidence, manifest, preview,
  receipt, independent proof, transition, ledger.
- `live_entrypoint_enforced`: live submit/acceptance/message/deploy entrypoint
  audit profile. It requires plan/reference, approval/evidence, manifest,
  receipt, independent proof, and ledger, with preview/outbox/replay/transition
  recommended but not enough by themselves.
- `standard_inbox_verified`: minimal chain plus handoff outbox, receipt/proof
  inboxes, transition inbox, audit bundle, and audit archive.
- `dispatch_guarded_verified`: standard dispatch handoff with replay guard,
  dispatch envelope, assignment, runner SDK contract, dispatch inboxes, ledger,
  bundle, archive, and replay-cycle invariant.
- `dispatch_inbox_verified`: dispatch-envelope plus dispatch receipt/proof/
  transition inbox chain, ledger, bundle, and archive. Assignment, runner SDK,
  and replay-cycle invariant remain recommended for the stricter dispatch
  guarded profile.

## Usage

```js
import {
  buildExternalActionLifecycleSchema,
  validateExternalActionLifecycleChain,
} from 'design-production-core';

const schema = buildExternalActionLifecycleSchema();
const validation = validateExternalActionLifecycleChain({
  schema,
  profileId: 'dispatch_guarded_verified',
  phases: [
    'plan_reference_binding',
    'approval_evidence_gate',
    'ChannelActionManifest',
    'AdapterRunPreview',
    'AdapterHandoffOutboxItem',
    'ExternalActionReplayGuardDecision',
    'AdapterDispatchEnvelope',
    'AdapterDispatchAssignment',
    'AdapterRunnerSdkContract',
    'AdapterRunReceipt',
    'AdapterDispatchReceiptInboxItem',
    'ChannelStateProof',
    'AdapterDispatchChannelStateProofInboxItem',
    'ReceiptStateTransition',
    'AdapterDispatchReceiptStateTransitionInboxItem',
    'ExternalActionLedgerEntry',
    'ExternalActionAuditBundle',
    'ExternalActionAuditArchive',
    'DispatchReplayCycleInvariantReport',
  ],
});
```

`validation.ok` only means the supplied local chain names satisfy the schema
order and required-phase coverage. It is not permission to perform the external
action, and it does not mean the underlying receipt/proof/ledger statuses are
verified. Channel runners must still re-check fresh approval, current evidence,
platform state, duplicate gates, receipt/proof/ledger blockers, and current-chat
authorization.

When callers pass concrete lifecycle node objects through `nodes` and set
`requiredHashBindings`, validation also checks that every supplied phase whose
schema node consumes or produces the named binding carries the same hash value.
For example, customer-message chain validation can require
`messagePreviewHash`, and human-feedback customer-facing validation can
require `humanFeedbackRevisionContractHash` for `customer_message`,
`live_submit` / EPWK `workModifyLive`, and `acceptance_apply`. The concrete node
detector uses the same canonical action/product aliases as the execution gate,
so `human-feedback-message`, `consumer-feedback-message`,
`buyer-feedback-message`, `im_send`, `consumer_feedback`, and package/review
role aliases such as `human-feedback-review` trigger the same binding
requirements as canonical `customer_message` / `human_feedback`.
Missing values block with `lifecycle_hash_binding_missing`; cross-phase drift
blocks with `lifecycle_hash_binding_mismatch`.

The dispatch guarded path also names the SDK evidence hashes explicitly:
`AdapterRunnerSdkContract` produces the platform-state snapshot and dry-run
replay hash requirements, and `AdapterRunReceipt` must consume those hashes
before any receipt/proof/ledger chain can be considered locally complete.
Customer-message paths also carry `messagePreviewHash`, while human-feedback
customer-facing paths carry `humanFeedbackRevisionContractHash` from approval
and manifest through preview, handoff, SDK, receipt, proof, receipt-state
transition, inbox, ledger, bundle, archive, and replay-cycle schema nodes.
