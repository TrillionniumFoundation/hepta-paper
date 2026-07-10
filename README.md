# hepta-paper-workspace

Clean integration workspace for rebuilding `paper_factory` around the
the vendored `design-production-core` workflow.

## Layout

- `core/` is a vendored fork with an accepted content-hash baseline in
  `core/CORE_BASELINE.json`. It records historical upstream commit
  `3f90aa277a9a1bde6898dc6ddd9d25d49fa94f30`, but does **not** claim byte
  identity with that now-unavailable snapshot.
- `paper-adapters/` is reserved for thin paper-domain adapters extracted from
  the current dirty `paper_factory` tree.

## Migration Rule

The hepta core owns workflow state, runner handoff, action manifests, dispatch,
receipts, audit archive, replay guard, reconciliation, and settlement gates.

The old `paper_factory` tree may only contribute paper-domain adapters:

- paper inventory and venue metadata
- draft/source workspace discovery
- LaTeX build and package generation
- research/evidence/proof/claim verification workers
- referee revision workers, including agent-owned approval and clean
  current-source repair patch application receipts

Do not move diagnostic-only report, matrix, capstone, or roadmap modules into
the core workflow. They must stay outside the canonical production spine unless
they are rewritten as thin adapters.

## First Milestone

Create a paper-domain canonical state row with:

`paper_id, venue, source_workspace, draft_status, compile_status,
research_verify_status, package_status, readiness_status, runner_status,
submission_status, next_action, auto_level`.

## Paper Overlay Commands

The clean overlay now lives outside the hepta snapshot:

- `paper-core/` owns paper contracts, canonical state, CLI, batch runner, and
  selftests.
- `paper-adapters/` owns plugin-style paper domain adapters.
- `runtime/` is ignored output for local build/package/report dry runs.
- `store/migrations/` owns the hepta-native SQLite schema. The runtime database
  is `runtime/hepta-paper.sqlite`; legacy `paper_factory.sqlite` is import-only.

Run:

```bash
npm run store:migrate-legacy
npm run store:status
npm run core:integrity
npm test
npm run paper:selftest
node paper-core/bin/paper-production-core.mjs proposal --idea "distributionally robust reinforcement learning for stochastic control" --discipline "machine learning" --venue NeurIPS --write-report
node paper-core/bin/paper-production-core.mjs proposal --idea "distributionally robust reinforcement learning for stochastic control" --discipline "machine learning" --venue NeurIPS --approved --materialize-source --write-report
node paper-core/bin/paper-production-core.mjs proposal --paper distributionally_robust_rl_for_stochastic_control --idea "distributionally robust reinforcement learning for stochastic control" --discipline "machine learning" --venue NeurIPS --title "Distributionally Robust RL for Stochastic Control" --approved --materialize-source --stage-inventory --write-report
node paper-core/bin/paper-production-core.mjs batch-run --mode inventory --paper distributionally_robust_rl_for_stochastic_control
node paper-core/bin/paper-production-core.mjs batch-run --mode local-build --paper distributionally_robust_rl_for_stochastic_control --execute
node paper-core/bin/paper-production-core.mjs batch-run --mode local-dry-run --paper distributionally_robust_rl_for_stochastic_control
node paper-core/bin/paper-production-core.mjs batch-run --mode reviewed-submit --paper distributionally_robust_rl_for_stochastic_control
node paper-core/bin/paper-production-core.mjs batch-run --mode inventory
node paper-core/bin/paper-production-core.mjs batch-run --mode local-dry-run --write-report
node paper-core/bin/paper-production-core.mjs batch-run --mode reviewed-submit
```

The proposal staging path writes only `runtime/proposal-staging/*.json`, a
runtime source skeleton, and proposal-derived seed contracts. It lets inventory
see an approved proposal as a staged `PaperTask` with
`research_verify_status=proposal_seed_present`, without mutating
the hepta-native store, legacy `paper_factory.sqlite`, YAML registry files, or
external venues.

The deterministic empirical runner is pipeline smoke only. Its simulator
encodes method effects and therefore cannot satisfy the academic evidence gate.
Academic evidence requires a hash-bound `ACADEMIC_EVIDENCE_ATTESTATION.json` in
the paper source workspace. Deterministic local referee personas have no
academic acceptance authority.

The proposal build path may execute a local LaTeX build under
`runtime/builds/<paper_id>/` and write `BUILD_ARTIFACT_ACCEPTANCE.json` for the
compiled PDF. That acceptance only permits local package/dry-run readiness; it
does not approve live submission.

The reviewed submit path produces a blocked manifest by design. It records the
handoff shape plus a `ReviewedSubmitPreflightPacket` without upload, email,
portal mutation, or live submission.
