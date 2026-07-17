# Paper Production Migration Master Plan

> Superseded implementation note (2026-07-10): this master plan records the
> original overlay sequence. Current layering, migration decisions, local
> diagnostic review semantics, Store/Artifact ports, and submission delivery
> boundary are defined by `architecture-v3.md`. `core/` is an accepted vendored
> fork, not a byte-identical upstream snapshot and not the active implementation
> of every paper runtime capability.

## Decision Summary

Use the copied design-production-core as a clean production kernel reference,
not as a place to paste paper-specific code. The active paper system lives in
`paper-core/` and `paper-adapters/`.

Default rule:

- `core/` stays hash-bound to its accepted vendored baseline; historical
  upstream byte identity is not claimed.
- `paper-core/` owns paper contracts, state, manifests, receipts, reports, and
  the batch CLI.
- `paper-adapters/` owns domain capabilities extracted from `paper_factory`.
- Old `paper_factory` remains the data/domain source, not the workflow source of
  truth.

## Audited Design Core Workflow

The design-production core has two useful layers.

Product chain:

```text
ChannelTask
-> CreativeBrief
-> ProductionPlanEnvelope
-> ArtifactPackage
-> ReviewReport
-> ChannelSubmission
-> AdapterRunReceipt
-> ChannelStateProof
```

Runtime chain:

```text
fresh approval/evidence
-> execution gate
-> state transition
-> action manifest
-> adapter preview
-> external action ledger
-> handoff outbox
-> replay guard
-> dispatch envelope
-> runner registry/selection
-> dispatch assignment/readiness
-> adapter runner SDK contract
-> receipt inbox
-> state proof
-> audit archive
-> reconciliation/final settlement
```

The important property is descriptor-only control. The core prepares and checks
handoff objects; it should not run portals, browsers, uploads, customer
messages, payments, deployments, or live venue submissions.

## What To Keep

Keep these design-core ideas because they are domain-neutral:

- canonical task/product contract before execution
- explicit workflow state and state transitions
- immutable artifact/package hashes
- approval/fresh-evidence gates before external action
- action manifest as the final local command descriptor
- adapter preview/dry-run receipt before live execution
- runner location boundary outside the core workspace
- receipt, state proof, audit archive, reconciliation, and settlement
- report freshness/hash/contract checks

## What To Replace

Replace design semantics with paper semantics in the overlay:

| Design production concept | Paper replacement |
| --- | --- |
| `ChannelTask` | `PaperTask` |
| `CreativeBrief` | `ManuscriptSource` / source workspace contract |
| `ProductionPlanEnvelope` | `PaperProfileContract` / venue workflow plan |
| design `ArtifactPackage` | `PaperArtifactPackage` with PDF/source zip/checksums |
| visual review gates | source, compile, anonymity, evidence, proof, reproducibility gates |
| design refpack/taxonomy | citation corpus, claim evidence, proof obligations |
| provider/model spend route | paper research/proof worker contract |
| customer message | cover letter / venue form packet |
| acceptance/payment/deployment | submission receipt, venue proof, archive, reconciliation |
| ZBJ/EPWK/Hepta routes | paper adapter routes |

Design modules stay in `core/` but are disabled by non-use. The paper CLI must
not route through `core/src/workflow-registry`, design profiles, or design
marketplace adapters.

## Module Boundary

Core module additions should be minimal and only in `paper-core/`:

- `PaperTask`
- `PaperArtifactPackage`
- `PaperWorkflowState`
- paper action manifest
- paper handoff envelope
- paper dry-run receipt
- venue state proof
- batch report renderer
- contract/hash helpers

Everything with paper-domain behavior should be a plugin/external adapter:

- inventory adapter
- LaTeX build adapter
- package adapter
- research/claim/proof verification adapter
- referee revision adapter
- venue submission adapter
- future live executor adapter

Do not migrate these directly:

- giant `bin/paperctl` workflow logic
- stale latest-report readers
- capstone-only reports
- roadmap-only reports
- duplicate gate/matrix modules
- one-off blocker closure scripts

## Target Paper Workflow

Pre-production proposal chain:

```text
PaperIdeaBrief
-> DisciplineProfileResolver
-> VenueTargetProfile
-> PaperProposalGenerationManifest
-> PaperProposalEnvelope
-> PaperProposalGenerationReceipt
-> PaperProposalReviewGate
-> PaperProductionPlanEnvelope
-> ManuscriptSourceContract
-> PaperTaskCreationEnvelope
-> PaperProposalSeedContractBundle
-> PaperProposalStagingRecord
```

