# Approval Packets

`src/approval-packets.mjs` is the audit layer directly before `execution-gates`.
It creates immutable hashes for "what is being approved" and "what fresh
evidence is attached right now" without performing the external action.

## Contracts

`buildApprovalPacket()` creates an `ApprovalPacket`:

- binds action, policy, task/channel/external identity, product line, workflow,
  budget, package digest, and review digest
- when a plan carries prompt/generation evidence, binds the
  `DesignReferenceRetrieval`, prompt compiler, prompt readiness, prompt
  production contract, generation job id, and generation prompt-production
  hashes into the plan digest; prompt-generation spend approvals must include
  the generation job in the approved plan rather than relying on a later
  execution request to attach it
- binds the authorization outcome fields (`ok`, `status`, `approvedBy`,
  `expiresAt`) into the immutable approval hash, so a pending or blocked packet
  cannot be flipped to `ok: true` while reusing an old `approvalHash`; the
  execution gate also rejects expired approval packets
- binds `approvalProvenance` into the immutable approval hash for approved
  packets. The provenance records current chat/source identity, source message
  id, requester identity, captured timestamp, exact task/channel/action scope,
  intent nonce, approval nonce, and explicit approval text hash.
- for human-feedback customer-facing actions, those package/review artifact
  digests must still match the current outgoing package when the execution gate
  runs
- for human-feedback messages, the customer-facing `messagePreview` is also
  hash-bound in both approval and evidence so stale approval cannot authorize
  edited message text
- canonicalizes customer/consumer/buyer feedback message aliases to
  `customer_message` before hashing the immutable packet body, while preserving
  explicit feedback intent as `productLineId/workflowId=human_feedback` when
  the caller uses a feedback-message alias without plan/package metadata
- canonicalizes direct/prebuilt top-level `packageRole`, `reviewType`, and
  `role` aliases when they are present before computing the immutable packet
  hash, so `human-feedback-review` and `human-feedback-referee` hash like
  their canonical human-feedback roles instead of creating a parallel
  approval identity
- redacts raw source snapshots
- computes a stable `approvalHash`
- uses the shared approval/evidence hash helper consumed by execution gates,
  action manifests, and replay guard checks, so immutable hash payloads do not
  drift between modules
- defaults to `pending_approval`
- only satisfies `execution-gates` when `ok: true`

`buildFreshEvidenceBundle()` creates a `FreshEvidenceBundle`:

- binds the current package/review/prepare/duplicate/message/deployment state
- binds the same prompt/generation plan digest fields as approval packets, so
  fresh evidence drifts when the prompt chain or generation job changes
- binds explicit `ok: true` readiness and `expiresAt` into the immutable
  evidence hash, so stale evidence cannot be refreshed by editing timestamp
  fields while reusing an old `evidenceHash`
- links to the exact `approvalHash`
- carries the same approval provenance digest as the approved packet, so fresh
  evidence cannot silently swap the source chat/message/nonce binding while
  recomputing `evidenceHash`
- uses the same canonical external action as the approval packet
- carries the same task/channel/external identity as the approved request
- is rejected by `execution-gates` if any request-scoped task/channel/external
  identity is missing or differs, even when the approval/evidence hashes were
  recomputed
- canonicalizes direct/prebuilt top-level `packageRole`, `reviewType`, and
  `role` aliases before computing the immutable evidence hash, matching the
  approval packet helper and the downstream execution/manifest detectors
- computes a stable `evidenceHash`
- uses the same shared evidence hash helper as downstream execution and manifest
  validation
- never uploads, submits, sends, spends, accepts, or deploys

`buildApprovedExecutionGateRequest()` combines the packet and evidence bundle
into the request shape expected by `evaluateExecutionGate()`.

For channel runtimes that still use archived, platform-local packet files, the
same module exposes a legacy runtime contract:

- `approvalPacketBodyHash()` and `evidenceBundleBodyHash()` preserve the
  historical raw-hex hash body used by local packet/evidence files while
  ignoring mutable approval state, approved command strings, paths, and runtime
  execution commands
- `approvalPolicyNormalizeAction()` and
  `approvalPolicyNormalizeEvidenceStage()` canonicalize spend, semantic,
  prepare, submit, acceptance, and human-feedback aliases before low-level
  gates compare approval packets with fresh evidence. Live-submit aliases such
  as `live_submit`, `work_modify_live`, and `epwk.workModifyLive` normalize to
  submit and always require a fresh `--evidence-hash`; acceptance aliases such
  as `acceptance_apply` and `epwk.acceptanceApplyLive` normalize to acceptance
  and carry the same evidence-hash requirement
- `approvalPolicyExpectedApprovedCommand()` and
  `approvalPolicyMaterializeApprovedCommand()` keep exact-command approvals
  bound to immutable packet fields and the fresh evidence hash
- `approvalPolicyCustomerMessageApprovalIssues()` and
  `approvalPolicyCustomerMessageEvidenceIssues()` centralize the
  customer-message hard checks for exact command envelopes, required evidence
  hashes, approval/evidence command continuity, execution-command
  materialization, and human-feedback contract hash binding; channel
  adapters may pass their local human-feedback contract validation result
  into the evidence helper without moving file reads or runtime state into core
- `freshEvidenceHandshakeRequested()`,
  `buildFreshEvidenceHandshakePlan()`, and
  `buildFreshEvidenceHandshakeResult()` define the local fresh-evidence
  planning handshake used before guarded execution: they decide whether fresh
  evidence is requested, describe the evidence/invariant commands to run, and
  reduce the two local child results into an evidence hash, blockers, and the
  next guarded-command hint while leaving subprocess execution and evidence file
  writes in the channel adapter

These helpers are local contract checks only. They do not read packet files,
consume approvals, append audit logs, call providers/models, fetch channel
state, or grant execution permission.

## Boundary

Approval packets are not approvals by themselves. A packet with a hash but no
explicit `ok: true` is blocked by `approval_not_granted`.

This matters for all external actions:

- provider/model spend
- live prepare
- live submit
- acceptance apply
- customer message
- deployment

The execution module remains the final decision point. The packet module only
creates deterministic, reviewable inputs for it.

## Regression Coverage

`fixtures/approval-packet-fixtures.json` checks:

- pending approval packets cannot execute
- approved provider spend with fresh evidence can execute
- live submit requires prepare evidence and duplicate preflight
- duplicate existing seller work blocks submit
- stale evidence approval hash blocks execution
