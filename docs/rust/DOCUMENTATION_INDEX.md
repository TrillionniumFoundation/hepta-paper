# Rust rewrite documentation index

## Canonical truth

| Subject | Canonical file |
|---|---|
| Static current status | `CURRENT_STATUS.md` + `current-status.v1.json` |
| Effective exact-head status | workflow artifact `effective-status.v1.json` validated by `qualification/effective-status-v1.schema.json` |
| Program plan and gates | `RUST_REWRITE_MASTER_PLAN.md` |
| Qualification promotion/demotion | `QUALIFICATION_STATE_MACHINE.md` |
| Executable work | `RUST_REWRITE_BACKLOG.md` |
| Compatibility and migration | `RUST_PARITY_MATRIX.md` |
| Required source checks | `qualification/source-required-checks.v1.json` |
| Exact check producers | `qualification/source-check-producers.v1.json` |
| Capability-specific source evidence | `qualification/source-capability-evidence.v1.json` |
| Normalized check evidence schema | `qualification/required-check-evidence-v2.schema.json` |
| Effective artifact schema | `qualification/effective-status-v1.schema.json` |
| Live source-evidence revalidation | `.github/workflows/rust-source-qualification-revalidation.yml` |
| Risk ownership | `RUST_RISK_REGISTER.md` |
| Trusted computing base | `RUST_TCB_BOUNDARY.md` |
| UID/GID/path authority | `PRINCIPAL_AND_FILESYSTEM_MATRIX.md` |
| Evidence tiers | `EVIDENCE_AND_QUALIFICATION_MODEL.md` |
| Crash semantics | `CRASH_AND_RECOVERY_MATRIX.md` |
| Operator procedures | `OPERATIONS_RUNBOOK.md` |
| External gap-to-package mapping | `qualification/external-package-map.v1.json` |
| External package reviewer index | `qualification/PLAN_V3_EXTERNAL_PACKAGE_INDEX.md` |
| External execution and ingestion protocol | `qualification/PLAN_V3_EXTERNAL_GAP_EXECUTION.md` |
| Protected-main acceptance schema | `qualification/protected-main-ruleset-evidence-v1.schema.json` |
| Confidential legacy replay | `LEGACY_MATRIX_REFERENCE_PUBLICATION.md`, `qualification/legacy-matrix-replay-closure-v1.schema.json`, and issue #28 |
| Supply-chain policy | `security/SUPPLY_CHAIN_POLICY.md` |
| Codex protocol details | `../codex/*.md` |
| Architecture decisions | `../adr/*.md` |

## Source of truth rule

`current-status.v1.json` is the only committed status authority. Human tables in
`CURRENT_STATUS.md`, `RUST_REWRITE_BACKLOG.md` and
`RUST_PARITY_MATRIX.md` are projections and are machine-compared.

Committed source records implementation state only. They do not contain a
self-staling qualification commit and do not self-assert `source_qualified`.
The derivation workflow `.github/workflows/rust-effective-source-qualification.yml`
collects producer-authenticated results and emits `effective-status.v1.json` only
when each capability-specific prerequisite succeeds on one exact commit/tree.
The independent currentness workflow
`.github/workflows/rust-source-qualification-revalidation.yml` runs after
producer completion and invalidates any artifact whose producer snapshot has
changed.

The derived artifact is repository-local evidence. It cannot activate a writer,
load credentials, sign a release or satisfy an external authority package.

## Historical records

The following are slice or checkpoint records, not current status:

```text
ALL_GAP_CLOSURE_WORKING_STATUS.md
PLAN_V3_SOURCE_CLOSURE_ACCEPTANCE.md
RUST_FOUNDATION_STATUS.md
RUST_FOUNDATION_VALIDATION.md
RUST_BROKER_FOUNDATION_STATUS.md
RUST_BROKER_FOUNDATION_AUDIT.md
RUST_BROKER_STATE_STATUS.md
RUST_BROKER_SOURCE_CLOSURE_STATUS.md
RUST_DURABLE_GATE_STATUS.md
SOURCE_CLOSURE_CHECKPOINT_*.md
PR16_*_TRIGGER_*.md
qualification/PR16_*_TRIGGER_*.md
```

Historical files may bind the exact commit they observed. They must not use an
unqualified present-tense statement such as “the current head is ready”. New
static status changes go only to machine truth and its canonical projections.
New effective qualification is recorded only as a workflow artifact.

## Workflow discipline

Persistent workflows are read-only validators or explicitly scoped evidence
collectors. Historical one-shot workflows that modified source, pushed
directly, self-dispatched or self-deleted remain retired.

Every retained workflow must pass the pinned actionlint gate and explicitly
checkout the pull-request head. A workflow run with zero jobs,
`action_required`, a missing required context or a skipped required job is not
qualification evidence.

The canonical context set is `qualification/source-required-checks.v1.json`;
`qualification/source-check-producers.v1.json` authenticates each context to an
exact candidate-tree workflow definition and PR run/job/step identity. App ID or
context name alone is insufficient.

## External and supplemental blockers

The canonical external authority gaps remain mapped by
`qualification/external-package-map.v1.json` and are accepted only by the Rust
qualification-ingestion boundary.

`LEGACY-REPLAY-001` / issue #28 is a supplemental confidential migration
blocker. It is deliberately not added to the authority package map: the private
263-file archive verifies historical parity but grants no production authority.
Its closure still requires a retained secret-gated hosted replay receipt/index
and independent acknowledgement.

## Change discipline

A pull request changing production-relevant Rust source must update, or
explicitly state no delta to:

1. static current status and gaps;
2. backlog implementation state;
3. parity state and dependencies;
4. TCB/principal matrix;
5. risk register;
6. crash/rollback behavior;
7. operator impact;
8. external package mapping and schemas;
9. required source-check context set;
10. qualification invalidation implications;
11. producer and capability-evidence manifests;
12. check/effective schema and live-revalidation behavior.

CI validates the complete projection, exact source identity, dependency policy,
supply-chain evidence and non-empty check-run matrix. A prior head's artifacts
or review decisions cannot be inherited.