This chain replaces the old design-core pattern of selecting a design scenario,
loading a style prompt, and producing a design plan. In paper production it
selects a discipline profile, target-venue profile, proposal template, and
review gate before any `PaperTask` or source skeleton may be created.
Only an explicitly approved proposal may materialize a runtime source skeleton
and `PaperTask` draft; that materialization does not write the legacy registry
or submit externally. Materialization also writes a proposal-derived seed bundle
for claim/proof/evidence/reproducibility contracts; research verification marks
that state as `proposal_seed_present`, not `verified`. A second explicit staging
switch may write a `PaperProposalStagingRecord` under
`runtime/proposal-staging/`; inventory reads that as `proposal_staging` and
still leaves `paper_factory.sqlite` and YAML registry files untouched.

Full target chain:

```text
PaperIdeaBrief
-> PaperProposalEnvelope
-> PaperProductionPlanEnvelope
-> proposal approval boundary
-> proposal inventory staging boundary
PaperTask
-> ManuscriptSource
-> PaperProfileContract
-> PaperProposalSeedContractBundle
-> ClaimScopeContract
-> ProofObligationContract
-> EvidenceMatrixContract
-> ReproducibilityContract
-> PaperBuildArtifactAcceptance
-> RefereeReviewReport
-> PaperProductionGate
-> PaperArtifactPackage
-> SubmissionPreflight
-> WarningReview
-> ReleaseArchive
-> VenueSubmissionPlan
-> SubmissionApprovalPacket
-> FreshVenueEvidenceBundle
-> ReviewedSubmitPreflightPacket
-> SubmissionActionManifest
-> SubmissionHandoffEnvelope
-> SubmissionReplayGuard
-> ExternalExecutorHandoffOutbox
-> ExternalSubmissionReceipt
-> VenueStateProof
-> SubmissionAuditArchive
-> Reconciliation
```

Current implemented cut:

```text
PaperIdeaBrief
-> PaperProposalGenerationManifest
-> PaperProposalEnvelope
-> PaperProposalGenerationReceipt
-> PaperProposalReviewGate
-> PaperProductionPlanEnvelope
-> ManuscriptSourceContract
-> PaperTaskCreationEnvelope
-> PaperProposalSeedContractBundle
-> PaperProposalStagingRecord
PaperTask
-> PaperWorkflowState
-> proposal_seed_present research gate
-> PaperBuildArtifactAcceptance
-> PaperArtifactPackage
-> VenueSubmissionPlan
-> ReviewedSubmitPreflightPacket
-> PaperActionManifest
-> PaperHandoffEnvelope
-> PaperAdapterRunReceipt
-> VenueStateProof
-> SubmissionAuditArchive
```

## Migration Phases

### Phase 0: Core Freeze

Goal: keep hepta core clean.

- preserve `diff -qr hepta-source core/ == 0`
- keep paper work in `paper-core/` and `paper-adapters/`
- document every intentional boundary exception

Exit criteria:

- paper selftest passes
- core diff remains zero
- paper CLI imports no old workflow control plane

### Phase 1: Paper Overlay Skeleton

Goal: create a paper-native workflow shell.

- add paper channel/product/profile/action IDs
- define paper manifest, handoff, receipt, proof objects
- keep live submission blocked by policy

Exit criteria:

- `paper-production-core batch-run --mode inventory` works
- local dry-run can create paper receipts/proofs
- no external action is possible from default commands

### Phase 2: Canonical Paper State

Goal: make batch state reliable.

- define exact source classes: directory source, source zip, package source,
  generated runtime source
- define blocker families: source, build, package, research, venue, runner,
  authorization, submission
- render one batch table as the operator truth

Exit criteria:

- report shows all papers, next action, auto level, and blocker family
- fixture/shadow rows are quarantined by default
- SQLite is primary inventory with YAML fallback/export

### Phase 3: Inventory Plugin

Goal: turn old registry/assets into clean `PaperTask` inputs.

- read `paper_factory.sqlite` first
- fallback to `registry/*.yaml`
- scan drafts, submission, workspaces, templates, artifacts
- resolve venue/workflow metadata
- keep quarantine rules for fixtures, runtime junk, logs-only rows

