# hepta-paper architecture v3

> Historical architecture rationale. For normative current counts, paths and
> release state, see `CURRENT_STATUS.md`.

## Status

Architecture v3 is a strangler refactor of the existing overlay. It is not a
rewrite and it does not add a live submission executor. The accepted core
baseline, native SQLite store, signed authority chain, and fail-closed
submission boundary remain intact.

The legacy source matrix contains 263 P0/P1 source paths. Fourteen have a
verified behavioral replacement. The other 249 remain retired as source files
and are classified by the capability matrix v3:

- 88 permanent retirements;
- 40 superseded surfaces that require capability-level coverage evidence;
- 121 sources whose business concepts are reimplemented through bounded
  capabilities rather than copied file-for-file.

Matrix state is deliberately split into four independent axes. All 249
decisions are mapped and all 249 contracts are defined; implementation is
verified for the coverage/reimplementation rows and explicitly not applicable
for permanent retirements. Current local-admin versus independent-external
owner status is reported separately in `CURRENT_STATUS.md`; a green technical
test cannot manufacture independent business acceptance.

## Layers

- `workflow-kernel/`: domain-neutral hashing, ordered state transitions,
  stage execution and receipts. It is the small shared runtime kernel; the
  588-file vendored core is an accepted reference fork, not a second active
  paper runtime.
- `paper-domain/`: pure claim, evidence, experiment, research change and
  submission delivery contracts, plus the declarative paper mode graph.
- `paper-application/`: immutable execution context, paper-facing workflow
  adapter, batch composition, reports and stage use cases.
- `paper-ports/`: Store, ArtifactRepository, WorkerRunner, FormalVerifier,
  JobReceiptStore, WorkflowState, SubmissionExecutor, and optional outer
  TaskFlow boundaries.
- `paper-adapters/`: SQLite, filesystem, LaTeX, Lean, research, referee,
  journal, and submission implementations.
- `paper-core/bin/`: CLI argument parsing and application invocation.

The vendored `core/` remains an accepted, hash-bound reference fork. Paper
production hashing and workflow transitions use `workflow-kernel/`; no claim
is made that all 588 vendored files form the running paper kernel.

## Write and execution rules

Production SQLite access goes through the injected `StorePort`. Artifact
writes go through the injected `ArtifactRepository`, declare a scope and role,
are atomic by default, and return a hash-bound receipt. Write, workflow, job,
submission, backup and restore-drill receipts are persisted in the native
receipt ledger. Direct sqlite3 subprocess use outside the SQLite adapter is
reserved for failure/concurrency tests.

`WorkflowStatePort` materializes a hash-bound projection only for executed
workflows. It is derived state, not an independent authority; its ledger
receipt and hepta-native records remain the audit basis. Read-only planning
must not write it, and a stored hash mismatch fails closed.

OpenClaw TaskFlow may coordinate long-lived waits only through the optional
outer adapter. It may own a flow revision, current step, minimal hash-only
state, wait metadata and child-task links. It may not own submission branching,
verify academic or owner evidence, hold keys or provider credentials, unlock a
release, or supersede SQLite and verified receipts. Every resume rebuilds the
domain snapshot and recomputes native gates. See `taskflow-pilot.md`.

Native research execution is plugin-based. The initial worker types are
artifact integrity, CSV descriptive statistics, JSON assertions, and bounded
Lean/Lake verification. Executables, working directories, time, output size,
inputs, and outputs are allowlisted. The OS runner requires a real kernel
sandbox: bubblewrap when permitted, otherwise a pre-provisioned Docker image
with `--network none`, read-only root, dropped capabilities, no-new-privileges,
PID, CPU and memory limits. If neither backend can prove these controls,
execution fails closed.

Research workers never gain source-apply authority. They may produce a
hash-bound `ResearchChangeProposal`; only the repair service may apply an
approved patch under preimage, rollback, proof, and reconciliation controls.

## Submission boundary

`SubmissionDeliveryRuntime` persists dispatch authorization, outbox and inbox,
executor response intake, redrive attempts, dead letters, reconciliation, and
transactional release locks. A submitted response must carry a provider
receipt hash; release also requires a reconciliation hash.
`SubmissionExecutorPort` is only a port. No provider executor implementation is
present in this repository, and all current runs perform zero external actions.

The preferred deterministic review mode is `local-review-loop`. The legacy
`referee-autopilot` CLI spelling is a compatibility alias only. Local
diagnostic pass/revise output is never an academic acceptance and never creates
an academic acceptance receipt.

## Readiness metrics

Legacy worker directory observations are reported as
`legacyCatalogReference`, never as worker execution. Research readiness is
split into contract, evidence-candidate, native-execution, and verified
academic-evidence readiness. These fields must not be collapsed into a single
`researchReady` boolean.

The production runtime no longer scans the old worker catalog. Current
`legacyCatalogReference` counts are zero; frozen catalog hashes remain only in
migration evidence.

## Workspace and retirement boundary

The running repository, paper assets, native database and frozen legacy source
are physically separate:

- repository: `/data/home-data/hepta-paper`;
- paper assets: `/data/home-data/hepta-paper-assets`;
- native runtime/store: `/data/home-data/hepta-paper/runtime`;
- immutable legacy reference: `/data/home-data/hepta-paper-legacy-reference`.

Production defaults resolve to the standalone roots. The online legacy tree
has been physically removed; the immutable reference is retained for audit and
restore. The retirement audit is read-only and no longer appears as a
production batch mode.

## Verification

- `npm run paper:architecture-selftest`
- `npm run taskflow:pilot-selftest`
- `npm run coverage:architecture`
- `npm run coverage:critical-modules`
- `npm run test:migration-differential` when the frozen legacy source is
  available beside this workspace
- `npm run release:verify` for the complete local release gate

The portable CI gate verifies the accepted core, runtime harness, architecture
contracts, capability matrix, coverage threshold, and hash bindings of the
legacy differential tests. The differentials themselves remain a local release
gate because the frozen legacy source is intentionally not copied into this
repository.
