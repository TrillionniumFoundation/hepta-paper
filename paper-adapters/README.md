# paper-adapters

This directory holds the paper-native plugin/adapters used by the overlay.

Adapters added here must be thin wrappers over useful `paper_factory` domain
capabilities. They must not import the old report-control-plane as the workflow
source of truth.

Allowed adapter families:

- inventory adapter
- build/package adapter
- research verification adapter
- referee revision adapter
- venue resolution adapter
- source adaptation adapter
- proposal generation adapter
- venue/submission metadata adapter

Current overlay adapters:

- `proposal/`: local deterministic initial-idea to proposal/pre-production
  plan adapter, with idea brief, generation manifest, proposal receipt, review
  gate, and draft production plan. It performs no model call and creates no
  `PaperTask` unless `--approved --materialize-source` is explicitly supplied;
  materialization writes only a local runtime source skeleton and task draft.
  It also writes `PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json`
  from the approved proposal, marked as proposal-derived seed material rather
  than verified research output.
  `--stage-inventory` writes a runtime-only `PaperProposalStagingRecord` that
  inventory can read as `inventory_source=proposal_staging` without updating
  production registry files.
- `journal-manage/`: journal/conference system manager. Proposal and the local
  diagnostic review loop use it to bind each paper to a target journal/conference,
  select primary and backup targets from a curated top journal/conference
  registry, emit venue rubrics, build fresh referee pools, enforce venue
  evidence gates, and preserve the local-only lifecycle boundary before any live
  submission adapter exists. The registry includes top economics and finance
  journals, the UTD24 business journal set, and the four flagship pure math
  journals; keeps CS targets to top-tier venues; and excludes weaker broad-AI
  targets such as AAAI/IJCAI and removed finance targets such as JFQA. If
  proposal input omits a venue, it
  deterministically auto-selects a primary target from the idea/discipline/title
  and records `selectionMode=agent_auto_selected_from_idea`. Auto-selected CS
  conference targets also pass through an agent deadline-routing assessment:
  when the next structured conference deadline is outside the configured agent
  window, selection routes to a same-field journal fallback and records the
  pre-deadline conference candidate; explicit venue requests are preserved and
  only record deadline risk.
- `inventory/`: read-only scan from the injected native store, standalone
  paper assets, and approved proposal staging records. Legacy SQLite and the
  old worker catalog are not runtime inventory sources.
- `build-package/`: local LaTeX build/package planning with optional runtime
  output under the standalone hepta runtime. Execute mode can write
  `BUILD_ARTIFACT_ACCEPTANCE.json` next to the compiled PDF; the acceptance is
  local-package only and does not authorize live submission.
- `research-verify/`: typed claim/proof/evidence/reproducibility contracts,
  native worker plans/receipts, and a
  verify receipt. For proposal-staged
  papers it reports `proposal_seed_present` until real evidence replaces the
  seed material. It also scans runtime empirical-analysis artifacts when present,
  so a paper can advance to `evidence_present` only after real local run
  receipts and result artifacts exist.
- `empirical-analysis/`: local empirical evidence production adapter. It builds
  an `EmpiricalBenchmarkRegistry`, `BenchmarkSuiteSelectionPolicy`,
  `EmpiricalAnalysisPlan`, `DatasetAccessContract`,
  `DatasetLicenseProvenanceGate`, `TableFigureSpec`,
  `ExperimentCodePatchBundle`, `SandboxExecutionPlan`, `ExperimentRunReceipt`,
  `ResultArtifactPackage`, `EmpiricalEvidenceGate`, and
  `ManuscriptEmpiricalPatch` draft. Execute mode writes generated experiment
  code only under `runtime/empirical-analysis/<paper>/`, selects a domain
  benchmark suite from paper/source/venue profile signals, can consume an
  explicit local benchmark directory through `--dataset-root` /
  `--benchmark-id`, and falls back to generated/synthetic data when no
  authorized local data is bound. Every run records stdout/stderr/exit
  code/artifact hashes plus table/figure specs. By default it writes only a
  manuscript patch draft; `--apply-manuscript` adds a controlled
  approval/plan/receipt boundary, copies table/figure adjuncts into the source
  workspace, and applies a marker-based idempotent TeX block. It never accesses
  the network, calls a model, performs external actions, or authorizes live
  submission.
  `local-review-loop --execute` can invoke it when venue evidence is missing,
  then rerun `research-verify` before asking a fresh referee.