Exit criteria:

- inventory count is stable and explainable
- quarantined rows are listed separately
- old `paperctl` is not imported

### Phase 4: Build/Package Plugin

Goal: produce immutable local packages without mutating sources.

- plan or run LaTeX builds under runtime output only
- discover or create PDF/source zip
- write `PACKAGE_RECORD.json`
- write `SHA256SUMS.txt`
- attach package hashes to `PaperArtifactPackage`
- add source zip path-safety checks

Exit criteria:

- every package-ready paper has runtime package record and checksums
- package blocker family identifies missing PDF/source zip/main tex
- repeated dry-runs are idempotent

### Phase 5: Research/Verify Plugin

Goal: replace filename scans with typed verification.

- define `ClaimScopeContract`
- define `ProofObligationContract`
- define `EvidenceMatrixContract`
- integrate only reusable `research_compute` workers
- reject report-only/capstone modules
- output machine-readable verification receipts

Exit criteria:

- each claim has evidence/proof status
- unverifiable claims block with precise reason
- verification results are hash-bound to package and source state

### Phase 6: Referee Revision Plugin

Goal: make reviewer revision a first-class workflow.

- model reviewer comments as issue queue
- generate patch plan
- preview patch application
- compile/package after patch
- require rollback ledger for mutating mode

Exit criteria:

- dry-run revision plan exists without source mutation
- explicit execute mode records rollback and package diffs
- every revised package re-enters Phase 4/5 gates

### Phase 7: Runner Handoff

Goal: close the hepta-style runtime handoff chain for paper.

- create submission action manifest
- create paper handoff envelope
- add replay guard
- add outbox/ledger compatible with external runner shape
- store dry-run adapter receipt
- store venue state proof

Exit criteria:

- `local-dry-run` records receipt and proof
- replayed dry-run does not duplicate external action
- reports expose receipt/proof/archive hashes

### Phase 8: Submission Lifecycle

Goal: prepare reviewed submission without making live actions implicit.

- build agent-owned `SubmissionApprovalPacket`
- gather fresh venue evidence
- build venue form packet and cover letter draft
- require agent approval for `reviewed-submit`
- keep live executor separate from local build/package

Exit criteria:

- reviewed-submit is blocked until an approval packet exists and is accepted by
  the agent
- live executor cannot run from local dry-run mode
- every attempted external action has receipt/proof/archive/reconciliation

### Phase 9: Legacy Paper Factory Cleanup

Goal: shrink old paper_factory into domain assets plus plugins.

- keep data, drafts, submission assets, templates, real workers
- move reusable logic behind adapters
- quarantine capstone/matrix/report-only control-plane code
- stop using giant CLI as production entrypoint

Exit criteria:

- primary operator entrypoint is `paper-production-core`
- old commands are either adapter internals, archived, or blocked
- batch report answers what each paper can do next

### Phase 10: Local Readiness Closure

Goal: remove generic local blockers and classify non-automatic cases.

- bind package adapter to SQLite `submissions` / `artifacts` records
- resolve `artifact_package_not_submit_ready` when PDF/source zip already exist
- classify missing venue as `needs_venue_decision`
- classify missing source/main tex as `source_adapt_required`
- classify archival/non-submission assets as `non_submission_archive`

Exit criteria:

- `local-dry-run` has zero generic blockers
- active submission candidates are separated from manual venue/source decisions
- non-submission archive rows do not pollute production readiness

### Phase 11: Referee Revision Preflight

Goal: make revision execution auditable before any patch is applied.

- keep per-paper issue queue and dry-run patch plan
- add `RefereeRevisionPatchExecutionPreflight`
- add `RefereeRevisionRollbackLedgerDraft`
- keep non-dry-run execution blocked until explicit rollback ledger execution

Exit criteria:

- open referee issues have preflight and rollback ledger draft hashes
- no source mutation occurs in dry-run
- later execute mode has a clear rollback contract

### Phase 12: Research Worker Bridge Receipts

Goal: bind typed research contracts to reusable local workers without importing
old control-plane code.

- discover local `research_compute_*` worker files read-only
- exclude capstone/matrix/submission/portal/executor/patch/apply/merge modules
- emit `PaperResearchWorkerBridgeReceipt` for claim/proof/evidence/reproducibility roles
- bind worker path/hash to typed contract hashes and evidence refs

