# Prompt Artifact Compiler

`prompt-artifact-compiler` is the shared local compiler for prompt artifacts.
It sits after design-reference resolution and before the prompt production
contract gate.

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

The compiler turns channel-neutral data into `PromptCompilerArtifact` rows and a
`PromptCompilerPlanSummary`:

- subject lock
- route intent
- industry direction
- reference grammar
- negative constraints
- outcome learning
- retrieval evidence
- local semantic lint evidence
- prompt budget metrics
- per-artifact `compilerHash`
- plan-level `promptCompilerHash`

Retrieval evidence includes model-locked status, semantic-intake authority,
index-routing/override denial, selected/static refpack ids, and model industry
arbitration status. This keeps the compiled prompt tied to the same local
refpack evidence that readiness and production contracts later verify.

## Quality Guardrails

The compiler now emits deterministic local `PromptSemanticLint` and
`promptBudget` evidence for every artifact. The lint layer blocks obvious
production-prompt hazards such as reference-copy instructions, placeholder/demo
copy that could leak into output, and prompts that invite invented brand/company
wording while subject text is locked. The budget layer records base/guidance/
compiled character counts plus an approximate token count, with a warning budget
and a hard budget for readiness gates to enforce.

## Boundary

The compiler is pure local proof code. It does not call providers/models, open a
browser/platform, upload, submit, send messages, apply acceptance, pay, deploy,
fetch channel state, mutate state, or grant execution permission.

Channel packages still own task/case paths, live rules, spend gates, runners,
and platform execution. They may call the compiler through the package root and
then pass its reports to `prompt-production-contracts`.
