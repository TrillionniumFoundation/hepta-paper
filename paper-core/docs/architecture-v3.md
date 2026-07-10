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

All 249 owner-acceptance records remain pending until a named owner explicitly
accepts the decision. A green technical test cannot manufacture business
acceptance.

## Layers

- `paper-core/src/workflow-engine.mjs`: domain-neutral ordered stage execution
  and stage receipts.
- `paper-core/src/mode-registry.mjs`: declarative paper mode and stage graph.
- `paper-core/src/execution-context.mjs`: immutable execution options and
  injected services.
- `paper-domain/`: pure claim, evidence, experiment, research change, and
  submission delivery contracts.
- `paper-application/`: use cases such as restricted research-gap planning.
- `paper-ports/`: Store, ArtifactRepository, WorkerRunner, FormalVerifier,
  JobReceiptStore, and SubmissionExecutor boundaries.
- `paper-adapters/`: SQLite, filesystem, LaTeX, Lean, research, referee,
  journal, and submission implementations.
- `paper-core/bin/`: CLI argument parsing and application invocation.

The vendored `core/` remains an accepted, hash-bound fork. Architecture v3
does not claim that the paper overlay currently consumes all 588 vendored core
files as its runtime kernel.

## Write and execution rules

Production SQLite access goes through `StorePort`. Artifact writes go through
`ArtifactRepository`, declare a scope and role, are atomic by default, and
return a hash-bound receipt. Direct sqlite3 subprocess use is reserved for the
concurrency failure test.

Native research execution is plugin-based. The initial worker types are
artifact integrity, CSV descriptive statistics, JSON assertions, and a bounded
Lean verifier. Executables, working directories, time, output size, inputs,
and outputs are allowlisted. The local command runner records that kernel-level
network isolation is not yet independently verified; it must not overclaim a
sandbox guarantee.

Research workers never gain source-apply authority. They may produce a
hash-bound `ResearchChangeProposal`; only the repair service may apply an
approved patch under preimage, rollback, proof, and reconciliation controls.

## Submission boundary

`SubmissionDeliveryRuntime` models dispatch authorization, executor response
intake, redrive, dead-letter policy inputs, reconciliation, and release locking.
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
