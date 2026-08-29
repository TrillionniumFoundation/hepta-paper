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
status changes go only to `CURRENT_STATUS.md` and `current-status.v1.json`.

## Change discipline

A pull request changing any production-relevant Rust source must update, or
explicitly state no delta to:

1. current status/gaps;
2. backlog item status and evidence;
3. TCB/principal matrix;
4. risk register;
5. crash/rollback behavior;
6. operator impact.

CI validates the machine file, stable IDs, status vocabulary and canonical
file presence. Exact execution evidence remains a workflow artifact rather than
being copied into timestamped prose files.
