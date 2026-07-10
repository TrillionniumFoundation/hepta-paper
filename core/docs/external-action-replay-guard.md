# External Action Replay Guard

`src/external-action-replay-guard.mjs` checks a new handoff candidate against a
redacted `ExternalActionAuditArchive` before the candidate is sent to an
external runner.

The guard prevents archive records from becoming implicit execution permission:

- exact `bundleHash` replay is always blocked
- exact `ledgerHash` replay is always blocked
- same task/action already archived is blocked by default
- dispatch archive matches preserve dispatch envelope and replay guard hashes in
  `matchedEntries`, so replay analysis can distinguish replay-guarded dispatch
  records from standard inbox records
- same task/action can only continue when the caller supplies an explicit,
  hash-intact, unexpired `ApprovalPacket` for the same task/action identity
- blocked, missing, or tampered archives block the guard; archive tamper checks
  recompute with `computeExternalActionAuditArchiveHash`, the same helper used
  by `ExternalActionAuditArchive`

## Output

`buildExternalActionReplayGuardDecision({ archive, candidate })` returns an
`ExternalActionReplayGuardDecision` with:

- `status`: `clear_for_new_handoff` or `blocked_replay_guard`
- `candidate`: redacted task/action/hash identity
- `matchedEntries`: archive rows that matched the candidate
- `blockers`: exact hash replay, same task/action replay, bad archive, or
  missing candidate identity
- `replayGuardHash`: deterministic hash of the guard decision

Candidates can be `ChannelActionManifest`, `AdapterHandoffOutboxItem`,
`ExternalActionLedgerEntry`, `ExternalActionAuditBundle`, or a plain redacted
candidate object with task/action/hash fields. Dispatch candidates bind the
handoff `outboxHash`. When the candidate is a full
`AdapterHandoffOutboxItem`, the guard requires both `outboxHash` and generic
`hash`, verifies they match, and recomputes the outbox body with
`computeAdapterHandoffOutboxHash` before treating it as a replay identity.
Structured outbox candidates also preserve the customer-message source-copy
binding: payload, runner required hashes, manifest snapshot, preview payload,
and preview adapter required hashes must all carry the same `messagePreviewHash`;
human-feedback customer-facing outboxes must preserve the same five-source
`humanFeedbackRevisionContractHash` binding for `customer_message`,
`live_submit` / EPWK `workModifyLive`, and `acceptance_apply`. Plain redacted
candidates may omit `outboxHash` when task/action and message scope are
otherwise bound. Customer-message candidates also bind `messagePreviewHash`, and
human-feedback customer-facing candidates bind
`humanFeedbackRevisionContractHash`.
Prompt-generation spend candidates preserve the redacted
`promptGenerationBinding`, so a clear replay guard for one
generation job cannot be reused for another prompt/reference chain. Candidate
objects for provider/model spend that omit that binding are blocked; full
`AdapterHandoffOutboxItem` candidates must preserve the same binding across
payload, runner required hashes, and manifest/preview snapshots even when
`outboxHash` has been recomputed. Incomplete provider/model spend bindings are
also blocked; the guard requires the design retrieval, compiler, readiness,
prompt-production contract, generation job, and generation prompt-production
contract fields before it can return `clear`. Candidate and archive rows
preserve canonical package/review role identity too, so
role-only feedback candidates follow the same replay and contract-binding rules
as product/workflow feedback candidates.

Dispatch replay-guard archive fixtures also feed verified dispatch replay
bundles back through this guard. They prove that archived dispatch records block
same task/action reuse and exact bundle/ledger replay, while explicit repeat
approval can clear only the same task/action case. Thin repeat approval objects
that only claim `ok: true` and an `approvalHash` are blocked because the guard
cannot recompute their approval body, scope, or expiry. Customer-message repeat
approvals must include the same message preview text that hashes to the
candidate `messagePreviewHash`; human-feedback customer-facing approvals
must also carry the same feedback contract hash through the approval
plan/package/review digest. A replay guard `clear` for one outbox cannot be
reused for another same-identity outbox with different customer-visible text or
contract binding.
The preview-text hash is computed with
`computeCustomerMessagePreviewHash(messagePreview)` from `src/contracts.mjs`.

## Boundary

The replay guard is not an execution gate and not an approval. A `clear` result
only says the archive did not show a replay conflict. Real provider/model spend,
prepare, submit, customer message, acceptance, payment, and deployment still
require the normal approval/evidence gate and a real channel runner outside
core.

The module never runs adapters, uploads, submits, sends messages, accepts
delivery, pays, deploys, fetches channel state, applies lifecycle state, or
grants execution permission.
