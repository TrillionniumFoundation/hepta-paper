# External Action Audit Bundle

`src/external-action-audit-bundle.mjs` packages a verified
`ExternalActionLedgerEntry` into a redacted audit bundle that the control plane,
dashboards, or external runner records can archive.

The bundle is the final read-only record shape for an external action handoff.
It is deliberately stricter than the raw ledger:

- the source ledger must be `verified_action_ledger`
- the ledger hash must match its current content, recomputed with the same
  `computeExternalActionLedgerHash` implementation used by
  `ExternalActionLedgerEntry`
- manifest, preview, receipt, proof, and transition hashes are required
- platform-state snapshot and dry-run replay hashes from the verified ledger are
  also required in `hashBinding`; deleting either and recomputing the ledger
  hash leaves the audit bundle blocked, so a stale proof bundle cannot stand in
  for fresh platform/replay evidence
- by default the full inbox chain is required:
  `AdapterReceiptInboxItem -> ChannelStateProofInboxItem -> ReceiptStateTransitionInboxItem`
- dispatch-path ledgers additionally preserve the dispatch envelope, outbox,
  replay guard, archive, optional prior ledger, and dispatch inbox hashes
- prompt-generation provider/model spend ledgers preserve the same
  `promptGenerationBinding` in ledger payload and chain; a bundle blocks if the
  payload or chain side drops, truncates, or changes it. If a verified
  provider/model spend ledger strips both sides and recomputes `ledgerHash`, the
  bundle still blocks with prompt-generation binding required blockers; if the
  binding remains present but incomplete, the bundle blocks with incomplete
  binding blockers
- the post-action audit bundle matrix carries explicit source-copy probes for
  customer-message `messagePreviewHash`, human-feedback
  `humanFeedbackRevisionContractHash`, and provider/model
  `promptGenerationBinding`: each probe deletes either the ledger `payload` copy
  or the ledger `chain` copy, recomputes `ledgerHash`, and requires the audit
  bundle to stay blocked
- missing or tampered inbox hashes block the bundle
- replay-index identity is mandatory: verified ledger entries must keep
  `channelId`, `actionId`, canonical `action`, `payload.taskKey`, and
  `payload.externalId`; a recomputed ledger hash with missing identity is still
  blocked before it can become an audit bundle

## Output

`buildExternalActionAuditBundle({ ledgerEntry })` returns an
`ExternalActionAuditBundle` with:

- `status`: `verified_action_audit_bundle` or `blocked_action_audit_bundle`
- `hashBinding`: ledger and chain hashes
- `hashBinding.platformStateSnapshotHash` and `hashBinding.dryRunReplayHash`:
  freshness anchors that must remain bound to the verified ledger
- every `customer_message` bundle must preserve the same
  `payload.messagePreviewHash` and `hashBinding.messagePreviewHash`
- human-feedback customer-facing bundles additionally preserve the same
  `payload.humanFeedbackRevisionContractHash` and
  `hashBinding.humanFeedbackRevisionContractHash` for `customer_message`,
  `live_submit` / EPWK `workModifyLive`, and `acceptance_apply`
- prompt-generation bundles preserve the same
  `payload.promptGenerationBinding` and `hashBinding.promptGenerationBinding`
  whenever the action is provider/model spend, even if a forged upstream ledger
  removed both binding copies before recomputing its hash
- package/review role aliases such as `human-feedback-review` also classify
  customer-facing feedback ledgers as human feedback, so a role-only handoff
  cannot become a verified bundle without the feedback contract hash
- `lineage`: redacted ordered chain from manifest through final ledger
- `blockers`: missing hash, stale/tampered ledger, unverified ledger, or
  customer-message payload/hashBinding drift issues
- `bundleHash`: deterministic hash of the redacted audit bundle, computed by
  `computeExternalActionAuditBundleHash`

The bundle contains artifact names and task identity, but it does not include raw
platform payloads, credentials, browser state, or unredacted command execution.
For dispatch-path ledgers, lineage includes the replay-guarded dispatch handoff
without making the bundle an execution permission.

Dispatch replay-guard bundle fixtures specifically require the replay guard hash
and the dispatch receipt/proof/transition inbox hashes. A blocked replay ledger
or a ledger with missing dispatch replay guard evidence cannot become a verified
audit bundle.
Archive-loop bundle fixtures apply the same rule to ledgers produced after a
dispatch replay archive has been checked again.

## Boundary

The audit bundle never executes adapters, uploads, submits, sends customer
messages, accepts delivery, pays, deploys, fetches channel state, or applies
local lifecycle state. It only records that an already verified ledger has a
complete hash-bound audit chain.

Raw legacy ledgers can still be kept as compatibility evidence, but they do not
become final audit bundles unless `requireInboxChain: false` is deliberately
passed by a caller that only wants a compatibility record.
