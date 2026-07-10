# External Action Audit Archive

`src/external-action-audit-archive.mjs` groups redacted
`ExternalActionAuditBundle` records into a searchable audit index.

This is useful for dashboards, runner receipts, and control-plane archive files
that need to answer:

- which task/action did this external handoff belong to?
- which ledger hash and bundle hash prove the final record?
- did the archive include duplicate or stale bundle records?
- is every final record backed by an inbox-chain audit bundle?
- did replay-guarded dispatch records preserve their dispatch envelope and
  replay guard hashes?

## Output

`buildExternalActionAuditArchive({ bundles })` returns an
`ExternalActionAuditArchive` with:

- `status`: `ready_external_action_audit_archive` or `blocked_external_action_audit_archive`
- `entries`: redacted bundle/task/action/hash rows
- `summary`: counts by status, channel, action, task, bundle hash, ledger hash,
  customer-message preview-hash bindings, and human-feedback contract
  bindings
- every `customer_message` archive entry preserves payload-sourced
  `messagePreviewHash`; every human-feedback customer-facing entry
  (`customer_message`, `live_submit` / EPWK `workModifyLive`, or
  `acceptance_apply`) additionally preserves payload-sourced
  `humanFeedbackRevisionContractHash`. Hash-binding copies are validation
  inputs only and are not used as archive-entry fallback values when the payload
  source copy is stripped.
- provider/model spend bundles must preserve complete `promptGenerationBinding`
  copies in both payload and hash binding before they can be archived;
  recomputing a bundle hash after stripping either copy leaves the archive
  blocked
- every verified bundle must also preserve `platformStateSnapshotHash` and
  `dryRunReplayHash` in hash binding. Recomputing a bundle hash after stripping
  either freshness anchor leaves the archive blocked, preventing stale platform
  snapshots or dry-run replays from being indexed as final proof
- human-feedback archive classification includes canonical package/review
  roles, so raw role aliases cannot be archived as generic customer messages
- dispatch-path counts and dispatch envelope/outbox/replay/archive hash fields
  when bundles came from dispatch inbox chains
- platform-state snapshot and dry-run replay hash fields for every archived
  entry
- dispatch replay-guard archive coverage for ready repeat-approved bundles,
  blocked replay bundles, and duplicate dispatch bundle/ledger hashes
- replay-index identity is mandatory on every verified bundle before archive:
  `channelId`, `actionId`, canonical `action`, `payload.taskKey`, and
  `payload.externalId` must be present, because replay guard matching depends on
  those redacted entry fields
- `blockers`: duplicate hash, unverified bundle, missing inbox-chain, or tamper issues
- `archiveHash`: deterministic hash of the redacted archive index, computed by
  `computeExternalActionAuditArchiveHash`

By default, every bundle must be verified and must carry a complete inbox chain.
Each bundle's content hash is recomputed with
`computeExternalActionAuditBundleHash`, the same helper used by
`ExternalActionAuditBundle`, before it can be archived. Bundle inputs must
preserve both `bundleHash` and generic `hash`; the archive index records the
semantic `bundleHash` only, so stripping the semantic alias cannot leave a
generic hash as a replay key.
Provider/model spend bundle inputs must also keep prompt-generation payload and
hash-binding copies with all required prompt/reference/readiness/production and
generation-job fields, so archive records cannot silently lose or truncate the
identity that authorized spend.
Blocked bundles and raw legacy ledgers are not promoted into a ready archive.
For dispatch replay-guard bundles, the archive also preserves the dispatch
replay guard hash so later replay checks can distinguish intentional repeat
handoffs from archived dispatch records.
Archive-loop fixtures use the same archive rules after a replay-guard archive
has been checked again.

## Boundary

The archive is not a permission object. It never runs adapters, uploads,
submits, sends customer messages, accepts delivery, pays, deploys, fetches
channel state, applies lifecycle state, or grants execution permission. It is
only a redacted index over already-created audit bundles.
