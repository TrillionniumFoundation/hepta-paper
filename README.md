# hepta-paper-workspace

Automation-first research and paper production workspace. Its primary runtime
runs concurrent paper campaigns that plan research, write manuscripts and
code, execute empirical work, compile LaTeX, obtain independent referee
reviews, revise, and revalidate affected artifacts. Live submission is a
separate optional plane and is disabled by default.

The single current architecture/runtime status is maintained in
[`paper-core/docs/CURRENT_STATUS.md`](paper-core/docs/CURRENT_STATUS.md).

## Automation Plane

The draft automation plane does not require owner signatures, academic
authority keys, legacy acceptance, cold-volume availability, or a live
submission provider. Academic empirical promotion separately requires its
externally authorized dataset/harness and release-attestor trust boundaries. One
paper is one persistent `PaperCampaign` DAG; several campaigns
and their dependency-ready nodes may run concurrently. SQLite
generation-fenced leases, immutable prepared results, bounded retries and
expired-lease recovery provide crash-safe execution. A stale worker cannot
heartbeat, fail or complete a newer attempt, and recovery can integrate a
prepared result without rerunning its external executor.

Draft agent work may use isolated OpenClaw child sessions or a local structured
Ollama circuit breaker. Research-grade campaigns fail closed unless an
explicit-model, private, authenticated Codex author and a separately rooted
Codex formal reviewer pass configuration preflight. The strict research-status
command additionally performs one explicit, read-only, ephemeral live-model
canary for each role; every later campaign call revalidates the selected binary,
credential root, config content/identity and authentication before execution.
Draft backends are never silently promoted to research-grade authorship.
Empirical workers support Python, Node, R, Julia, Lean and LaTeX when their
host runtimes are installed, with network isolation, timeouts, CPU/memory/PID
limits, optional GPU access and declared artifact export. Code and LaTeX
failures feed their real diagnostics into bounded repair steps before being
re-executed. Referee convergence requires multiple reviews and is always a
local automation decision, never an academic acceptance or submission grant.

```bash
npm run hepta-paper -- operator store-migrate
npm run hepta-paper -- operator automation
npm run hepta-paper -- operator research-readiness
npm run automation:selftest
HEPTA_AGENT_LOCAL_PROVIDER=ollama \
  HEPTA_AGENT_MODEL=<local-model> npm run automation:agent-smoke
HEPTA_AGENT_MODEL=<local-model> \
  HEPTA_SMOKE_MAX_ROUNDS=2 npm run automation:campaign-smoke
npm run hepta-paper -- operator campaign -- --help
npm run hepta-paper -- operator autonomous-research -- --help
```

The autonomous command can machine-select a bounded, versioned agenda and run a
persisted research-to-package DAG without research-time human checkpoints. It
can generate an evidence-bound manuscript IR, emit a bounded dynamic Lean claim,
retrieve structured snapshot-bound prior art, use signed reviewers from distinct
machine trust domains, perform local and off-host replay, independently recompute
typed numeric oracles, rebuild the PDF from source in a fresh sandbox, revise
against fresh referee evidence, and prepare a local submission handoff only after
venue, metadata, source, PDF and page-limit compliance passes. Research DAG
execution can run without a per-campaign human checkpoint when its machine
authorities are preprovisioned. Provider draft creation is a separate reversible
capability. A live portal commit remains a third, separately qualified capability
and requires a human-reviewed, hash-bound, single-use authorization for the exact
package, venue, provider and account. The
system does not claim universal scientific novelty, exhaustive prior art,
natural-language-to-Lean equivalence, scientific truth, or venue acceptance,
and it never self-signs missing dataset, provider-account or release trust.

Capability reports label the strongest evidence actually established for each
lane as `contract_fixture`, `real_runtime_fixture`, `live_model`, or
`external_trust`. A stronger-sounding test name cannot promote evidence between
those levels, and only `external_trust` can carry production authority.

Budget-stopped campaigns can be continued in place only after an explicit
budget increase. If strict referee convergence exhausts the configured rounds,
an operator can append another review/revise/revalidation round without
replaying completed nodes:

```bash
npm run hepta-paper -- operator campaign -- --action resume --campaign-id <id> --max-cpu-jobs 20 --max-tokens 1800000
npm run hepta-paper -- operator campaign -- --action extend --campaign-id <id> --rounds 3 --max-agent-calls 30 --max-cpu-jobs 28 --max-tokens 2500000
npm run hepta-paper -- operator campaign -- --execute --paper <paper-id> --campaign-id <id> --rounds 3
```

