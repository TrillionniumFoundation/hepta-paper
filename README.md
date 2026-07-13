# hepta-paper-workspace

Automation-first research and paper production workspace. Its primary runtime
runs concurrent paper campaigns that plan research, write manuscripts and
code, execute empirical work, compile LaTeX, obtain independent referee
reviews, revise, and revalidate affected artifacts. Live submission is a
separate optional plane and is disabled by default.

The single current architecture/runtime status is maintained in
[`paper-core/docs/CURRENT_STATUS.md`](paper-core/docs/CURRENT_STATUS.md).

## Automation Plane

The automation plane does not require owner signatures, academic authority
keys, legacy acceptance, cold-volume availability, or a live submission
provider. One paper is one persistent `PaperCampaign` DAG; several campaigns
and their dependency-ready nodes may run concurrently. SQLite leases,
idempotent node results, bounded retries and expired-lease recovery provide
crash-safe execution.

Agent work uses isolated OpenClaw child sessions by default, with a local
structured Ollama model as the offline fallback and authenticated Codex as an
optional backend.
Empirical workers support Python, Node, R, Julia, Lean and LaTeX when their
host runtimes are installed, with network isolation, timeouts, CPU/memory/PID
limits, optional GPU access and declared artifact export. Code and LaTeX
failures feed their real diagnostics into bounded repair steps before being
re-executed. Referee convergence requires multiple reviews and is always a
local automation decision, never an academic acceptance or submission grant.

```bash
npm run store:migrate
npm run automation:status
npm run automation:selftest
HEPTA_AGENT_LOCAL_PROVIDER=ollama \
  HEPTA_AGENT_MODEL=<local-model> npm run automation:agent-smoke
HEPTA_AGENT_MODEL=<local-model> npm run automation:campaign-smoke
npm run paper:campaign -- --help
```

Budget-stopped campaigns can be continued in place only after an explicit
budget increase. If strict referee convergence exhausts the configured rounds,
an operator can append another review/revise/revalidation round without
replaying completed nodes:

```bash
npm run paper:campaign -- --action resume --campaign-id <id> --max-cpu-jobs 20 --max-tokens 1800000
npm run paper:campaign -- --action extend --campaign-id <id> --rounds 3 --max-agent-calls 30 --max-cpu-jobs 28 --max-tokens 2500000
npm run paper:campaign -- --execute --paper <paper-id> --campaign-id <id> --rounds 3
```

Each amendment is persisted as a campaign event, recomputes the campaign plan
hash, preserves completed results, and reopens or appends only the required
nodes. Non-budget operational stops cannot be resumed, and non-convergence
cannot be bypassed by packaging.

The optional TaskFlow integration mirrors long-lived campaign checkpoints and
waits; the native campaign store remains the DAG source of truth. Details are
in `paper-core/docs/automation-plane.md`.

## Layout

- `core/` is a vendored fork with an accepted content-hash baseline in
  `core/CORE_BASELINE.json`. It records historical upstream commit
  `3f90aa277a9a1bde6898dc6ddd9d25d49fa94f30`, but does **not** claim byte
  identity with that now-unavailable snapshot.
- `paper-domain/` contains pure paper/submission contracts and the workflow
  mode vocabulary.
- `paper-application/` contains execution context, workflow orchestration, use
  cases, bounded planning and reporting.
- `paper-ports/` contains Store, Artifact, Worker, FormalVerifier, and
  SubmissionExecutor boundaries.
- `paper-adapters/` contains native paper-domain and infrastructure adapters.
- `paper-core/` contains CLI composition, selftests and compatibility facades;
  it is not a second contract or runtime-utility owner.
- `workflow-kernel/` is the small active, domain-neutral transition/hash
  kernel. The full vendored core remains a reference fork.

Production defaults are physically separated: repository
`/data/home-data/hepta-paper`, assets `/data/home-data/hepta-paper-assets`,
runtime/store `/data/home-data/hepta-paper/runtime`, and immutable retirement
references `/data/home-data/hepta-paper-legacy-reference`. The live
`/data/home-data/paper_factory` tree has been retired and physically removed.

## Migration Rule

The paper workflow engine owns ordered stage execution and receipts. Generic
dispatch, replay, receipt, reconciliation, and settlement concepts are exposed
through native contracts and ports. The full vendored core is hash-bound but is
not claimed to be the active runtime implementation of every paper capability.

The old `paper_factory` tree no longer participates in runtime or development.
Historical semantics can be inspected only through the immutable retirement
snapshot and the read-only `migration/retirement/` audit. Any future feature
must be reimplemented against the current contracts and ports, not copied from
the legacy control plane. The retained behavioral replacements cover:

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

- `paper-domain/` owns paper contracts; `paper-application/` owns the batch
  workflow; `paper-core/` owns CLI composition, compatibility facades and
  selftests.
- `paper-adapters/` owns plugin-style paper domain adapters.
- `runtime/` is ignored output for local build/package/report dry runs.
- `store/migrations/` owns the hepta-native SQLite schema. The runtime database
  is `runtime/hepta-paper.sqlite`; no root-level legacy SQLite placeholder is
  retained.

Run:

```bash
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
npm run coverage:critical-modules
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
npm run migration:retirement-status
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
the hepta-native store, retired legacy data, YAML registry files, or
external venues.

The deterministic empirical runner is pipeline smoke only. Its simulator
encodes method effects and therefore cannot satisfy the academic evidence gate.
Academic evidence requires a version-2, Ed25519-signed, hash-bound
`ACADEMIC_EVIDENCE_ATTESTATION.json` in the paper source workspace plus
verified native worker receipts. Deterministic local referee personas have no
academic acceptance authority. The complete authority protocol is documented
in `paper-core/docs/authority-pipeline.md`.

Legacy capability decisions and the target layering are documented in
`paper-core/docs/architecture-v3.md`. The 249 retired legacy source decisions
are grouped into 19 hash-bound families. All 249 currently have
`local_admin_delegated` acceptance; none is represented as independent
external-owner acceptance. Fourteen production-source-bound conformance
replays are separate from production operational proof. Operational proof
requires distinct externally trusted capability-owner and operational-observer
signatures and remains 0/14 until such evidence is ingested.

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
