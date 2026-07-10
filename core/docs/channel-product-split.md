# Channel / Product Split

This is the first local cut of the shared workflow system.

## Business Lines

Business lines are channel adapters. They must not own creative production logic.

| Channel | Owner | Current state | Must own | Must not own |
| --- | --- | --- | --- | --- |
| ZBJ | `zbj-auto-intake` | Mature production + submit pipeline | hall discovery, task sync, seller-side duplicate preflight, live rules, prepare-only upload evidence, submit, IM, acceptance | product-specific generation rules that EPWK/Hepta also need |
| EPWK | `epwk-auto-intake` | Read-only radar/probe prototype | public radar, detail/attachment fetch, account/shop gates, manuscript schema, workback duplicate ledger, EPWK prepare/submit adapter | a copied ZBJ generation/review stack |
| Hepta site | Hepta app/workspace | Future buyer-facing product | order intake, payment/account, upload UX, preview UX, delivery UX, customer support state | hidden platform-task assumptions or marketplace-specific submit rules |

## Product Lines

Product lines are reusable production workflows.

| Product line | Existing source | Reuse target |
| --- | --- | --- |
| `logo_brand` | ZBJ workflow + logo/VI rules | ZBJ, EPWK, Hepta brand orders |
| `packaging_design` | ZBJ packaging workflow | ZBJ, EPWK |
| `proposal_board` | ZBJ proposal/PDF board workflow | ZBJ, EPWK |
| `presentation_deck` | ZBJ PPT/PDF flow | ZBJ, EPWK, Hepta custom orders |
| `catalog_brochure` | ZBJ booklet flow | ZBJ, EPWK, Hepta custom orders |
| `naming_text` | ZBJ text-form branch | ZBJ, EPWK |
| `vectorization` | HeptaVectorizer | Hepta first, optional marketplace upsell later |
| `human_feedback` | ZBJ/EPWK post-submit, shortlist, post-win feedback loops | ZBJ, EPWK, Hepta, manual handoff |
| `acceptance_delivery` | ZBJ final acceptance/delivery | ZBJ now, Hepta delivery package later |

## Canonical IDs

Product-line and external-action aliases must normalize through the shared
helpers in `src/contracts.mjs`. `canonicalProductLineId(value)` and
`canonicalExternalAction(value)` preserve unknown non-empty IDs, while
`canonicalProductLineIdOrNull(value)` and `canonicalExternalActionOrNull(value)`
are the public null-returning variants for optional contract fields and hash
payloads. The null-returning action helper maps the explicit `none` action to
`null`; callers that need a concrete fallback action should use
`canonicalExternalAction(value)` instead.

Human feedback aliases such as `human-feedback`, `consumer_feedback`,
`buyer-feedback`, and `post-submission-revision` normalize to
`human_feedback`. Customer-message aliases such as
`human-feedback-message`, `consumer-feedback-message`,
`buyer-feedback-message`, `im_send`, and `message` normalize to
`customer_message`. Receipt, proof, ledger, audit, replay, dispatch, SDK,
approval/evidence, read-only sample, and post-action matrix builders reuse the
same helpers so alias inputs do not fork public hashes or report summaries.
`validateWorkflowChain()` also compares brief and plan product lines after this
canonicalization, so legacy intake aliases cannot produce a false
`product_line_mismatch`.

## Core Rule

Channels may call product lines. Product lines may not call channels directly.

The crossing point is:

```text
ChannelTask -> CreativeBrief -> ProductionPlanEnvelope -> ArtifactPackage -> ReviewReport -> ChannelSubmission
```

The first shared decision before `CreativeBrief` is product-line routing:

```text
ChannelTask + channel detail + agent semantic route -> routeProductLine -> productLineId/outputMode
```

Routing must use explicit workflow metadata or an agent/LLM semantic route
contract. Title/category/requirement text remains evidence for semantic intake,
but core does not use regular expressions or keyword rules to choose product
lines. This is especially important on EPWK-style public brief pages where a
LOGO task may mention packaging, exhibition, and e-commerce as application
scenarios.

The second shared decision is the product workflow profile:

```text
productLineId -> workflowProfile -> default output, gates, quality rules, supported channels
```