Each amendment is persisted as a campaign event, recomputes the campaign plan
hash, preserves completed results, and reopens or appends only the required
nodes. Non-budget operational stops cannot be resumed, and non-convergence
cannot be bypassed by packaging.

Campaign completion produces a typed, immutable handoff rather than granting
submission authority directly:

`campaign → AutomationPromotionCandidate → build-package → prepared CampaignReleaseBundle → fenced package completion/current-release authority → submission verification`

The experimental TaskFlow pilot is limited to reviewed-submission waiting and
is absent from campaign and production composition roots. The native campaign
store is the only DAG execution authority. Details are in
`paper-core/docs/automation-plane.md`.

## Layout

- `core/` is a private, pinned read-only submodule with an accepted
  content-hash baseline in `core/CORE_BASELINE.json`. It records historical upstream commit
  `3f90aa277a9a1bde6898dc6ddd9d25d49fa94f30`, but does **not** claim byte
  identity with that now-unavailable snapshot. It is a reference package, is
  not imported by the active production graph, and is governed by
  `paper-core/docs/reference-and-compatibility-boundaries.md`.
- `paper-domain/` contains pure paper/submission contracts and the workflow
  mode vocabulary.
- `paper-application/` contains execution context, campaign orchestration,
  bounded planning and reporting.
- `paper-ports/` contains Store, Artifact, Worker, FormalVerifier, and
  SubmissionExecutor boundaries.
- `paper-adapters/` contains native paper-domain and infrastructure adapters.
- `paper-core/` contains CLI composition, selftests and compatibility facades;
  it is not a second contract or runtime-utility owner.
- `workflow-kernel/` is the small active, domain-neutral hash/runtime utility
  kernel. The full vendored core remains a reference fork.

Production defaults are physically separated: repository
`/data/home-data/hepta-paper`, assets `/data/home-data/hepta-paper-assets`,
runtime/store `/data/home-data/hepta-paper-runtime/native-runtime`, and immutable retirement
references `/data/home-data/hepta-paper-legacy-reference`. The live
`/data/home-data/paper_factory` tree has been retired and physically removed.
Every writable composition bootstrap repeats a symlink-safe real-path overlap
check, so an explicit `--runtime-root` cannot place mutable runtime state back
inside the repository, assets, or legacy reference tree.

## Migration Rule

The campaign DAG is the sole execution authority. The retired ordered-stage
workflow engine, stage handlers, and local diagnostic loop are absent from the
active tree. Dispatch, replay, receipt, reconciliation, and settlement concepts
are exposed through native contracts and ports. The full vendored core is
hash-bound but is not claimed to be the active runtime implementation of every
paper capability.

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

- `paper-domain/` owns paper contracts; `paper-application/` owns campaign use
  cases; `paper-core/` owns CLI composition, bounded migration facades and
  selftests.
- `paper-adapters/` owns plugin-style paper domain adapters.
- `runtime/` is ignored output for explicitly local build/package/report dry
  runs; it is not the default mutable production root.
- `store/migrations/` owns the hepta-native SQLite schema. The runtime database
  defaults to
  `/data/home-data/hepta-paper-runtime/native-runtime/hepta-paper.sqlite`; no
  root-level legacy SQLite placeholder is retained.

Run:

```bash
npm run hepta-paper -- operator store
npm run store:logical-integrity
npm run workspace:verify-decoupled
npm run store:restore-drill
npm run reference:integrity
npm run safety:all
npm test
npm run paper:selftest
npm run paper:authority-selftest
npm run hepta-paper -- verify architecture
npm run experimental:taskflow-selftest
npm run coverage:architecture
npm run coverage:critical-modules
npm run coverage:repository
npm run coverage:system
npm run authority:status
npm run hepta-paper -- verify owner
npm run hepta-paper -- verify operational
npm run external:intake-verify -- --staging /path/to/external/staging
npm run assets:cold-volume-status
npm run assets:cold-volume-cas-status
npm run legacy:fixture-verify
npm run legacy:matrix-reference-status
npm run migration:retirement-status
npm run offhost:worm-status
node paper-core/bin/paper-production-core.mjs proposal --idea "distributionally robust reinforcement learning for stochastic control" --discipline "machine learning" --venue NeurIPS --scientific-claim-document /secure/path/SCIENTIFIC_CLAIMS.json --write-report
node paper-core/bin/paper-production-core.mjs proposal --idea "distributionally robust reinforcement learning for stochastic control" --discipline "machine learning" --venue NeurIPS --scientific-claim-document /secure/path/SCIENTIFIC_CLAIMS.json --approval-document /secure/path/PROPOSAL_APPROVAL_DOCUMENT.json --materialize-source --write-report
node paper-core/bin/paper-production-core.mjs proposal --paper distributionally_robust_rl_for_stochastic_control --idea "distributionally robust reinforcement learning for stochastic control" --discipline "machine learning" --venue NeurIPS --title "Distributionally Robust RL for Stochastic Control" --scientific-claim-document /secure/path/SCIENTIFIC_CLAIMS.json --approval-document /secure/path/PROPOSAL_APPROVAL_DOCUMENT.json --materialize-source --stage-inventory --write-report
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

`npm run scripts:surface` prints the supported operator plus verification,
maintenance, retirement, compatibility, experimental and internal command
groups. Only the operator group belongs to the production operator surface.
The concise operational runbook is `paper-core/docs/OPERATIONS.md`.

The proposal staging path requires an Ed25519-signed approval document verified
by an active `proposal_approver` public key in
`runtime/trust/AUTHORITY_TRUST_STORE.json`; the removed `--approved` boolean is
rejected. It writes only `runtime/proposal-staging/*.json`, a runtime source
skeleton, the signed approval and verification receipt, and proposal-derived
seed contracts. It lets inventory see an approved proposal as a staged `PaperTask` with
`research_verify_status=proposal_seed_present`, without mutating
the hepta-native store, retired legacy data, YAML registry files, or
external venues. See `paper-core/docs/proposal-approval-authority.md` for the
signed schema and two-pass draft/approval flow.

The deterministic empirical runner is pipeline smoke only. Its simulator
encodes method effects and therefore cannot satisfy the academic evidence gate.
Academic evidence requires a version-2, Ed25519-signed, hash-bound
`ACADEMIC_EVIDENCE_ATTESTATION.json` in the paper source workspace plus
verified native worker receipts. Deterministic local referee personas have no
academic acceptance authority. The complete authority protocol is documented
in `paper-core/docs/authority-pipeline.md`.

Legacy capability decisions and the current target layering are documented in
`paper-core/docs/ARCHITECTURE.md` and the versioned records under
`paper-core/docs/history/`. The 249 retired legacy source decisions
are grouped into 19 hash-bound families. All 249 currently have
`local_admin_delegated` acceptance; none is represented as independent
external-owner acceptance. Sixteen production-source-bound conformance
replays are separate from production operational proof. Operational proof
requires distinct externally trusted capability-owner and operational-observer
signatures and remains 0/16 until such evidence is ingested.
This independent operational layer is external-assurance reporting, not a code
release blocker; implementation and release-bound conformance are the two
blocking 16/16 layers. A local deployment must leave the external count at zero
rather than manufacture nominally independent signers.

The two added capabilities are the bounded single-GPU CuPy Poisson solver and
deterministic CuPy MLP trainer. Their local execution receipts do not establish
physical multi-tenant GPU isolation, independent same-device replay, or a
per-campaign promotion authority; those claims remain fail-closed until the
corresponding external, campaign-bound evidence is verified.

GPU lease coordination, archive rollback, and authorized package retention
assume repository-owned cooperating processes running as one trusted Unix
principal. A non-cooperating process that can mutate the same runtime, package,
archive, or lease roots under that UID is part of the trusted computing base;
these mechanisms are not a security boundary against such a process. A
deployment that requires hostile same-UID isolation must use a separate UID,
an inaccessible mount namespace, or a separately authorized broker.

The retired `THUNDERO_EXT4` volume is no longer part of the cold-data contract.
`paper-core/config/cold-volume-contract.v1.json` now binds the exact ext4
UUID/PARTUUID mounted at `/mnt/hepta-paper-external`. The three observed
OpenNeuro dataset roots on that TOSHIBA disk are declared only as raw sources;
they cannot masquerade as any of the 15 historical `NDU_Nature_work` derived
artifacts. All 15 are formally retired from the 0.21 active release scope; the
machine-readable retirement inventory preserves their prior six-rebuildable
and nine-missing dispositions for audit. Active entry count is zero, so no
sentinel, cold-CAS object, import, or restore drill is required for those
retired artifacts. The three raw roots are also explicitly non-release-blocking.
The SMR source remains sequential-read-only and permits only a single
append-new-files writer with no in-place mutation. The repository-wide coverage
gate imports every production module and enforces a whole-repository baseline
in addition to the stricter architecture-module gate.

Schema migrations 021–025 add generation fencing for jobs, attempt/revision
fencing plus recoverable prepared results for campaign nodes, restore-proof
qualification for workspace retention, explicit submission-delivery ownership,
and an immutable cutover authority for the dedicated autonomous-submission
handoff database. Workflow projection and its effective ledger receipt now
commit atomically. Backup deletion requires trusted backup and restore-drill
evidence, retains at least two generations, and records a durable intent before
deletion.

Deploy 021–025 as an offline cutover: stop all old job/campaign/submission
workers, expire or recover/clear every outstanding job, campaign, delivery,
and response-consumption lease marker, checkpoint and close the old store, then
run `npm run hepta-paper -- operator store-migrate`. The migration command checks the old schema and
lease state through a read-only connection before opening the database for
upgrade; live leases or an active WAL reject the cutover without changing its
schema or bytes. Verify native-store schema version 25 and the hash-matched
021–025 history
with `npm run hepta-paper -- operator store`, then restart only new workers. Rolling mixed
old/new workers are unsupported. Scoped production roots refuse startup
against an older or mismatched schema. No writable runtime root, including the
explicit legacy compatibility facade, runs migrations implicitly; run
`store:migrate` first. Every production surface that writes a store, report,
proposal, staging record or administrative receipt first rejects physical or
symlink-resolved overlap among the source workspace, asset, runtime and legacy
roots.

Planning and dry-run modes open no writable store, run no migration and create
no database. Reports are written only when `--write-report` is explicit; their
content-addressed artifacts and local provenance receipts live under the
runtime report directories and never enter the business SQLite trust plane.
The default immutable preview refuses an active SQLite WAL/SHM, so checkpoint
and close writers before an operator preview. Cancellation propagates an
`AbortSignal` to the child process group; a late or cancelled result is rejected
again at the fenced integration boundary.

All selftests, capability checks, coverage commands and release verification
run against disposable runtime state. Read-only status commands use a
read-only StorePort. The signed release binds both SQLite bytes and a canonical
logical database hash so page-layout churn cannot be confused with a logical
state change. The 263-row legacy audit selectively restores its sources from
the immutable archive; it no longer reads the live legacy working directory.

Executed workflows may also write a hash-bound native `workflow_states`
projection through `WorkflowStatePort`; its matching ledger receipt remains
the audit anchor. Planning and status commands do not write this projection.
The experimental OpenClaw TaskFlow pilot is documented in
`paper-core/docs/experimental-taskflow-pilot.md`. It is disabled by default,
is not reachable from a production composition root, and coordinates
external waits for one allowlisted reviewed-submission attempt without owning
business gates, evidence validation, credentials, release locks, or authority.

External-disk WORM onboarding is governed by
`paper-core/config/offhost-worm-contract.v1.json`. The current external target
is the ext4 volume mounted at the root-managed
`/mnt/hepta-paper-external` path. A snapshot can qualify only on a distinct mounted
filesystem whose filesystem UUID and partition UUID exactly match the pinned
contract, with immutable objects and a successful restore drill. Local
packets and signatures cannot satisfy that external-media requirement. This
is currently a same-host external-disk protection level, not an off-host or
offsite custody claim. Off-host/offsite qualification additionally requires a
continuously verifiable object-storage Object Lock receipt and independent
custody attestation. A static contract boolean is insufficient: the typed
receipt and pinned-trust-store Ed25519 attestation must be fresh and bind the
currently mounted UUID/PARTUUID storage identity plus the selected immutable
snapshot manifest and object-set hashes. A historical offline-detachment
receipt cannot qualify a disk that is currently reattached to the production
host. `npm run offhost:worm-status` reports the same-host target
for diagnosis only; `npm run offhost:worm-status -- --require-custody` is the
fail-closed custody gate, and the sealed release environment always selects
that strict mode. A diagnostic `ready` result is not production-exit evidence.
The cold-source and WORM namespaces are now co-resident on this one TOSHIBA
device. They are logically separated but share one physical failure domain;
neither namespace establishes independent custody for the other. Raw-source
availability does not satisfy any missing or rebuildable derived disposition,
and SMR-safe operation requires sequential source reads, one append-new-files
writer, and no in-place mutation.

The proposal build path may execute a local LaTeX build under
`runtime/builds/<paper_id>/` and write `BUILD_ARTIFACT_ACCEPTANCE.json` for the
compiled PDF. That acceptance only permits local package/dry-run readiness; it
does not approve live submission.

The reviewed-submit path is fail-closed unless it has signed academic evidence,
an independent signed referee acceptance, and a dual-signed, single-use live
authorization scoped to the current package, venue, provider, and account. A
fully verified fixture may make the controlled-executor handoff ready, but the
overlay still performs no upload, email, portal mutation, or live submission.

Universal submission connector coverage is documented in
`paper-core/docs/universal-submission-system.md`. The repository currently has
explicit dispositions for all 98 stable target identities and candidate-family
prototypes covering all 60 journal and 38 conference targets, while verified
portal bindings, sandbox qualification and live authorization remain
fail-closed.