Exit criteria:

- every local-dry-run paper has typed contracts plus worker bridge receipts
- worker discovery does not import or execute old modules
- reports expose worker catalog size and receipt count

### Phase 13: Reviewed-Submit Preflight Summary

Goal: make the live-submit boundary explicit and operator-readable.

- summarize approval packets
- summarize fresh venue evidence bundles
- summarize external executor outbox items
- count approval-required and live-executor boundary blockers
- prove external actions performed remain zero

Exit criteria:

- `reviewed-submit` report has `summary.submissionPreflight`
- all live-submit candidates are blocked only by approval/executor boundary
- no upload/email/portal/submit occurs inside overlay

### Phase 14: Manual Decision Packets

Goal: turn remaining local manual decisions into auditable packets without
pretending the overlay can choose for the operator.

- add `venue-resolve` mode for papers with `needs_venue_decision`
- add `VenueResolutionPacket` with candidate venues, blockers, warnings, and
  decision options
- add `SubmitReadyPackagePlan` for venue rows that are not yet submit-ready
- add `VenueRegistryAddPlan` for rows that need a new/manual venue target
- add `source-adapt` mode for papers with `source_adapt_required`
- add `SourceAdaptationPacket` with tex/pdf/code candidates and decision options
- keep registry/source mutation disabled

Exit criteria:

- `credit_card` has a manual venue decision packet
- `token_flow` has a submit-ready package and is waiting on manual venue decision
- `credit_card` has a registry-add plan, but no registry mutation
- `token_flow` has a submit-ready package record generated under runtime
- `Autoencoder-Asset-Pricing-Models-main` is recognized as PDF/code project
  without manuscript tex source

### Phase 15: Referee Execute Plan

Goal: move from rollback draft to apply-ready design without applying patches.

- record target-path preimage hashes in `RefereeRevisionPreimageSnapshotLedger`
- add `RefereeRevisionExecutePlan`
- add `RefereeRevisionApplyModeContract`
- keep source mutation disabled until an explicit apply mode exists
- require re-entry through build/package/research gates after future execution

Exit criteria:

- all open referee-revision papers have preimage snapshot ledgers
- all open referee-revision papers have execute plans
- all open referee-revision papers have apply-mode contracts controlled by the
  agent approval gate
- execute plans are plan-only and require explicit apply mode

### Phase 16: Referee Agent Apply Approval Intake

Goal: make the agent apply decision hash-bound before any source mutation.

- add `RefereeApplyApprovalPacket`
- bind issue queue, patch plan, execution preflight, rollback ledger draft,
  preimage snapshot ledger, execute plan, apply-mode contract, and execute
  design packet hashes
- expose required agent approval inputs for accepted hashes, target paths,
  preimage hashes, worktree scope, and rollback restore confirmation
- keep approval intake separate from any patch executor or source mutation

Exit criteria:

- all open referee-revision papers have apply approval packets
- all apply approval packets are completed by the agent when their hash chain
  and preimage gates are ready
- approval packets grant no in-overlay source mutation authority
- future patch execution must produce separate applied-patch and post-repair
  receipts before any issue can be marked resolved

### Phase 17: Referee Patch Apply Execution And Invocation

Goal: define the patch-apply execution surface and let the agent invoke it
only when patch inputs validate cleanly.

- add `RefereePatchApplyExecution`
- add `RefereePatchApplyInvocation`
- consume `RefereeApplyApprovalPacket`, execute design packet, apply-mode
  contract, execute plan, and preimage snapshot ledger
- list planned patch inputs, target preimages, required execution order, and
  blocked post-apply actions
- keep `RefereePatchApplyExecution` as the ready boundary after agent approval
- make `RefereePatchApplyInvocation` record whether `--execute` was requested
  and validate patch hashes, target scope, target preimages, and clean
  `git apply --check`
- in execute mode, generate a current-source `RefereeAgentRepairPatchBundle`
  under runtime and prefer it over stale legacy patch-queue entries
- apply patches only when every validation record is clean; otherwise record the
  blocked invocation and write no source path

Exit criteria:

- all open referee-revision papers have patch-apply execution boundary records
- all open referee-revision papers have patch-apply invocation records
- without `--execute`, invocation records are blocked by explicit invocation
  requirement
