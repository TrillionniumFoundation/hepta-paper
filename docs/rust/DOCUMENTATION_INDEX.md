# Rust control-plane documentation index

This index covers the active Rust source and authority migration only. The single
global development entry point is [`../README.md`](../README.md); whole-system
status, architecture, milestones, modules, scheduler, and ownership live under
`docs/system`, `docs/modules`, `docs/control-plane`, and `docs/governance`.

## Active Rust documents

| Subject | Current file |
|---|---|
| scoped static status | `CURRENT_STATUS.md` + `current-status.v1.json` |
| migration plan | `RUST_REWRITE_MASTER_PLAN.md` |
| executable Rust backlog | `RUST_REWRITE_BACKLOG.md` |
| Node/Rust parity | `RUST_PARITY_MATRIX.md` |
| source qualification | `QUALIFICATION_STATE_MACHINE.md` |
| evidence tiers | `EVIDENCE_AND_QUALIFICATION_MODEL.md` |
| Rust risks | `RUST_RISK_REGISTER.md` |
| trusted computing base | `RUST_TCB_BOUNDARY.md` |
| principals and filesystems | `PRINCIPAL_AND_FILESYSTEM_MATRIX.md` |
| crash/recovery | `CRASH_AND_RECOVERY_MATRIX.md` |
| operator procedures | `OPERATIONS_RUNBOOK.md` |
| external blocker closure steps | `qualification/EXTERNAL_BLOCKER_CLOSURE_RUNBOOK.md` |
| confidential legacy replay | `LEGACY_MATRIX_REFERENCE_PUBLICATION.md` |
| supply-chain policy | `security/SUPPLY_CHAIN_POLICY.md` |
| native authority and owner inspection | `../modules/NATIVE_AUTHORITY_INSPECTION_HANDOFF.md` |
| local release-integrity key lifecycle | `../modules/RELEASE_INTEGRITY_KEY_HANDOFF.md` |
| portal qualification registry import | `../modules/PORTAL_TARGET_QUALIFICATION_HANDOFF.md` |
| runtime image reproducibility | `../modules/RUNTIME_IMAGE_REPRODUCIBILITY_HANDOFF.md` |
| externally fenced SQLite mutation | `../modules/SQLITE_MUTATION_COORDINATOR_HANDOFF.md` |
| research capability projection | `../modules/RESEARCH_CAPABILITY_MATRIX_HANDOFF.md` |
| startup mutation recovery | `../modules/ONLINE_MUTATION_STARTUP_HANDOFF.md` |
| native workspace status | `../modules/WORKSPACE_STATUS_HANDOFF.md` |
| all-database startup reconciliation | `../modules/ONLINE_STARTUP_RECONCILIATION_SET_HANDOFF.md` |
| finalized-head inspection | `../modules/ONLINE_FINALIZED_HEAD_INSPECTION_HANDOFF.md` |
| finalized inventory | `../modules/ONLINE_FINALIZED_INVENTORY_HANDOFF.md` |
| native activation dependencies | `../modules/ONLINE_RUNTIME_ACTIVATION_HANDOFF.md` |
| native writer source inspection | `../modules/ONLINE_WRITER_STATIC_HANDOFF.md` |
| backup authority and stored restore sources | `../modules/STATE_BACKUP_AUTHORITY_RESTORE_SOURCE_HANDOFF.md` |
| actual state database inventory | `../modules/STATE_DATABASE_INVENTORY_HANDOFF.md` |
| schema transition readiness | `../modules/ONLINE_SCHEMA_TRANSITION_READINESS_HANDOFF.md` |
| target schema projection and application | `../modules/ONLINE_SCHEMA_TARGET_EXECUTION_HANDOFF.md` |
| private deployment environment overlay | `../modules/DEPLOYMENT_ENVIRONMENT_HANDOFF.md` |
| passive authority evidence cache and verified write | `../modules/ONLINE_AUTHORITY_EVIDENCE_CACHE_HANDOFF.md` |
| concrete backup, replay and recoverability controller | `../modules/STATE_RECOVERABILITY_HANDOFF.md` |
| concrete recoverability action fence | `../modules/RECOVERABILITY_CONCRETE_FENCE_HANDOFF.md` |
| schema finalization observation | `../modules/SCHEMA_FINALIZATION_OBSERVATION_HANDOFF.md` |
| schema final receipt publication | `../modules/SCHEMA_FINAL_RECEIPT_PUBLICATION_HANDOFF.md` |
| autonomous supervisor health | `../modules/AUTONOMOUS_SUPERVISOR_HEALTH_HANDOFF.md` |
| active/passive signed authority inspection | `../modules/ONLINE_AUTHORITY_INSPECTION_HANDOFF.md` |
| state safety diagnostic projection | `../modules/STATE_SAFETY_PROJECTION_HANDOFF.md` |
| actual pristine runtime database baseline | `../modules/PRISTINE_RUNTIME_STATE_HANDOFF.md` |
| native five-mode state backup command | `../modules/STATE_BACKUP_CLI_HANDOFF.md` |
| complete command gap ledger | `../migration/NODE_RUST_GAP_CLOSURE.md` |

