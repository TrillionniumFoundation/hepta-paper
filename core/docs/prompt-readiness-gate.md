# Prompt Readiness Gate

`prompt-readiness-gate` is the shared local gate for compiled prompt artifacts.
It validates `PromptReadinessGate` and `PromptSetStrategyGate` evidence before a
channel asks any provider to generate work.

The gate is pure control-plane logic. Its safety contract is
`localGateOnly: true`; it calls no provider or model, opens no browser or
platform, uploads or submits nothing, sends no messages, accepts no delivery,
pays or deploys nothing, and keeps `grantsExecutionPermission: false`.

The strategy gate checks route diversity, structured route strategy presence,
focus richness, application-proof richness and diversity, differentiation-key
richness and diversity, duplicate canonical signatures, and prompt-set
application proof. Strict multi-artifact strategy mode applies to logo/brand,
packaging, poster, presentation, catalog/brochure, proposal-board, and product
design workflows unless a caller explicitly marks the plan non-strict.

Readiness also consumes compiler-side `PromptSemanticLint` and `promptBudget`
evidence. Semantic lint blockers stop reference-copy instructions,
placeholder/demo prompt leakage, and subject-invention prompts; hard prompt
budget overflow stops provider handoff before a bloated prompt reaches a
generation contract. Hashes are deterministic so channels can bind readiness
evidence back to compiler reports and production contracts.

Readiness requires the plan's `DesignReferenceRetrieval` to be a passing
model-locked semantic-intake record: `ok: true`,
`status: model_locked_static_refpack`, `routingMode: model_semantic_locked`,
`selectionAuthority: semantic_intake`, `indexRoutingActive: false`,
`indexOverrideAllowed: false`, zero retrieval blockers, and passing
`industryArbitration`. A bare `retrievalHash` is not enough.
