# hepta-paper architecture v3

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
verified for the 161 coverage/reimplementation rows and explicitly not
applicable for the 88 permanent retirements. All 249 owner-acceptance records
remain pending until a named owner explicitly accepts the decision. A green
technical test cannot manufacture business acceptance.

## Layers

- `workflow-kernel/`: domain-neutral hashing, ordered state transitions,
  stage execution and receipts. It is the small shared runtime kernel; the
  588-file vendored core is an accepted reference fork, not a second active
  paper runtime.
- `paper-core/src/workflow-engine.mjs`: paper-facing workflow-kernel adapter.
- `paper-core/src/mode-registry.mjs`: declarative paper mode and stage graph.
- `paper-core/src/execution-context.mjs`: immutable execution options and
  injected services.
- `paper-domain/`: pure claim, evidence, experiment, research change, and
  submission delivery contracts.
- `paper-application/`: batch composition plus stage use cases. Stage handlers
  and the local diagnostic review loop no longer live in the batch runner.
- `paper-ports/`: Store, ArtifactRepository, WorkerRunner, FormalVerifier,
  JobReceiptStore, and SubmissionExecutor boundaries.
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
- frozen legacy archive: `/data/home-data/paper_factory`.

Compatibility symlinks preserve old asset paths for non-control-plane tools,
but production defaults resolve to the standalone roots. Both legacy
entrypoints have executable bits removed, all seven wave receipts are
recorded, and freeze, quarantine-isolation and active-control-plane removal
receipts are recorded. No destructive source deletion was performed. Archive
readiness is not functional parity and does not replace owner acceptance.

## Verification

- `npm run paper:architecture-selftest`
- `npm run coverage:architecture`
- `npm run test:migration-differential` when the frozen legacy source is
  available beside this workspace
- `npm run release:verify` for the complete local release gate

The portable CI gate verifies the accepted core, runtime harness, architecture
contracts, capability matrix, coverage threshold, and hash bindings of the
legacy differential tests. The differentials themselves remain a local release
gate because the frozen legacy source is intentionally not copied into this
repository.