- `referee-review/`: deterministic local agent referee review intake. It reads
  the current `main.tex`, builds `RefereeReviewIntake` and
  `AgentRefereeReviewReport` contracts, and plans
  `RefereeIssueQueueMaterialization`. With `--execute`, it writes only new
  agent review findings into `referee_revision_requests`; it does not mutate
  source or perform external actions. The resulting issue queue is consumed by
  `referee-revise/`.
- `referee-revise/`: default read-only referee issue queue, dry-run patch plan,
  execution preflight, rollback ledger draft, preimage snapshot ledger,
  execute plan, agent-owned apply-mode contract, agent apply approval packet, and
  patch-apply execution boundary plus patch-apply invocation, applied-patch
  receipt, post-repair package gate, issue-resolution proof gate, and repair
  reconciliation gate. With `--execute`, it generates a fresh runtime
  `RefereeAgentRepairPatchBundle` against the current source, validates patch
  hashes, target scope, preimages, and `git apply --check`, then applies only
  clean agent-generated repairs. After an applied-patch receipt, execute mode
  runs local post-repair LaTeX build, package rewrite, and research recheck
  receipts before `PostRepairBuildPackage` can become ready. It then generates
  issue-to-patch/artifact/recheck `RefereeIssueResolutionProof` mappings and a
  runtime `RepairReconciliation` receipt. Once reconciliation is ready, execute
  mode writes an idempotent `RepairStateMutationReceipt`, marks only the mapped
  referee issues resolved in SQLite, records the agent patch bundle as an
  applied `patch_queue` row, and releases the paper back to reviewed-submit
  dry-run readiness without performing external actions.
- `local-review-loop`: diagnostic batch-run orchestration mode, not a separate adapter. It
  repeatedly runs `referee-review` -> `referee-revise` -> local
  build/package/research recheck -> reviewed-submit handoff, then asks a fresh
  journal-targeted diagnostic reviewer from the `FreshRefereePool` for a local
  pass/revise result. A local pass is not academic acceptance and grants no
  submission authority. It fail-closes at the max round limit and writes
  `runtime/local-review-loop/<paper>/LOCAL_DIAGNOSTIC_REVIEW_ROUNDS.json` and
  `LOCAL_DIAGNOSTIC_REVIEW_RECEIPT.json`. The old `referee-autopilot` CLI name
  remains a deprecated compatibility alias only.
- `venue-resolve/`: read-only venue decision packets for papers that need
  manual venue selection, including submit-ready package prerequisite plans and
  registry-add plan templates.
- `source-adapt/`: read-only source adaptation packets for papers that need
  manuscript source/main-tex decisions.
- `submission/`: local venue dry-run lifecycle, approval packet, fresh venue
  evidence, replay guard, outbox, receipt inbox, venue proof, archive, and
  reconciliation. Reviewed-submit additionally uses an agent-owned
  `SubmissionApprovalPacket`, emits a hash-bound
  `ReviewedSubmitPreflightPacket`, and records a
  `ControlledExternalExecutorReceipt` boundary without performing a live
  external submission. The native delivery runtime also models dispatch
  authorization, executor response intake, retry/redrive, reconciliation, and
  release locking. `SubmissionExecutorPort` has no provider implementation in
  this repository.

The former `legacy-cleanup/` adapter is retired. Its read-only classification
and matrix audit live under `migration/retirement/`; no production mode can
scan, mutate or execute the removed `paper_factory` tree.

Blocked from direct migration:

- capstone-only modules
- roadmap-only modules
- stale latest-report readers
- duplicated gate/matrix modules
- temporary source/evidence closure report helpers

Legacy catalog and native worker policy:

- adapters must not scan old `paperctl_modules/research_compute_*` workers at
  runtime; their path/hash inventory exists only in frozen migration evidence
- adapters must not import old workers as workflow control plane
- capstone, matrix, submission, portal, executor, patch/apply/merge workers are
  excluded from direct bridge receipts
- native workers use the WorkerRunner/FormalVerifier ports, bounded inputs,
  allowlisted execution, atomic artifact receipts, and no source-apply authority
- any future execute mode must live behind an explicit adapter contract and
  rollback/receipt boundary
