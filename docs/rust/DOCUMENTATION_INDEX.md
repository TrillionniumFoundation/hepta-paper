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
| confidential legacy replay | `LEGACY_MATRIX_REFERENCE_PUBLICATION.md` |
| supply-chain policy | `security/SUPPLY_CHAIN_POLICY.md` |

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

The V2 collector/derivation remains the active implementation until
Qualification Subject V3 is implemented atomically across schemas, tools,
workflows, tests, producer digests, fresh artifacts, and latest-head review. A
design document cannot silently change the evidence protocol.

## Current known qualification gap

The latest RC cannot be accepted as source-qualified while either condition
remains:

1. exact base repository/ref/commit/tree and tested merge commit/tree are not
   completely bound to eligibility, schema, snapshot and revalidation;
2. mutation of an older eligible workflow run may be ignored after a newer run
   ID exists.

The G0 work items `QUAL-001` through `QUAL-005` own closure. Historical green
artifacts and superseded approval cannot be reused.

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
