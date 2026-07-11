# hepta-paper-workspace

Fail-closed integration workspace for replacing selected `paper_factory`
capabilities around an accepted vendored `design-production-core` baseline.

## Layout

- `core/` is a vendored fork with an accepted content-hash baseline in
  `core/CORE_BASELINE.json`. It records historical upstream commit
  `3f90aa277a9a1bde6898dc6ddd9d25d49fa94f30`, but does **not** claim byte
  identity with that now-unavailable snapshot.
- `paper-domain/` contains pure paper and submission contracts.
- `paper-application/` contains use cases and bounded planning.
- `paper-ports/` contains Store, Artifact, Worker, FormalVerifier, and
  SubmissionExecutor boundaries.
- `paper-adapters/` contains native paper-domain and infrastructure adapters.
- `paper-core/` contains the CLI, declarative mode registry, workflow engine,
  execution context, summaries, and compatibility facades.
- `workflow-kernel/` is the small active, domain-neutral transition/hash
  kernel. The full vendored core remains a reference fork.

Production defaults are physically separated: repository
`/data/home-data/hepta-paper`, assets `/data/home-data/hepta-paper-assets`,
runtime/store `/data/home-data/hepta-paper/runtime`, and frozen legacy archive
`/data/home-data/paper_factory`. Compatibility symlinks are not production
control-plane dependencies.

## Migration Rule

The paper workflow engine owns ordered stage execution and receipts. Generic
dispatch, replay, receipt, reconciliation, and settlement concepts are exposed
through native contracts and ports. The full vendored core is hash-bound but is
not claimed to be the active runtime implementation of every paper capability.

The old `paper_factory` tree may only contribute paper-domain adapters:

