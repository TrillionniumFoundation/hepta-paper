# hepta-paper Rust rewrite current status

This is the **single canonical human-readable status** for the Rust rewrite. The
machine source is [`current-status.v1.json`](current-status.v1.json). The
validator compares this file and the executable backlog against machine truth;
historical slice, checkpoint and trigger documents cannot override the canonical
set.

## Bound baseline

The plan-v3 rebaseline starts from:

```text
repository  TrillionniumFoundation/hepta-paper
branch      codex/rust-broker-service-20260828
commit      80223a2531de32ceeeab7d5d4e6c9b36a605716f
tree        cee44bee7bf42f5a7287de14700b83985f5e3557
```

Every later claim is valid only for the exact commit and tree named by retained
workflow evidence. A green historical SHA, local-only run, merge-ref result or
dirty checkout is never evidence for a different head.

## Product status

The Rust work is a **repository-local source candidate**, not a production
activation. Source-qualified code may exist while every production authority
remains absent.

| Plane | Current status | Strongest evidence | Authority granted |
|---|---|---|---|
| Foundation contracts | `source_qualified` | exact-head locked Rust and supply-chain gates | none |
| Broker protocol/journal | `source_qualified` | source plus hosted-installed fixtures | broker-local test state only |
| Durable pre-exec gate | `source_qualified` | source plus hosted-installed fixtures | fake/local executable only |
| Workspace mutation authority | `source_qualified` | descriptor/COW/mutation source suites | attempt fixtures only |
| Compatibility kernel | `source_qualified` | frozen corpus and differential source suites | verification only |
| Read-only Rust campaign plane | `source_qualified` | immutable schema-1..25 source suites | read-only inspection only |
| Local author/reviewer slice | `source_qualified` | fake-provider local vertical slice | no live provider authority |
| Rust campaign writer | `source_qualified` | fenced persistence/recovery source suites | no production writer activation |
| Scientific evidence orchestration | `source_qualified` | deterministic evidence contract suites | no assurance elevation |
| Cutover/retirement contracts | `source_qualified` | cutover fencing and rollback contract suites | no cutover authorization |
| Production target host | `blocked_external` | repository/hosted evidence is insufficient | none |
| Real Codex credentials/provider | `blocked_external` | repository/hosted evidence is insufficient | none |
| Release/KMS/WORM/submission | `blocked_external` | repository/hosted evidence is insufficient | none |

The following remain forbidden until separately controlled evidence is accepted:

```text
real Codex credentials
live provider calls
production campaign database writes
production writer cutover
release signing or promotion
KMS/HSM/WORM access
portal credentials
submission actions
```

## Repository-local closure

The exact candidate graph contains source-qualified contracts and tests for
program truth, exact-head evidence, listener access, cgroup-v2 containment,
telemetry, descriptor-bound workspaces, historical compatibility, immutable
read-only SQLite projection, the fake-provider local vertical slice, the fenced
campaign writer, scientific-evidence ports and cutover fencing.

`source_qualified` means only that the exact head passed its applicable source
gates. It does not imply target-host installation, credential custody, provider
authentication, production writer authority, external key ownership or release
and submission authority.

## Remaining external blockers

| Gap | Status | Evidence collector | Required real owner |
|---|---|---|---|
| `GAP-HOST-001` | `blocked_external` | issue #17 | target-host operator and independent Linux reviewer |
| `GAP-HOST-002` | `blocked_external` | issue #12 | target storage/host operator and independent reviewer |
| `GAP-KEY-001` | `blocked_external` | issue #14 | external capability-key owner |
| `GAP-CODEX-001` | `blocked_external` | issue #21 | Codex credential owner, target-host operator and reviewer |
| `GAP-REL-001` | `blocked_external` | issue #22 | KMS/HSM, WORM, release, portal and submission owners |

Repository or GitHub-hosted workflows cannot honestly self-create these facts.
The issues above specify exact inputs, drills, receipt fields, denial proofs and
independent acceptance required for closure.

## Status vocabulary

Only these terms may be used for current capability status:

- `not_started` — no accepted source implementation;
- `design_ready` — normative design and acceptance criteria exist;
- `source_implemented` — source exists but the complete exact-head source gate has not passed;
- `source_qualified` — the exact source passed deterministic source gates;
- `hosted_installed_qualified` — installed tests passed on a hosted disposable runner;
- `target_host_qualified` — a separately controlled target host passed its drill;
- `external_authority_qualified` — a separate authority issued accepted evidence;
- `blocked_external` — repository work cannot manufacture the required evidence;
- `retired` — behavior is intentionally absent with migration evidence.

“Done”, “closed”, “production ready”, and “qualified” without a tier are
prohibited in status documents and PR descriptions.

## Remaining closure order

1. Maintain a green exact-head source, supply-chain and canonical-truth matrix.
2. Execute the independent Linux install, service-manager, PID/session and
   durable-gate review in issue #17.
3. Execute the destructive WAL/reboot/disk-full/corruption and 72-hour topology
   drill in issue #12.
4. Execute independent key-owner rotation, revocation and compromise drills in
   issue #14.
5. Execute authenticated, separated author/reviewer Codex canaries in issue #21.
6. Execute real release, KMS/HSM, WORM, portal and submission authority drills
   in issue #22.
7. Only then authorize production cutover and later retirement evidence.

## Canonical document set

- [`RUST_REWRITE_MASTER_PLAN.md`](RUST_REWRITE_MASTER_PLAN.md)
- [`RUST_REWRITE_BACKLOG.md`](RUST_REWRITE_BACKLOG.md)
- [`RUST_PARITY_MATRIX.md`](RUST_PARITY_MATRIX.md)
- [`RUST_RISK_REGISTER.md`](RUST_RISK_REGISTER.md)
- [`RUST_TCB_BOUNDARY.md`](RUST_TCB_BOUNDARY.md)
- [`PRINCIPAL_AND_FILESYSTEM_MATRIX.md`](PRINCIPAL_AND_FILESYSTEM_MATRIX.md)
- [`EVIDENCE_AND_QUALIFICATION_MODEL.md`](EVIDENCE_AND_QUALIFICATION_MODEL.md)
- [`CRASH_AND_RECOVERY_MATRIX.md`](CRASH_AND_RECOVERY_MATRIX.md)
- [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md)

The mapping of canonical and historical documents is maintained in
[`DOCUMENTATION_INDEX.md`](DOCUMENTATION_INDEX.md).
