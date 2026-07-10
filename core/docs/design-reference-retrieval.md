# Design Reference Retrieval

`DesignReferenceRetrieval` is the evidence record for how a
`DesignReferenceSpec` was selected. It is not a live search action and it does
not grant permission to generate, upload, submit, message, pay, accept, or deploy.

## Authority Fields

Every retrieval record should expose these fields:

- `routingMode`: the route family. Current values are `model_semantic_locked`,
  `index_routing`, `index_routing_blocked`, and `operator_disabled`.
- `selectionAuthority`: the source that is allowed to choose the pack. Normal
  core planning uses `semantic_intake`.
- `indexRoutingActive`: true only when a refpack index actually ran and produced
  retrieval evidence.
- `indexOverrideAllowed`: true only on flows where index evidence may replace the
  static semantic pack.
- `selectedRefpackId`: the pack used by the plan/review.
- `staticRefpackId`: the model-selected static pack before optional index
  confirmation or override.
- `topRefpackId`: the highest scoring index pack when index routing is active;
  null for model-locked static routing.
- `industryArbitration`: deterministic local evidence for model industry
  confidence and audit/index disagreement checks.
- `retrievalHash`: deterministic evidence hash for the selection record.

## Normal Core Rule

In `design-production-core`, model semantic intake is authoritative for industry
selection. That means the normal retrieval shape is:

```json
{
  "routingMode": "model_semantic_locked",
  "selectionAuthority": "semantic_intake",
  "indexRoutingActive": false,
  "indexOverrideAllowed": false
}
```

The ZBJ refpack index can exist as an audit or offline routing tool, but it must
not silently override the model industry in the core LLM design-reference
resolver.

## Model Industry Arbitration

The resolver now gates model-locked refpack selection through local arbitration:

- confidence below `0.62` blocks with
  `model_industry_confidence_below_floor`
- confidence below `0.75` is recorded as
  `model_industry_confidence_needs_review`
- audit/index disagreement blocks when the model confidence is below `0.82`,
  using `model_industry_audit_conflict_low_confidence`
- high-confidence disagreement stays a warning named
  `audit_industry_disagrees_with_llm_industry`; audit/index still cannot
  override the model-selected industry

When arbitration blocks, `DesignReferenceRetrieval.ok` is false and
`resolveLlmDesignReferenceSpec()` returns a blocked `DesignReferenceSpec` even
if a static refpack exists. This keeps low-confidence or contradictory industry
selection from silently poisoning downstream design prompt generation.

## Source Boundary

Reference packages are digest-only design grammar. They may include DESIGN.md
summaries, open design-system structure, official format specs, and public
research summaries. They must not copy third-party marks, exact layouts,
proprietary fonts, official trade dress, demo dashboards, or sample data.

## Taxonomy Sync

Core owns the model industry ID allowlist through
`src/llm-design-reference-resolver.mjs`. ZBJ/hepta-design owns the working
taxonomy and refpack registry. The selftest runs
`buildDesignReferenceTaxonomySyncGate()` to prove:

- every ZBJ taxonomy ID exists in the core model allowlist
- every core model industry ID exists in ZBJ taxonomy
- every ZBJ taxonomy ID has a refpack
- every refpack industry ID exists in taxonomy
- sentinel packs such as `refpack_general_technology_b2b_v1` and
  `refpack_ceramic_decal_character_v1` remain present

This gate is local source inspection only. It does not call providers or models,
open a browser, read live platform state, upload, submit, send messages, pay,
accept delivery, deploy, mutate lifecycle state, or grant execution permission.

Design-reference summaries bucket workflow IDs after product-line
canonicalization. Direct specs that still spell human-feedback workflow as
`consumer-feedback`, `buyer-feedback`, or `post-submission-revision` are counted
under `human_feedback`.