Cross-subsystem current contracts:

```text
docs/runtime/CODEX_AND_BROKER.md
docs/runtime/WORKSPACE_AND_EXECUTION.md
docs/qualification/QUALIFICATION_MODEL.md
docs/qualification/QUALIFICATION_SUBJECT_V3.md
docs/qualification/EXTERNAL_AUTHORITY.md
```

## Active machine qualification inputs

```text
qualification/source-required-checks.v1.json
qualification/source-check-producers.v1.json
qualification/source-capability-evidence.v1.json
qualification/required-check-evidence-v2.schema.json
qualification/effective-status-v1.schema.json
qualification/external-package-map.v1.json
qualification/protected-main-ruleset-evidence-v1.schema.json
qualification/legacy-matrix-replay-closure-v1.schema.json
```

Qualification Subject V3 source is present in the collector, integrity validator,
V3-bound effective artifact wrapper and live currentness verifier. V2 required
check evidence remains an intermediate input. The V3 source implementation does
not establish successful current-head execution, retained artifacts or independent
acceptance. See `CURRENT_STATUS.md` for the source chain and qualification boundary.

## Current known qualification gap

The candidate cannot be accepted as source-qualified without retained current
V3 evidence binding the exact base/head/tested-merge identities and complete
eligible run-attempt histories. Tests for the historical identity and run-history
defects are present; static source cannot certify that the current candidate's
hosted workflow and independent review have completed successfully.

The G0 work items `QUAL-001` through `QUAL-005` own closure. Historical green
artifacts and superseded approval cannot be reused.

## Native composition implementation handoffs

- [Fixed online mutation plan composition](../modules/ONLINE_MUTATION_COMPOSITION_HANDOFF.md)
- [Observed schema execution and maintenance](../modules/ONLINE_SCHEMA_EXECUTION_HANDOFF.md)
- [Portable backup command root](../modules/STATE_BACKUP_PORTABLE_ROOT_HANDOFF.md)
- [Actual passive state-safety composition](../modules/STATE_SAFETY_COMPOSITION_HANDOFF.md)
- [Complete writer source input proof](../modules/ONLINE_WRITER_COMPLETE_INPUT_PROOF_HANDOFF.md)
- [Signed schema journal normalization](../modules/SCHEMA_JOURNAL_NORMALIZATION_HANDOFF.md)
- [Schema genesis installation](../modules/SCHEMA_GENESIS_INSTALLATION_HANDOFF.md)
- [Concrete recoverability action fence](../modules/RECOVERABILITY_CONCRETE_FENCE_HANDOFF.md)
- [Schema finalization observation](../modules/SCHEMA_FINALIZATION_OBSERVATION_HANDOFF.md)
- [Autonomous supervisor health](../modules/AUTONOMOUS_SUPERVISOR_HEALTH_HANDOFF.md)

These code-level handoffs do not change registered module qualification,
production activation, principal authority, or Node retirement status.

## Source-of-truth rule

Global committed truth is `docs/system/truth/*.json`. During migration,
`current-status.v1.json` remains the machine-checked Rust projection required by
current Plan v4.1 workflows. Human Rust tables cannot override either global
truth or exact effective workflow evidence.

Committed source never activates the Rust writer, loads credentials, performs a
provider call, signs/promotes a release, accesses KMS/HSM/WORM write authority,
or submits a paper.

## Historical-document policy

Dated checkpoints, trigger notes, working-status files, source-closure snapshots,
fragmented evidence-policy notes, and superseded external-package prose are
absent from the working tree. Git history and original review/evidence objects
preserve them for audit.

## Change discipline

A Rust production-relevant change updates or explicitly records no impact to:

```text
global capability/module/work/milestone/risk truth
scoped Rust status/backlog/parity
TCB, principals and authority
crash, rollback and operator behavior
protocol and compatibility
resource/SLO/conformance bindings
source/effective qualification identity and evidence mappings
external packages and non-authority claims
```

Validation starts with:

```bash
node docs/tools/validate-development-docs.mjs
python3 docs/rust/tools/validate-program-truth.py
```

The full exact-head workflow matrix and independent review remain mandatory.