- with `--execute`, stale or non-clean patch queues are blocked by validation
  records before source mutation
- with `--execute`, agent-generated current-source patches can apply and record
  applied-patch receipts without external actions
- downstream issue resolution and package replacement stay blocked until an
  applied-patch receipt and post-repair gate recheck exist

### Phase 18: Referee Applied Patch Receipt Gate

Goal: require a real applied-patch receipt before any post-repair state can
advance.

- add `RefereeAppliedPatchReceipt`
- consume `RefereePatchApplyExecution`, `RefereePatchApplyInvocation`, apply
  approval packet, patch plan, and preimage snapshot ledger
- enumerate expected receipt fields: executor id, applied patch input hashes,
  accepted preimages, postimage hashes, source mutation diff hash, build/package
  recheck results, research recheck result, and rollback reconciliation result
- keep receipt blocked while patch apply invocation is not applied
- block post-repair package, issue resolution proof, and reviewed-submit
  advancement until the receipt is recorded

Exit criteria:

- all open referee-revision papers have applied-patch receipt gate records
- all applied-patch receipt gates are blocked while apply invocation is blocked
- no fake applied receipt is accepted
- no issue can be marked resolved without a real postimage-backed receipt

### Phase 19: Referee Post-Repair Build Package Gate

Goal: prevent repaired-package creation until apply receipt and post-repair
checks exist.

- add `PostRepairBuildPackage`
- consume `RefereeAppliedPatchReceipt` and the patch-apply execution boundary
- require applied patch receipt, postimage snapshot, LaTeX build recheck,
  package record rewrite, SHA256 rewrite, research verify recheck, and rollback
  ledger reconciliation
- add `PostRepairRecheckReport` with build, package, and research recheck
  records produced by the local agent executor
- use the repaired target tex for build rechecks when it differs from the
  registry `main_tex`
- block repaired package writes while the applied patch receipt is not recorded
- keep issue resolution proof and reviewed-submit advancement blocked until a
  repaired package is ready

Exit criteria:

- all open referee-revision papers have post-repair build package gates
- all gates are blocked by missing applied-patch receipt by default
- after applied-patch receipts, all local rechecks can pass and make
  `PostRepairBuildPackage` ready
- no repaired package is written from an unexecuted repair plan
- no current submit-ready package can be replaced without post-repair rechecks

### Phase 20: Referee Issue Resolution Proof Gate

Goal: prevent referee issues from being marked resolved until repaired package
proof exists.

- add `RefereeIssueResolutionProof`
- consume `PostRepairBuildPackage` and `RefereeAppliedPatchReceipt`
- require issue-to-patch mapping, issue-to-repaired-artifact mapping, build
  recheck receipt, research recheck receipt, and agent/reviewer acceptance
- generate one runtime resolution evidence mapping per open referee issue after
  post-repair package rechecks pass
- block issue closure while the post-repair package is not ready
- keep SQLite issue/patch status mutation disabled in the overlay

Exit criteria:

- all open referee-revision papers have issue-resolution proof gates
- all gates are blocked by missing post-repair package by default
- after post-repair package readiness, all open issues can receive
  hash-bound issue-resolution evidence and move the proof gate to ready
- no issue can be marked resolved from a plan-only repair
- reviewed-submit readiness cannot advance from unresolved repair proofs

### Phase 21: Referee Repair Reconciliation Gate

Goal: prevent repair-complete and submission-ready states until resolution proof
is ready.

- add `RepairReconciliation`
- consume `RefereeIssueResolutionProof`, `PostRepairBuildPackage`, and
  `RefereeAppliedPatchReceipt`
- require rollback ledger reconciliation, issue queue update receipt, patch
  queue update receipt, submission-readiness reentry gate, and repair audit
  archive record
- generate issue queue update, patch queue update, submission-readiness reentry,
  and repair audit archive receipts
- block reviewed-submit advancement while issue-resolution proof is not ready
- keep SQLite mutation and submission-readiness advancement disabled until the
  state mutation executor consumes a ready reconciliation receipt

Exit criteria:

- all open referee-revision papers have repair reconciliation gates
- all gates are blocked by missing issue-resolution proof by default
- after issue-resolution proof readiness, repair reconciliation can become
  ready without performing external actions
- no repair loop can be marked complete from blocked proof/package/receipt
- no repaired paper can reenter reviewed-submit readiness without reconciliation