- paper inventory and venue metadata
- draft/source workspace discovery
- LaTeX build and package generation
- research/evidence/proof/claim verification workers
- referee revision workers and clean current-source repair patch application
  receipts; agent-owned approval is not a live-submission authority

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
npm run store:logical-integrity
npm run workspace:verify-decoupled
npm run store:restore-drill
npm run core:integrity
npm test
npm run paper:selftest
npm run paper:authority-selftest
npm run paper:architecture-selftest
npm run taskflow:pilot-selftest
npm run coverage:architecture
npm run coverage:repository
npm run coverage:system
npm run authority:status
npm run owner:status
npm run operational:status
npm run external:intake-verify -- --staging /path/to/external/staging
npm run assets:cold-volume-status
npm run assets:cold-volume-cas-status
npm run legacy:fixture-verify
npm run legacy:matrix-reference-status
npm run offhost:worm-status
node paper-core/bin/paper-production-core.mjs proposal --idea "distributionally robust reinforcement learning for stochastic control" --discipline "machine learning" --venue NeurIPS --write-report
node paper-core/bin/paper-production-core.mjs proposal --idea "distributionally robust reinforcement learning for stochastic control" --discipline "machine learning" --venue NeurIPS --approved --materialize-source --write-report
node paper-core/bin/paper-production-core.mjs proposal --paper distributionally_robust_rl_for_stochastic_control --idea "distributionally robust reinforcement learning for stochastic control" --discipline "machine learning" --venue NeurIPS --title "Distributionally Robust RL for Stochastic Control" --approved --materialize-source --stage-inventory --write-report
node paper-core/bin/paper-production-core.mjs batch-run --mode inventory --paper distributionally_robust_rl_for_stochastic_control
node paper-core/bin/paper-production-core.mjs batch-run --mode local-build --paper distributionally_robust_rl_for_stochastic_control --execute
node paper-core/bin/paper-production-core.mjs batch-run --mode local-dry-run --paper distributionally_robust_rl_for_stochastic_control
node paper-core/bin/paper-production-core.mjs batch-run --mode reviewed-submit --paper distributionally_robust_rl_for_stochastic_control
node paper-core/bin/paper-production-core.mjs batch-run --mode inventory
node paper-core/bin/paper-production-core.mjs batch-run --mode research-verify --paper distributionally_robust_rl_for_stochastic_control --execute
node paper-core/bin/paper-production-core.mjs batch-run --mode local-dry-run --write-report
node paper-core/bin/paper-production-core.mjs batch-run --mode reviewed-submit
node paper-core/bin/paper-production-core.mjs batch-run --mode local-review-loop --paper distributionally_robust_rl_for_stochastic_control
```

The proposal staging path writes only `runtime/proposal-staging/*.json`, a
runtime source skeleton, and proposal-derived seed contracts. It lets inventory
see an approved proposal as a staged `PaperTask` with
`research_verify_status=proposal_seed_present`, without mutating
the hepta-native store, legacy `paper_factory.sqlite`, YAML registry files, or
external venues.

The deterministic empirical runner is pipeline smoke only. Its simulator
encodes method effects and therefore cannot satisfy the academic evidence gate.
Academic evidence requires a version-2, Ed25519-signed, hash-bound
`ACADEMIC_EVIDENCE_ATTESTATION.json` in the paper source workspace plus
verified native worker receipts. Deterministic local referee personas have no
academic acceptance authority. The complete authority protocol is documented
in `paper-core/docs/authority-pipeline.md`.

Legacy capability decisions and the target layering are documented in
`paper-core/docs/architecture-v3.md`. The 249 retired legacy source files are
not treated as 249 business capabilities: 88 are permanent retirements, 40
need native coverage proof, and 121 are compressed into bounded native
capabilities. Owner acceptance is still pending for all 249 decisions.

Owner acceptance is requested as 13 hash-bound capability families, each of
which expands to an exact, non-overlapping set of legacy matrix entries only
after an external `capability_owner` signature verifies. Production-bound
operational proof is separately ingested per native capability and must bind
real input/result/replay hashes, the current release commit and current target
hashes. Conformance receipts cannot qualify.

The 15 unavailable `NDU_Nature_work` cold-data links are governed by
`paper-core/config/cold-volume-contract.v1.json`. Contract verification is a
release gate; operational replay stays fail-closed until the declared
`THUNDERO_EXT4` mount and its hash-bound content manifest are present. The
repository-wide coverage gate imports every production module and enforces a
whole-repository baseline in addition to the stricter architecture-module gate.
When that volume becomes available, its declared content can be imported into
a content-addressed recovery store and independently restore-drilled. Release
verification never treats a missing volume or absent CAS manifest as
operational proof.

All selftests, capability checks, coverage commands and release verification
run against disposable runtime state. Read-only status commands use a
read-only StorePort. The signed release binds both SQLite bytes and a canonical
logical database hash so page-layout churn cannot be confused with a logical
state change. The 263-row legacy audit selectively restores its sources from
the immutable archive; it no longer reads the live legacy working directory.

Executed workflows may also write a hash-bound native `workflow_states`
projection through `WorkflowStatePort`; its matching ledger receipt remains
the audit anchor. Planning and status commands do not write this projection.
The optional OpenClaw TaskFlow pilot is documented in
`paper-core/docs/taskflow-pilot.md`. It is disabled by default and coordinates
external waits for one allowlisted reviewed-submission attempt without owning
business gates, evidence validation, credentials, release locks, or authority.

External-disk WORM onboarding is governed by
`paper-core/config/offhost-worm-contract.v1.json`. The current external target
is the ext4 volume mounted at `/media/qian-qi/TOSHIBA_CLEAN3` (the operator's
renamed external disk). A snapshot can qualify only on a distinct mounted
filesystem with immutable objects and a successful restore drill. Local
packets and signatures cannot satisfy that external-media requirement. This
is currently a same-host external-disk protection level, not an off-host or
offsite custody claim. Off-host/offsite qualification additionally requires an
offline-detachment or object-storage Object Lock receipt and independent
custody attestation. This
WORM target is independent of the `THUNDERO_EXT4` cold-data contract: the
TOSHIBA volume must not be treated as a cold-data recovery source unless all 15
declared entries and their hash-bound sentinel are actually present.

The proposal build path may execute a local LaTeX build under
`runtime/builds/<paper_id>/` and write `BUILD_ARTIFACT_ACCEPTANCE.json` for the
compiled PDF. That acceptance only permits local package/dry-run readiness; it
does not approve live submission.

The reviewed-submit path is fail-closed unless it has signed academic evidence,
an independent signed referee acceptance, and a dual-signed, single-use live
authorization scoped to the current package, venue, provider, and account. A
fully verified fixture may make the controlled-executor handoff ready, but the
overlay still performs no upload, email, portal mutation, or live submission.
