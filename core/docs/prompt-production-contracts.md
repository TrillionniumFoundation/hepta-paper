# Prompt Production Contracts

`prompt-production-contracts` is the core-side contract between compiled prompt
evidence and the shared generation manifest contract.

`prompt-artifact-compiler` now owns the shared pure prompt artifact compiler:
subject lock, route intent, industry direction, reference grammar, negative
constraints, outcome learning, retrieval evidence, hashes, and local-only safety
flags. The contract layer accepts the compiler report plus a prompt readiness
report and checks that the local evidence is complete before the workflow can
continue toward package review or external runner handoff.

Neither layer calls a provider/model or grants execution permission.

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

`design_reference_resolution` chooses and binds the ref package. The prompt
production contract then proves generated prompt artifacts are bound to that
same reference evidence.

## Required Bindings

The contract checks:

- `PromptCompilerReport.kind === PromptCompilerReport`
- `PromptCompilerReport.status === prompt_compiler_report_ready`
- `PromptCompilerPlanSummary.kind === PromptCompilerPlanSummary`
- `promptCompilerHash` exists and is canonical
- per-artifact `compilerHash` exists and appears in the summary hash list
- prompt compiler summary/artifact hashes must preserve their semantic aliases;
  generic `hash` fields are not accepted as substitutes for
  `promptCompilerHash` or `compilerHash`
- required section ids are present:
  `subject_lock`, `route_intent`, `reference_grammar`,
  `negative_constraints`, and `retrieval_evidence`
- compiler artifact metrics do not report hard prompt-budget overflow
- compiler artifact metrics do not report semantic-lint blockers
- `PromptReadinessReport.kind === PromptReadinessReport`
- readiness status is `pass_prompt_readiness`
- `readinessHash` exists and is canonical
- readiness `promptCompilerHash` matches the compiler summary hash
- refpack id and retrieval hash match the plan/compiler/readiness chain
- plan retrieval evidence is a passing model-locked semantic-intake record with
  index routing and index override disabled
- plan retrieval `industryArbitration` exists, passes, and has no blockers
- prompt-set strategy has no blockers
- safety flags do not claim provider calls, browser/platform opens, uploads,
  submits, messages, acceptance, payment, deployment, state mutation, channel
  fetch, or execution permission

## Boundary

Core owns the hash and evidence contract. Channel packages keep ownership of:

- task/case paths
- channel-specific planner orchestration and task/case paths
- provider/model selection and spend gates
- platform upload/submit/message/acceptance/payment/deployment
- runner execution and live channel state

Run the local gate:

```bash
npm run prompt-production:contract-gate
```

It writes `reports/prompt-production-contract-gate-latest.json` and
`reports/prompt-production-contract-gate-latest.md` from synthetic fixtures and
negative probes. The gate is local-only and never grants execution permission.