### Phase 22: Referee Repair State Mutation Executor

Goal: close the repaired issue/patch state only after repair reconciliation is
ready.

- add `RepairStateMutationReceipt`
- consume `RepairReconciliation`, `RefereeIssueResolutionProof`, and
  `RefereeAppliedPatchReceipt`
- update only the mapped `referee_revision_requests` rows to `resolved`
- record the agent-generated repair patch bundle as an applied `patch_queue` row
  without rewriting stale legacy patch rows
- rebuild final `RepairReconciliation` with the state mutation receipt hash
- release reviewed-submit dry-run readiness while keeping external actions
  disabled

Exit criteria:

- mapped referee issue rows are resolved idempotently
- agent repair patch rows are inserted or updated idempotently
- rerunning referee-revise after mutation reports zero open referee issues
- reviewed-submit dry-run preflight can run for repaired papers
- no live submit or external executor action is performed

### Phase 23: Reviewed-submit Agent Approval And Controlled Executor Receipt

Goal: let reviewed-submit leave the preflight-blocked state once local package,
fresh venue evidence, and agent approval are all present, while still preventing
implicit live submission.

- make reviewed-submit `SubmissionApprovalPacket` agent-owned
- remove the artificial `explicit_reviewed_submit_approval_required` blocker
  when agent approval and hash-bound package/evidence are present
- allow `ReviewedSubmitPreflightPacket` to become ready for the controlled
  external-executor boundary
- add `ControlledExternalExecutorReceipt`
- keep `externalActionPerformed=false` and `liveSubmitPerformed=false`
- keep any real portal/email/API submit as a later executor outside the overlay

Exit criteria:

- reviewed-submit summary reports agent approvals for all ready candidates
- reviewed-submit preflight packets are ready rather than approval-blocked
- controlled executor receipts are recorded
- live-submit/external-action counters remain zero

### Phase 24: Agent Referee Review Intake And Issue Materialization

Goal: let hepta-paper generate a referee-style issue queue from a paper source
before invoking the already closed referee-revise loop.

- add `RefereeReviewIntake`
- add `AgentRefereeReviewReport`
- add `RefereeIssueQueueMaterialization`
- add `referee-review` batch mode
- make dry-run review read only and deterministic
- make `--execute` insert only new `referee_revision_requests` rows
- keep source mutation in the existing `referee-revise --execute` path
- keep model calls and external actions disabled

Exit criteria:

- review reports are hash-bound to the source `main.tex`
- issue materialization is idempotent by request key
- inserted review issues can be consumed by `referee-revise`
- review mode writes no source and performs no external action

### Phase 24B: Referee Autopilot Accept Loop

Goal: restore the design-production-core style continuous referee loop inside
hepta-paper instead of running only one review/revise pass.

- add `journal-manage` journal/conference system packets:
  `JournalConferenceRegistry`, `TargetSelectionPolicy`,
  `JournalTargetProfile`, `VenueRubricManager`, `FreshRefereePool`,
  `VenueEvidenceGate`, and `VenueLifecyclePolicy`
- bind proposal-stage papers to a target journal/conference before production
- populate the registry with mainstream top journals and curated top CS
  conferences across ML, CV, NLP, DB, systems, security, theory, PL/SE, HCI,
  graphics, architecture, robotics/control, statistics, OR, optimization,
  economics, finance, UTD24 business journals, and the four flagship pure math
  journals; broad AI venues with weaker fit such as AAAI/IJCAI and finance
  outlets removed from the target set such as JFQA are not selectable targets
- auto-select primary and backup targets from idea/discipline/title when the
  proposal does not specify a venue, while preserving explicit venue requests
- run auto-selected CS conference targets through an agent deadline-routing
  assessment using structured venue deadline calendars. If the next conference
  deadline is beyond the configured agent window, the primary target is routed
  to a same-field journal fallback and the original conference is recorded as
  `preDeadlinePrimaryTarget`. Explicit venue requests are preserved and only
  record deadline risk.
- add `referee-autopilot` batch mode
- iterate `referee-review` -> `referee-revise` -> local package/recheck ->
  reviewed-submit handoff -> fresh target-journal referee verdict
- keep looping while new/open referee issues remain or the fresh referee verdict
  is `revise`
- require `FreshRefereeVerdict=accept` before accept
- emit `RefereeAutopilotRoundReceipt` and
  `RefereeAutopilotAcceptanceReceipt`
