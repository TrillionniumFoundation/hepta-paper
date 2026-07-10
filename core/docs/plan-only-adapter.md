# Plan-Only Adapter

`src/plan-only.mjs` is the first shared planning entry point for ZBJ, EPWK,
Hepta, and manual channels.

It turns channel-owned task/detail data into:

```text
ChannelTask
  -> routeProductLine()
  -> workflowProfile
  -> CreativeBrief
  -> ProductionPlanEnvelope
```

The output object is a `PlanOnlyDraft`.

## Why It Exists

Before this layer, each channel could quietly choose its own workflow,
artifact count, output mode, and quality gates. That is how EPWK or Hepta would
eventually drift away from the ZBJ production line.

The plan-only adapter makes the boundary explicit:

- channel adapters provide task facts, platform limits, and upstream agent semantic route evidence
- the product router chooses the product line only from explicit structured metadata or agent/LLM semantic route contracts
- the workflow registry provides the product gates
- the plan-only adapter assembles the draft plan
- execution remains outside core and behind channel approval/evidence gates

The plan-only adapter does not let title/category/requirement regular
expressions choose the product line. If no explicit or semantic route evidence is
present, `routeProductLine()` returns `generic_design` and the draft stays
blocked for agent semantic routing.

## Safety

Every `PlanOnlyDraft` carries:

```json
{
  "readOnly": true,
  "externalActions": false,
  "providerSpend": false,
  "modelSpend": false,
  "livePrepare": false,
  "liveSubmit": false,
  "acceptanceApply": false,
  "customerMessage": false,
  "deployment": false
}
```

This module must not call providers, models, browsers, upload endpoints,
submission endpoints, payment/profile/account endpoints, or customer messaging.

## Status

`plan_only_ready` means the normalized plan can be handed to a later gated
planner/executor.

`blocked_plan_only` means the plan is intentionally stopped before any later
action. Current blockers include:

- `generic_design_requires_clarification`
- `unsupported_channel_for_product_profile`

Warnings are non-blocking but should be surfaced in dashboards and approval
packets. Examples:

- low route confidence
- secondary route conflict ignored
- requested output differs from profile default

## Regression

Plan-only fixtures live in `fixtures/plan-only-fixtures.json` and run through:

```bash
npm run selftest
```

The read-only integration export also includes a `planOnly` section per sample:

```bash
npm run export:samples
```

Plan-only summaries bucket `productLineId` and `workflowId` after product-line
canonicalization. Direct legacy aliases such as `consumer_feedback`,
`buyer-feedback`, or `post-submission-revision` are reported as
`human_feedback`.