The workflow profile is product-owned, not channel-owned. ZBJ, EPWK, and Hepta
may each add platform limits around it, but they should not fork the creative
rules for logo, packaging, PDF decks, vectorization, human feedback, or delivery.

The plan-only adapter is the first executable boundary inside core:

```text
ChannelTask + channel detail + platform limits
  -> PlanOnlyDraft
  -> routeDecision + workflowProfile + CreativeBrief + ProductionPlanEnvelope
```

`PlanOnlyDraft` is still read-only. It may produce blockers and warnings, but it
must not call provider/model spend, live prepare, upload, submit, acceptance,
customer messaging, deployment, payment, or account/profile actions.
For `human_feedback`, plan-only readiness additionally requires a valid
`HumanFeedbackRevisionContract` with refreshed source history, target
artifact binding, baseline invariants, one active atomic change, and unchanged
regression checks. The source snapshot/source refs must be canonical
`sha256:<64 hex>` hash-bound, baseline invariant hashes must use the same
canonical digest format, the baseline must be
explicitly locked, file-hash target bindings must use canonical sha256 digests,
and the active atomic correction must point back to one of the refreshed source
refs. Customer-facing message/submit paths require a
human-feedback review bound to the active change, target artifact, and
canonical feedback contract hash. The contract must also bind to the current
task/channel/external ID. External execution requires a separate `ReviewReport`
with canonical sha256 reviewed artifacts; a self-contained `reviewGate` inside the
contract is not enough to authorize customer-facing handoff. The reviewed
artifact hashes must match the current package being messaged or submitted, so
a stale review cannot be reused after a regenerated preview. Approval and fresh
evidence packets must also validate their own packet hashes and carry the same
feedback contract hash in all three plan/package/review digests. The source
helper for the canonical contract digest is
`computeHumanFeedbackRevisionContractHash(contract)` from `src/contracts.mjs`;
it canonicalizes human-feedback product/workflow aliases and customer-message
exit-action aliases before hashing, so direct legacy contract descriptors do not
fork the reviewed contract identity.
The human-feedback workflow detector is explicit-alias only: product-line
aliases route through `canonicalProductLineId()`, and review/post-submission
workflow names must match enumerated aliases rather than fuzzy regex or keyword
text.
`hashHumanFeedbackRevisionContract()` remains the human-feedback module's
compatibility wrapper around that helper.

The execution gate is the approval/evidence boundary for the first non-read-only
step:

```text
ExternalActionRequest + policy + approval + fresh evidence + current package/review
  -> ExecutionGateDecision
  -> allow | needs_approval | blocked
```

Product workflows may request `provider_spend`, `model_spend`, `live_prepare`,
`live_submit`, `acceptance_apply`, `customer_message`, or `deployment`, but they
do not decide permission. The execution gate owns policy/profile checks,
approval/evidence binding, channel capability, package/review freshness,
prepare evidence, and duplicate preflight requirements.
When the request is a human feedback revision, the execution gate also
validates the feedback contract before any provider/model spend or customer
message handoff can proceed; operator previews and local-only artifacts are
blocked from customer-facing exits unless explicitly represented as approved
customer-facing exceptions.

## First Migration Pass

1. Keep ZBJ code as-is and add adapters that can export current ZBJ task/case data into core contracts.
2. Keep EPWK read-only, but make its radar/detail result emit `ChannelTask`.
3. Make both ZBJ and EPWK production planning call the same product-line selection and reference-pack routing.
4. Attach `workflowProfile` from the shared registry before planning artifacts.
5. Use the plan-only adapter as the first shared planning entry point for ZBJ/EPWK/Hepta.
6. Add migration shims for ZBJ job/case payloads, EPWK records, and Hepta orders so current systems can call the same read-only planning contract without moving execution.
7. Add execution gates so every external action uses the same policy, approval, evidence, package/review, prepare, and duplicate checks.
8. Only after contracts stabilize, extract product workflows from ZBJ into the shared core.
9. Hepta site should consume the shared product-line API directly, with its own order/delivery adapter.

## Safety Gates

External actions stay channel-owned and approval-gated:

- provider/model spend
- live prepare/upload
- live submit
- acceptance/settlement
- buyer/customer messages
- payments, membership, deposits, shop/profile/account changes
- Hepta deployment or public customer communication

The core may describe an external action, but it must not execute one.
