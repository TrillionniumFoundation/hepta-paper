# Rust rewrite documentation index

## Canonical truth

| Subject | Canonical file |
|---|---|
| Current status | `CURRENT_STATUS.md` + `current-status.v1.json` |
| Program plan and gates | `RUST_REWRITE_MASTER_PLAN.md` |
| Executable work | `RUST_REWRITE_BACKLOG.md` |
| Compatibility and migration | `RUST_PARITY_MATRIX.md` |
| Risk ownership | `RUST_RISK_REGISTER.md` |
| Trusted computing base | `RUST_TCB_BOUNDARY.md` |
| UID/GID/path authority | `PRINCIPAL_AND_FILESYSTEM_MATRIX.md` |
| Evidence tiers | `EVIDENCE_AND_QUALIFICATION_MODEL.md` |
| Crash semantics | `CRASH_AND_RECOVERY_MATRIX.md` |
| Operator procedures | `OPERATIONS_RUNBOOK.md` |
| External gap-to-package mapping | `qualification/external-package-map.v1.json` |
| External package reviewer index | `qualification/PLAN_V3_EXTERNAL_PACKAGE_INDEX.md` |
| External execution and ingestion protocol | `qualification/PLAN_V3_EXTERNAL_GAP_EXECUTION.md` |
| Legacy 263-file reference publication and receipt | `LEGACY_MATRIX_REFERENCE_PUBLICATION.md` + `../../migration/fixtures/legacy-matrix-reference-verification-policy-v1.json` |
| Protected-main acceptance schema | `qualification/protected-main-ruleset-evidence-v1.schema.json` |
| Supply-chain policy | `security/SUPPLY_CHAIN_POLICY.md` |
| Codex protocol details | `../codex/*.md` |
| Architecture decisions | `../adr/*.md` |

## Historical records

The following are slice records, not current status:

```text
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
status changes go only to `CURRENT_STATUS.md`, `current-status.v1.json` and the
machine-compared backlog table.

## Workflow discipline

Persistent workflows are read-only validators or explicitly scoped evidence
collectors. Historical one-shot workflows that modified source, pushed directly,
self-dispatched or self-deleted are retired after their source changes are
absorbed. They are not part of the current control plane.

Every retained workflow must pass the pinned `workflow-lint` actionlint gate.
Custom self-hosted labels are declared in `.github/actionlint.yaml`; syntax or
Actions-expression failures cannot remain as silent runs with no jobs.

## Change discipline

A pull request changing any production-relevant Rust source must update, or
explicitly state no delta to:

1. current status/gaps;
2. backlog item status and evidence;
3. TCB/principal matrix;
4. risk register;
5. crash/rollback behavior;
6. operator impact;
7. external gap-to-package mapping and schemas.

CI machine-compares all stable backlog IDs and statuses, product-status rows and
external issue ledgers across `current-status.v1.json`, `CURRENT_STATUS.md` and
`RUST_REWRITE_BACKLOG.md`. It also verifies that every external gap has a mapped,
non-activating qualification package with existing schemas, and validates every
workflow, exact head/tree identity, dependency policy and reproducible SBOM
evidence. Exact run evidence remains a workflow artifact rather than being
copied into self-staling prose.
