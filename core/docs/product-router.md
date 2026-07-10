# Product Router

`src/product-router.mjs` is the shared product-line decision point for ZBJ,
EPWK, Hepta, and manual intake.

It returns:

- `productLineId`
- `outputMode`
- `confidence`
- `source`
- `matchedRule`
- `routeAuthority`
- `routeDecisionHash`
- `reasons`
- `warnings`

For semantic route contracts, `routeDecisionHash` is taken only from semantic
hash aliases (`routeDecisionHash`, `routeContractHash`, or
`semanticContractHash`). A generic `hash` field is not accepted as the route
decision hash.

## Priority

1. Explicit structured `productLineId`, `kind`, or enumerated/canonicalized `workflowId`.
2. Agent/LLM semantic route contract fields such as `semanticRoute`, `agentRoute`, `modelRoute`, `routeContract`, or `semanticContract`.
3. Fail-closed `generic_design` when neither structured metadata nor agent semantic route evidence exists.

The router does not inspect title/category/requirement text with regular
expressions or keyword rules. Long public briefs often mention several
application scenarios that are not the requested deliverable. For example, an
EPWK LOGO contest may say the final logo should work on packaging, exhibitions,
e-commerce, and promotional material. That must be resolved by semantic intake
or explicit structured metadata, not by text-pattern priority.

When plain text is provided without a structured or semantic route decision, the
router returns `generic_design` with `confidence=0` and warnings:

- `regex_text_routing_disabled`
- `keyword_text_routing_disabled`
- `agent_semantic_product_line_required`

## Current Regression Fixtures

`fixtures/product-router-fixtures.json` covers:

- EPWK LOGO task with packaging application text plus agent semantic route.
- EPWK packaging task plus agent semantic route.
- EPWK brochure/folding leaflet task plus agent semantic route.
- ZBJ explicit packaging workflow.
- Hepta vectorization order that also mentions logo plus agent semantic route.
- Human feedback after submit/shortlist/win with agent semantic route routes to `human_feedback`.
- Legacy `post_submission_revision` / `post-submission-revision` workflow metadata canonicalizes to `human_feedback`.
- Explicit `consumer_feedback` / `buyer-feedback` metadata canonicalizes to `human_feedback`.
- Marketplace naming/text-form branch plus agent semantic route.
- Space/proposal board branch plus agent semantic route.

Routing only selects `human_feedback`; it does not prove the feedback loop is
safe to run. Plan and execution gates require a separate
`HumanFeedbackRevisionContract` before treating the routed task as a real
customer/consumer-feedback revision. That contract must bind the refreshed source,
target artifact, locked baseline, single active correction, and feedback review;
an unrelated old final/package review is not enough. Active corrections must
point back to a refreshed source ref, file-hash target bindings must use
canonical `sha256:<64 hex>` digests, and customer-facing approval/evidence must
bind the same contract hash across plan, package, and review.

Run:

```bash
npm run selftest
```

## Boundary

The router only selects the product line and default output mode. It does not
perform semantic intake, provider/model calls, reference-pack lookup, live-page
prepare/upload/submit, or customer messaging.