- preserve the live external submission boundary

Exit criteria:

- `referee-autopilot --execute --max-rounds N` records accept or blocked
  receipts
- accepted papers have a target-journal profile, target-selection policy, ready
  venue rubric, fresh referee pool, venue evidence gate, lifecycle policy, fresh
  referee accept verdict, and zero open referee issues
- proposal reports record whether target selection was operator-requested or
  agent-auto-selected from the idea
- auto-selected conference targets record `agentDeadlineRoutingDecision`; a far
  CS conference deadline routes to a journal fallback without regex-based venue
  routing
- reviewed-submit preflight and controlled executor receipt are ready
- proposal-seed-only papers remain blocked until real research evidence exists
- external-action counters remain zero

### Phase 25: Paper Factory Retirement Audit And Migration Plan

Goal: make full retirement of the legacy `paper_factory` executable control
plane repeatable, auditable, and incremental.

- upgrade `legacy-cleanup` from a coarse cleanup scan to a retirement audit
- map every scanned legacy file to a disposition, target hepta adapter,
  migration action, priority, and retirement wave
- group detailed retirement tracks into the seven planned waves from
  `paper-factory-retirement-migration-plan.md`
- emit hash-bound runtime packets for entrypoint deprecation, data asset export,
  migration backlog, quarantine, each retirement wave, and final retirement
  readiness
- execute mode records hepta runtime receipts for Wave 0 entrypoint freeze,
  Wave 1 data asset export, P0/P1 semantic migration drain, Wave 2/3/4
  migration coverage, live external executor policy, Wave 5 quarantine
  isolation, Wave 6 old-control-plane removal, and per-wave execution status
- split useful migration candidates from quarantine/retire-only control-plane
  artifacts
- detect current hepta adapter coverage
- publish `paper-factory-retirement-migration-plan.md`
- keep the audit read-only; no legacy deletion or external action

Exit criteria:

- audit reports `byDisposition`, `byTargetAdapter`, `byMigrationAction`,
  `byRetirementWave`, and `byPriority`
- P0 legacy entrypoints are visible
- P1 useful migration candidates are queued by target adapter
- seven wave packets are present and hash-bound
- seven wave execution receipts are present and hash-bound in execute mode
- P0/P1 backlog has hash-bound semantic migration claims and active blocker
  counts
- final `PaperFactoryRetirementReadinessGate` is present, hash-bound, and ready
  only after the local live-executor policy receipt is consumed
- report-only/capstone/matrix/LLM/manual chains are marked non-migration
- full retirement blockers are explicit; current runtime retirement remains
  local-only and performs no destructive deletion or live external action

### Phase 26: Empirical Analysis System

Goal: produce local empirical support when a venue evidence gate requires real
empirical evidence and the manuscript currently has only proposal seed
contracts.

Implemented contracts:

- `EmpiricalBenchmarkRegistry`
- `BenchmarkSuiteSelectionPolicy`
- `EmpiricalAnalysisPlan`
- `DatasetAccessContract`
- `DatasetLicenseProvenanceGate`
- `TableFigureSpec`
- `ExperimentCodePatchBundle`
- `SandboxExecutionPlan`
- `ExperimentRunReceipt`
- `ResultArtifactPackage`
- `EmpiricalEvidenceGate`
- `ManuscriptEmpiricalPatch`
- `ManuscriptEmpiricalApplyApprovalPacket`
- `ManuscriptEmpiricalApplyPlan`
- `ManuscriptEmpiricalApplyReceipt`

Execution boundary:

- generated code is written only under
  `runtime/empirical-analysis/<paper>/experiments/`
- a local agent selection policy chooses a domain benchmark suite from the
  empirical benchmark registry using paper/source/venue profile evidence; the
  initial registry covers RL/control, ML, econometrics, finance, and
  operations/optimization suites
- authorized local benchmark data can be bound with `--dataset-root` and
  `--benchmark-id`; the resulting `LocalBenchmarkRegistry` records local file
  hashes, a primary dataset, and an optional `BENCHMARK_REGISTRY.json` manifest
- `DatasetLicenseProvenanceGate` binds authorized local data or generated-data
  provenance before evidence can pass
- `TableFigureSpec` records the expected table and figure artifacts for the
  selected suite
