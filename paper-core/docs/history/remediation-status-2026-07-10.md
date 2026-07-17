# Hepta-paper remediation status — 2026-07-10

## Release decision

`No-Go` for real external submission. Local inventory, build/package smoke, and
dry-run orchestration remain available.

## Final P0/P1/P2 architecture pass

- Capability v3 now reports four separate state axes: `decision_mapped=249`,
  `contract_defined=249`, `implementation_verified=161`,
  `implementation_not_applicable=88`, `operationally_proven=0`, and
  `owner_accepted=0`. The old mixed `coverageStatus` field is not used.
  `implementation_verified` now requires an executed ledger receipt binding
  the passing test hash and current target hashes; file/test presence alone
  cannot set it. Conformance does not imply production operation.
- Fourteen capability families have their own conformance suite. It currently
  runs 15 tests, including the 40 capability-level coverage obligations and a
  real OS-sandbox execution when a local kernel backend is available.
- Batch service bootstrap, state projection and report writing are separate
  application modules. Stage handlers are in `paper-application/use-cases/`,
  and the local diagnostic loop delegates each round to a ledger-backed round
  executor. The batch application retains composition and inventory iteration.
- Store, artifact repository, clock, hasher, authority verifier, receipt
  ledger, job store and submission delivery store are injected through one
  `ExecutionContext`. Non-persistence adapters no longer construct SQLite
  stores.
- Schema v2 persists receipt ledger, idempotent jobs, leases, attempts,
  classified failures, submission outbox/inbox, redrive/dead-letter state and
  release locks. Backup and restore-drill receipts also enter the ledger.
- ClaimGraph validation, byte/hash/provenance evidence verification, formal
  experiment aggregation and Lake certificate/replay checks are implemented.
- Artifact storage is content-addressed with immutable manifests, retention/GC
  and mandatory ledger injection. Claim versions survive registry rebuilds;
  transitions and gap-plan job bindings produce persistent receipts.
- The OS sandbox mounts source read-only, copies execution into an ephemeral
  work root, separates output, omits host `/etc`, and rejects any before/after
  source Merkle drift.
- The old research worker catalog is no longer scanned at runtime.
- Paper production now uses the small `workflow-kernel`; the full vendored
  core is explicitly a reference fork.
- The repo, paper assets, native runtime/store and frozen legacy archive are
  physically decoupled at `/data/home-data/hepta-paper`,
  `/data/home-data/hepta-paper-assets`, `/data/home-data/hepta-paper/runtime`
  and `/data/home-data/paper_factory` respectively.
- Both legacy entrypoints are non-executable. All seven retirement-wave
  receipts plus freeze, quarantine-isolation and active-control-plane removal
  receipts are recorded. No legacy source file was destructively deleted.

These results make the old executable control plane archive-ready, not
functionally equivalent. Owner acceptance remains 0/249, the provider executor
remains outside this repository and unimplemented, and real trust/evidence/
referee/live-authorization inventory remains empty. One real paper now has a
verified native source-integrity worker receipt, but this is not academic
evidence or authorization.

## P0 results

- Independent Git history exists; the import baseline is commit `a1df01c`.
- Accepted vendored-core tree:
  `sha256:f542d687fbe17c19cf6e62a431ccde5ae3abda8fbfae485c1e90d0a4719dc0d6`
  across 588 protected files, with zero accepted-baseline drift.
- Historical upstream comparison remains explicitly divergent: 478/840 files
  match and 362 differ. No report claims historical byte identity.
- The former automatic 263 semantic migration claims are withdrawn. The
  migration matrix now has an explicit row for all 263 P0/P1 source paths.
  Both P0 rows and all 261 P1 rows now have verified dispositions. This means
  old-control-plane replacement or explicit retirement is auditable; it does
  not mean all 263 legacy behaviors were migrated.
- The primary-entrypoint P0 row exhaustively binds all 760 legacy argparse
  commands to all 760 dispatch branches and gives each command a native,
  pending-P1, quarantine, data-export, or retirement disposition. The old
  entrypoint and pending-P1 routes are not allowed by the canonical hepta
  policy.
- The production-core P0 row uses an independent Python/JavaScript
  differential suite covering all 11 production states, all repair-frontier
  routes, stage ordering, summary counters, and artifact-label resolution.
- The hepta-native SQLite store is the default inventory/referee/package store.
  The migrated snapshot has 29 papers, 3 venues, 19 ledger rows, 1,128
  submissions, 3,601 artifacts, 779 non-orphan referee requests, and 710
  non-orphan patch rows; `quick_check` and `foreign_key_check` pass.
- Legacy `paper_factory.sqlite` is import-only. The remediation regression test
  verifies its hash does not change.
- Deterministic empirical output is `pipeline_smoke_only`, never academic
  evidence, and cannot mutate a manuscript.
- Academic evidence requires a version-2 Ed25519-signed, hash-bound
  source-workspace `ACADEMIC_EVIDENCE_ATTESTATION.json`, current source and
  artifact hashes, and verified native-worker execution receipts. Version-1
  self-declarations are ineligible.
