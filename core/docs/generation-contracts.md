# Generation Contracts

`generation-contracts` is the shared local contract for generation request and
manifest shape. It sits after prompt production contracts and before
approval/evidence gates.

## Node Position

```text
ChannelTask
  -> product-line decision
  -> workflow registry
  -> plan-only draft
  -> design_reference_resolution
  -> refpack_outcome_scoring
  -> prompt_artifact_compiler
  -> prompt_readiness_gate
  -> prompt_production_contract
  -> generation_contracts
  -> approval/evidence
  -> execution gate
  -> action manifest
  -> adapter handoff
```

The module builds and validates:

- `GenerationJob` manifests
- per-artifact provider request descriptors
- QA records and status enums
- attachment reference and no-copy guards
- prompt compiler and route-strategy hash continuity
- plan/manifest synchronization for workflow, industry, refpack, submit limit,
  route contract, model-locked retrieval, prompt compiler, prompt readiness,
  prompt production contract, and request prompts
- optional semantic lock validation through a caller-supplied validator

Executable generation descriptors (`execute=true`) fail closed unless they carry
the full prompt-production chain:

- canonical `DesignReferenceRetrieval.retrievalHash` with
  `status=model_locked_static_refpack`, `routingMode=model_semantic_locked`,
  `selectionAuthority=semantic_intake`, `indexRoutingActive=false`,
  `indexOverrideAllowed=false`, and passing `industryArbitration`
- canonical `promptCompilerHash` and `promptReadinessHash`
- a passing `PromptProductionContract` with canonical
  `promptProductionContractHash`, no blockers, safe local-only flags, and hashes
  matching the generation job
- per-request prompt compiler, retrieval, and prompt production contract hashes

A bare prompt string or `{ ok: true }` readiness stub is not enough for an
executable generation manifest.

## Boundary

This module is pure contract code. It creates local descriptors and validates
hash continuity; it does not call providers/models, open a browser/platform,
upload, submit, send messages, apply acceptance, pay, deploy, fetch channel
state, mutate channel state, or grant execution permission.

Channel packages still own provider execution, spend approvals, semantic
contract construction, task/case paths, live rules, and platform runners. For
subject-critical channels such as ZBJ, the channel adapter supplies its semantic
contract validator while reusing the shared manifest and plan-sync logic.