- if no authorized local dataset is bound, generated/synthetic data and result
  artifacts are explicitly labeled as local generated evidence
- every run records command, runtime, stdout/stderr, exit code, and artifact
  hashes plus table and figure specs
- manuscript source mutation is disabled by default; `--apply-manuscript`
  requires a ready empirical evidence gate, records an apply approval packet and
  apply plan, copies table/figure adjuncts into `sourceWorkspace/empirical/`,
  and inserts or replaces a marker-delimited TeX block
- no external data lookup, model call, network action, portal/email/API action,
  or live submission is performed

Autopilot integration:

- `referee-autopilot --execute` reruns `research-verify` with runtime empirical
  evidence
- if research status is not `evidence_present`, autopilot can run
  `empirical-analysis` with the supplied local benchmark registry, then rerun
  `research-verify`
- if `--apply-manuscript` is set and the empirical apply receipt is recorded,
  autopilot rebuilds, repackages, reruns `research-verify`, and then asks the
  fresh referee
- fresh referee accept still requires venue evidence gate readiness, lifecycle
  policy readiness, submit-ready package, zero findings, zero open issues, and a
  controlled executor receipt

## Replacement Policy For Design Plugins

Design plugins should not be deleted from `core/`. They should be replaced in
the active paper workflow by paper plugins:

- design adapter registry becomes paper adapter registry
- design product profiles become paper profiles
- design refpack becomes citation/evidence/proof corpus
- design review becomes compile/evidence/reproducibility/referee gates
- design external lifecycle shape is retained for paper submission lifecycle

This keeps hepta update compatibility while making paper workflow domain-native.

## Operator Modes

The intended entrypoints are:

```bash
paper-production-core batch-run --mode inventory
paper-production-core batch-run --mode local-build
paper-production-core batch-run --mode local-package
paper-production-core batch-run --mode journal-manage
paper-production-core batch-run --mode empirical-analysis --dataset-root PATH --benchmark-id ID
paper-production-core batch-run --mode venue-resolve
paper-production-core batch-run --mode source-adapt
paper-production-core batch-run --mode referee-review
paper-production-core batch-run --mode referee-revise
paper-production-core batch-run --mode referee-autopilot --max-rounds 6
paper-production-core batch-run --mode local-dry-run
paper-production-core batch-run --mode reviewed-submit
```

Default modes are local and safe. Live submission must be a later explicit
external executor with a separate approval packet.

## Current Status

Implemented:

- Phase 1 overlay skeleton
- Phase 2 first canonical state and batch table
- Phase 3 SQLite inventory, YAML fallback, quarantine
- Phase 4 package record/checksum output
- Phase 5 typed claim/proof/evidence/reproducibility contracts and verify
  receipt
- Phase 6 referee revision issue queue, dry-run patch plan, and rollback
  boundary
- Phase 7 replay guard, external executor outbox, receipt inbox, venue proof,
  archive, and reconciliation
- Phase 8 agent approval packet, fresh venue evidence bundle, and reviewed-submit
  approval boundary
- Phase 9 read-only legacy cleanup audit
- Phase 10 local readiness closure and submission intent classification
- Phase 11 referee patch execution preflight and rollback ledger draft
- Phase 12 research worker bridge receipts
- Phase 13 reviewed-submit operator preflight summary
- Phase 14 venue/source manual decision packets
- Phase 15 referee preimage snapshot ledger, execute plan, and apply-mode
  contract
- Phase 16 referee agent apply approval intake
- Phase 17 referee patch apply execution and invocation
- Phase 18 referee applied patch receipt gate
- Phase 19 referee post-repair build package gate
- Phase 20 referee issue resolution proof gate
- Phase 21 referee repair reconciliation gate
- Phase 22 referee repair state mutation executor
- Phase 23 reviewed-submit agent approval and controlled executor receipt
- Phase 24 agent referee review intake and issue materialization
- Phase 25 paper_factory retirement audit and migration plan
- Phase 26 empirical analysis system

Still needed:

- actual venue selection / registry update for `credit_card`
- actual venue selection / registry update for `token_flow`
- source material decision for `Autoencoder-Asset-Pricing-Models-main`
- optional stronger substantive referee-review heuristics beyond deterministic
  local source inspection
- live submission executor design and real portal/email/API execution outside the
  overlay
- legacy cleanup after adapters stabilize and source/venue decisions are made
