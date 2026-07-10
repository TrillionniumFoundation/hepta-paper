# Execution Gates

`src/execution-gates.mjs` is the shared approval/evidence contract for external
actions.

It does not execute anything. It only evaluates whether a requested external
action may advance to the owning channel/tool layer.

## Actions

The gate covers the core external actions already defined in `contracts.mjs`:

- `provider_spend`
- `model_spend`
- `live_prepare`
- `live_submit`
- `acceptance_apply`
- `customer_message`
- `deployment`

Customer-message intake aliases such as `human-feedback-message`,
`consumer-feedback-message`, `buyer-feedback-message`, `im_send`, and `message`
are canonicalized to `customer_message` before policy, approval, evidence, and
human-feedback contract checks run. They must not create separate weaker
execution paths. Explicit feedback aliases (`human-feedback-message`,
`consumer-feedback-message`, and `buyer-feedback-message`) also preserve a
human-feedback intent signal after canonicalization, so a caller cannot omit
product/workflow metadata and get a generic customer-message gate.

## Policies

Policy profiles are intentionally small:

- `safe-plan`: planning only; blocks all external actions
- `spend-allowed`: provider/model spend only
- `prepare-allowed`: live prepare/upload evidence only
- `submit-allowed`: live submit or customer message only
- `acceptance-allowed`: acceptance apply only
- `deployment-allowed`: deployment only

This keeps product workflows from deciding external permissions. A product line
may request an action, but the gate decides whether the current policy,
approval, evidence, channel capability, package, and review state allow it.

## Required Inputs

Every external action requires:

- a matching formal `ApprovalPacket` with explicit `ok: true`
- legacy/non-formal approval objects are rejected even when they carry
  `approvalHash`, `ok: true`, and exact task/channel/external scope
- the approval identity must come from `approvalHash`; a generic `hash` alone is
  treated as stripped identity even for legacy/non-formal approval objects
- non-expired formal packets must preserve both `approvalHash` and generic
  `hash`, and those two hashes must match.
- formal approved `ApprovalPacket` inputs must carry hash-bound current-chat
  approval provenance: source/chat id, source message id, requester identity,
  captured timestamp, intent nonce, approval nonce, explicit approval text hash,
  and exact task/channel/action scope. Stripping the provenance and recomputing
  the packet hash still fails closed.
- a non-expired formal `FreshEvidenceBundle` with explicit `ok: true`
- legacy/non-formal evidence objects are rejected even when they carry
  `evidenceHash`, matching `approvalHash`, `ok: true`, and exact scope
- the evidence identity must come from `evidenceHash`; a generic `hash` alone is
  treated as stripped identity even for legacy/non-formal evidence objects
- formal evidence bundles must preserve both `evidenceHash` and generic `hash`,
  and those two hashes must match
- evidence must explicitly carry the same approval hash as the approval packet;
  a recomputed evidence hash without `approvalHash` fails closed
- formal fresh evidence must carry the same approval provenance digest as the
  approval packet; a recomputed evidence hash with swapped chat/message/nonce
  provenance fails closed
- matching task, channel, and external identity across request, approval, and
  evidence. When the request has `taskKey`, `channelId`, or `externalId`, both
  approval and evidence must carry the same field; missing scope fields fail
  closed instead of being treated as generic approvals.
- a policy that explicitly allows the action
- channel capability support
- a valid evaluation timestamp; malformed request times fail closed instead of
  disabling approval/evidence expiry checks

Action-specific checks add stricter requirements:

- `live_prepare`: current submit-ready artifact package and PASS review
- `live_submit`: current prepare evidence and seller-side duplicate preflight
- `acceptance_apply`: delivery artifact binding
- `customer_message`: explicit message preview; allowed decisions also carry
  `messagePreviewHash` so manifests, receipts, and state proofs can bind the
  exact approved text. The source helper is
  `computeCustomerMessagePreviewHash(messagePreview)` from `src/contracts.mjs`
- human-feedback `customer_message`: current package/review artifact hashes
  must match the artifact digests captured in both approval and fresh evidence;
  current `messagePreview` must also match the approval/evidence snapshots, so
  stale approval/evidence cannot be reused after the outgoing package or
  customer-facing text changes. Formal approval/evidence objects must also carry
  top-level task, channel, and external identity matching the current request,
  so a scope-stripped packet cannot be reused for a human-feedback handoff.
  Feedback identity found only in the supplied `ApprovalPacket` /
  `FreshEvidenceBundle` also triggers the full
  human-feedback contract gate, so packet-only calls cannot fall back to a
  generic customer-message path. That identity check includes top-level
  `productLineId`, `workflowId`, `packageRole`, `reviewType`, and `role`;
  raw role aliases such as `human-feedback-review` and
  `human-feedback-referee` are canonicalized before the gate decides whether
  `humanFeedbackRevisionContractHash` is required.
- `deployment`: deployment target and build evidence
- `provider_spend` / `model_spend`: approval budget must cover estimated spend,
  and the current plan must carry a complete prompt-generation chain. The gate
  requires `DesignReferenceRetrieval`, prompt compiler, prompt readiness,
  prompt production contract, and a valid executable `GenerationJob` embedded in
  the approved plan, not only supplied as an out-of-band request field. Formal
  approval/evidence plan digests must match the current design retrieval,
  prompt compiler, prompt readiness, prompt production contract, generation job
  id, and generation prompt-production hashes. The generation job must also
  match those current plan hashes. A stale approval packet, unbound generation
  job, or spend request with no prompt chain cannot authorize provider/model
  spend.

## Output

`evaluateExecutionGate()` returns an `ExecutionGateDecision`:

- `allow`: the next layer may execute the external action
- `needs_approval`: only approval/evidence is missing
- `blocked`: policy, channel capability, stale package/review, duplicate,
  missing prepare evidence, ungranted approval, or other hard state prevents
  execution

The decision includes blocker codes, warning codes, approval/evidence hashes,
artifact names, and a safety summary.
Gate summaries bucket `byAction` after the same customer-message action
canonicalization, so direct alias decisions such as `consumer-feedback-message`
or `buyer-feedback-message` are reported under `customer_message`.

## Boundaries

Allowed:

- evaluate policies
- compare approval/evidence hashes
- compare review/package artifact names, hashes, and sizes
- detect missing prepare evidence or duplicate preflight
- summarize gate decisions for dashboards

Not allowed:

- call providers or models
- fetch live pages
- upload files
- submit manuscripts
- apply for acceptance
- send buyer/customer messages
- deploy Hepta
- mutate channel state

## Regression

Fixtures live in `fixtures/execution-gate-fixtures.json` and run through:

```bash
npm run selftest
```