- Deterministic referee personas have no independent academic acceptance
  authority.
- Reassessment found 16 unique prior autopilot acceptance receipts; all 16 are
  invalidated as academic accepts. Valid academic accept count is 0.
- Across 20 active submission candidates, native worker plans, executed native
  workers, verified academic-evidence attestations, independent referee
  authorities, and live authorizations are all 0. Reviewed-submit preflight is
  0 ready / 20 blocked; external actions performed remain 0.

## P1 engineering work landed

- Added explicit modules for core integrity, native store paths, migration
  matrix verification, academic evidence attestation, empirical evidence
  policy, review authority, and shared referee-store access.
- Split the five historical orchestration monoliths behind compatibility
  facades:
  - paper-contracts now delegates referee planning, referee application,
    repair closure, submission, and venue/source intake contracts to five
    domain modules plus shared hash/normalization primitives.
  - paper-batch-runner delegates report aggregation and blocker-family
    rendering to batch-summary.
  - journal profile/deadline data is isolated in journal-registry.
  - generated empirical experiment code is isolated in experiment-runner.
  - patch creation/validation/application is isolated in repair-executor.
- A 64 KiB production-module budget is now enforced by remediation selftest
  across all production MJS modules under paper-core and paper-adapters.
- Added deterministic vendored-core selftest distinct from the cross-repository
  workspace integration test.
- Added failure-closed migration and referee-authority tests, SQLite rollback
  and concurrent-writer tests, foreign-key checks, and legacy-store immutability
  checks.
- Added direct boundary checks for contract facade identity, batch-summary
  behavior, the 97-profile journal registry, network-free empirical code
  generation, and referee patch path containment.
- Added a production authority pipeline:
  - three bounded native research-worker types execute artifact integrity,
    CSV descriptive statistics, and JSON assertions without network,
    subprocess, or source-write authority;
  - runtime worker receipts atomically bind the plan, engine, inputs, claims,
    results, and execution hash;
  - academic evidence uses trusted Ed25519 public keys and signed source,
    artifact, claim, and worker-receipt hashes;
  - independent referee verdicts bind the current source, evidence, package,
    venue, and review artifact and enforce separation from evidence signers;
  - live authorization requires two distinct trusted roles, a provider/account
    scope, a single-use nonce, and a validity window of at most 24 hours.
- Added `research-verify --execute`, `authority:status`, and an authority
  pipeline selftest covering concurrent workers, atomic receipts, tamper
  rejection, signature verification, referee independence, authorization
  expiry, and dual control.

The mechanical monolith split is complete under the current 64 KiB budget.
Further decomposition may improve maintainability, but is no longer an
unbounded-file blocker.

## Migration matrix progress after P1

- Matrix version 2 contains 263/263 explicit source rows. Every row binds the
  exact legacy hash, a top-level source-symbol inventory, an assigned native
  capability family, the exact target hash, and target symbols.
- Verified dispositions: 263/263; partial/invalid: 0; P0 blockers: 0; P1
  blockers: 0.
- Behavioral replacements: 14. These are the 2 P0 replacements, 11 native
  plugin descriptors, and the exact differential referee decision-routing
  port.
- Explicit retirements: 249. These are 4 plugin runners, 6 venue-misclassified
  control surfaces, 18 generated referee capstones, 36 build/package-
  misclassified surfaces, 30 legacy submission-control surfaces, and 155
  research-control/worker surfaces.
- Explicit retirement is not semantic migration or functional parity. The
  cleanup summary therefore reports `semanticMigrationClaimCount: 14`,
  `verifiedExplicitRetirementCount: 249`, and
  `functionalParityClaimAllowed: false`.
- The 11 verified plugin descriptors cover compile, package, evidence, external
  boundary, report, venue, section-writer retirement, structural/substantive
  referee, revision planning, and patch-request routing. Model calls,
  independent acceptance authority, direct manuscript mutation, and external
  actions are explicitly not inherited from the legacy wrappers.
- The four retired referee runners have zero references from paper-core or
  paper-adapters. Their unbound model-call and draft-writing execution paths
  are not part of the hepta control plane.
- Six sources previously assigned to venue-resolve were decision catalogs,
  settlement/readiness reports, and operator-drop preflight surfaces rather
  than venue selectors. Their 19 public symbols are explicitly retired after
  AST checks prove no write/process/network side effects and no exact source
  path is consumed by hepta production code.
- Eighteen generated referee capstones are explicitly retired under the same
  fail-closed proof. Their 41 public symbols only build legacy report/control
  evidence and do not provide executable repair authority or hepta-native
  state transitions.
- The non-capstone `referee_revision.py` behavior is implemented in the native
  referee-revise adapter as eight decision-plan/consuming-selection exports.
  A 58-case Python/JavaScript differential suite has exact parity across all
  observed plan and selection states, including unsafe command, mutation,
  external-action, human-review, deterministic fallback, and selected-route
  boundaries.
- The 36 build/package-assigned sources contained no legacy LaTeX build or zip
  implementation: 35 were pure generated report/verifier/intake surfaces and
  one was a local runner-contract materializer. The latter was probed in an
  isolated root and wrote only below
  `logs/paperctl/_contracts/runner_execution`; all 36 are explicitly retired.
- The 30 submission-assigned sources are explicitly separated into 20
  generated control-evidence surfaces, 6 superseded lifecycle/auth/lock/
  handoff schemas, 2 synthetic input authorities, 1 local handoff bundle
  writer, and 1 direct source-mutation executor. The native submission
  lifecycle remains hash-bound and fail-closed at approval, academic evidence,
  preflight, outbox, controlled executor, receipt, and reconciliation gates.
- The 155 research-assigned sources comprise 120 pure plan/report surfaces and
  35 local execution surfaces (32 writers, 21 subprocess callers, 33
  subprocess importers, and zero network-capable sources). All are explicitly
  retired from native execution authority. They are not re-enabled or scanned
  by production runtime. A separate
  hepta-native allowlisted worker engine now exists. A controlled pilot for
  `A_Theory_of__Expectations` executed one source-integrity worker and recorded
  its source-bound receipt; academic-evidence eligibility remains false until
  a real signed attestation and claim-relevant evidence are supplied.
- Shared hash-bound behavior tests execute once per audit and are reused across
  rows, preventing a 263-row matrix from repeatedly running identical suites.
- Current disposition-matrix blocker counts: P0 = 0, P1 = 0. The old control
  plane is disposition-ready for archive-only retirement, while functional
  parity remains explicitly false because 249 rows were retired, not ported.

## Architecture v3 refactor

- Capability matrix v3 maps every one of the 249 explicit-retirement rows to a
  business decision, capability IDs, coverage requirements, and owner
  acceptance. Counts are 88 permanent retirements, 40 superseded-with-coverage
  surfaces, and 121 capability-reimplementation sources. All 249 owner
  acceptances remain pending rather than being inferred from tests.
- `paper-batch-runner` now delegates ordered execution to an immutable
  `PaperExecutionContext`, declarative mode registry, and workflow engine with
  per-stage receipts. All handlers and the diagnostic loop are application use
  cases rather than batch-runner branches. The legacy `referee-autopilot` spelling is only an alias
  for `local-review-loop`.
- Production SQLite calls use `StorePort`; production artifact writes use the
  scoped, atomic `ArtifactRepository` and receive hash-bound write receipts.
- Research is split into ClaimRegistry, ResearchGapPlanner, EvidenceIngestor,
  EvidenceQualityGate, ExperimentRegistry, FormalVerifier, and
  ResearchChangeProposal bounded contexts. Workers have no direct source-apply
  authority.
- Submission now has explicit dispatch authorization, executor-response
  intake, redrive, reconciliation, and release-lock contracts. The
  `SubmissionExecutorPort` still has no provider implementation.
- Journal profiles are a versioned data module with schema validation; all 97
  profiles validate.
- Ambiguous counters were removed. Legacy worker observations are
  `legacyCatalogReference`; research readiness is split into contract,
  evidence-candidate, native-execution, and verified academic-evidence states.
- Portable CI and an architecture coverage gate are present. The architecture
  conformance suite currently covers stage ordering, ports, delivery safety,
  bounded workers, research contracts, journal schema, and forbidden legacy
  acceptance/SQLite bypass patterns. The release verification run reports
  82.27% line coverage for the selected architecture modules; all 74 checked
  production MJS modules remain within the 64 KiB budget.

## Verification

```bash
npm run store:status
npm run reference:integrity
npm run audit:local-accepts
npm run migration:p0-selftest
npm run migration:p1-plugin-selftest
npm run migration:p1-venue-selftest
npm run migration:p1-referee-selftest
npm run migration:p1-build-package-selftest
npm run migration:p1-submission-selftest
npm run migration:p1-research-selftest
npm run migration:matrix-integrity
npm run migration:capability-matrix-v3
npm run paper:authority-selftest
npm run paper:architecture-selftest
npm run coverage:architecture
npm run test:migration-differential
npm run authority:status
npm test
```

The external submission executor remains absent. Matrix disposition and the
four authority mechanisms are implemented. One of the 20 active candidates now
has a paper-specific native source-integrity worker receipt; all 20 still lack
cryptographically attested academic evidence, independent referee acceptances,
and dual-signed live authorization.
The runtime trust store is not provisioned: all four required public-key roles
are currently missing. Final read-only replay reports approval/evidence/
independent-referee/live-authorization blocked for all 20 active candidates,
with 0 preflight ready, 0 controlled receipts recorded, and 0 external actions.
Even a fully verified authority packet only makes the controlled-executor
handoff ready; it performs no portal action. Retirement readiness must not be
used as a production-equivalence or submission-readiness claim.
