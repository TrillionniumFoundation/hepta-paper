# hepta-paper Rust rewrite current status

This is the single canonical human-readable **static source declaration** for the
Rust control-plane rewrite. The machine source is
[`current-status.v1.json`](current-status.v1.json).

Plan v4 separates two facts that earlier documents conflated:

1. `source_implemented` is a source-tree fact that may be committed by the
   implementation branch.
2. `source_qualified` is an **effective, exact-head evidence result** derived by
   CI after all required jobs complete successfully on that unchanged head.

Source files never self-assert `source_qualified`. The exact-head workflow emits
`effective-status.v1.json`; a head change, zero-job run, skipped required job,
failed job, dirty postflight or stale review invalidates that effective result.

## Bound baseline and current candidate

The historical Plan v3 rebaseline remains:

```text
repository  TrillionniumFoundation/hepta-paper
branch      codex/rust-broker-service-20260828
commit      80223a2531de32ceeeab7d5d4e6c9b36a605716f
tree        cee44bee7bf42f5a7287de14700b83985f5e3557
```

The single repository-local convergence branch is:

```text
branch      codex/rust-plan-v4-rc1-20260831
base        600b1c7a6b0525f088dede62f52e67b7c98eb26a
base tree   81aa411fc5f63b7c9949ee8b52f3b94d91cc87d7
stage       release-candidate source requalification
```

The base includes descriptor-bound workspace traversal and signed campaign-writer
cutover hardening. Those changes are not treated as qualified until the new
branch receives a non-empty exact-head workflow matrix.

## Static source state

| Plane | Current status | Effective evidence rule | Authority granted |
|---|---|---|---|
| Foundation contracts | `source_implemented` | eligible for exact-head workflow promotion | none |
| Broker protocol/journal | `source_implemented` | eligible for exact-head workflow promotion | broker-local fixture state only |
| Durable pre-exec gate | `source_implemented` | eligible for exact-head workflow promotion | fake/local executable only |
| Workspace mutation authority | `source_implemented` | latest descriptor-bound P0 patch awaits exact-head execution | attempt fixtures only |
| Compatibility kernel | `source_implemented` | public source corpus present; hosted 263-file replay remains external | verification only |
| Read-only Rust campaign plane | `source_implemented` | eligible for exact-head workflow promotion | read-only inspection only |
| Local author/reviewer slice | `source_implemented` | latest writer/workspace integration awaits exact-head execution | no live provider authority |
| Rust campaign writer | `source_implemented` | signed cutover P0 patch awaits exact-head execution | no production writer activation |
| Scientific evidence orchestration | `source_implemented` | eligible for exact-head workflow promotion | no assurance elevation |
| Cutover/retirement contracts | `source_implemented` | eligible for exact-head workflow promotion | no cutover authorization |
| Protected main merge boundary | `blocked_external` | policy is configured; seven denial probes and independent signed decision remain | none |
| Trusted legacy matrix replay | `blocked_external` | private archive exists; retained hosted replay receipt/index remains absent | verification only |
| Production target host | `blocked_external` | repository and hosted runners cannot establish target-host facts | none |
| Real Codex credentials/provider | `blocked_external` | real credential custody and live role canaries remain absent | none |
| Release/KMS/WORM/submission | `blocked_external` | real external authority receipts remain absent | none |

The static table deliberately uses `source_implemented`. A successful,
artifact-retained exact-head run may derive `source_qualified` for eligible
repository-local rows without editing this file. External rows never
auto-promote.

## Repository-local closure represented in this candidate

The source candidate contains contracts and tests for:

- strict request/receipt and JSONL protocols;
- exact executable, configuration, schema and principal identities;
- durable pre-exec gating and conservative ambiguity recovery;
- descriptor-bound COW workspaces, hard-link/symlink/cross-device rejection,
  two-pass hashing and partial-copy cleanup;
- immutable schema-1..25 inspection and Node/Rust compatibility vectors;
- generation-fenced campaign persistence, prepared-result recovery, backup and
  deterministic 10k simulation;
- exact-subject Ed25519 writer cutover authorization binding repository, commit,
  tree, binary, configuration, host, service, database preimage and first lease;
- non-activating external evidence ingestion and cutover fencing.

None of these source contracts grants target-host, credential, key-custody,
release, portal or submission authority.

## Remaining external blockers

| Gap | Status | Evidence collector | Required real owner |
|---|---|---|---|
| `GAP-GOV-003` | `blocked_external` | issue #25 | repository administrator distinct from the implementation author plus independent reviewer |
| `GAP-HOST-001` | `blocked_external` | issue #17 | target-host operator plus independent Linux reviewer |
| `GAP-HOST-002` | `blocked_external` | issue #12 | destructive storage/host operator plus independent reviewer |
| `GAP-KEY-001` | `blocked_external` | issue #14 | external capability-key owner plus independent reviewer |
| `GAP-CODEX-001` | `blocked_external` | issue #21 | Codex credential owner, target-host operator and reviewer |
| `GAP-REL-001` | `blocked_external` | issue #22 | KMS/HSM, WORM, release, portal and submission owners |

### Supplemental migration blocker

| Blocker | Status | Evidence collector | Required real owner |
|---|---|---|---|
| `LEGACY-REPLAY-001` | `blocked_external` | issue #28 | private companion operator plus independent archive/replay reviewer |

`main` is currently protected and requires the configured status contexts, but
`GAP-GOV-003` remains open until the active policy export, all seven denial
outcomes and an independent signed exact-candidate decision are retained.

The 263-file legacy archive has been recovered in the private companion and its
digest/matrix can be checked locally. `LEGACY-REPLAY-001` remains open until the
secret-bearing hosted workflow produces a retained exact-candidate replay
receipt and artifact index with independent acknowledgement.

## Forbidden authority

Until the relevant external evidence is accepted, all of the following remain
forbidden:

```text
real Codex credential loading
live provider calls
production campaign database writes
production writer cutover
release signing or promotion
KMS/HSM/WORM mutation
portal credentials
submission actions
```

A repository administrator, implementation author, model, fixture key or
GitHub-hosted source test cannot substitute for a separately controlled external
authority.

## Status vocabulary

- `not_started` — no accepted source implementation;
- `design_ready` — normative design and acceptance criteria exist;
- `source_implemented` — source exists but effective qualification must come from
  exact-head workflow evidence;
- `source_qualified` — derived effective status for one exact commit/tree whose
  complete required workflow matrix succeeded;
- `hosted_installed_qualified` — installed tests passed on a hosted disposable
  runner;
- `target_host_qualified` — a separately controlled target host passed its drill;
- `external_authority_qualified` — a separate authority issued accepted evidence;
- `blocked_external` — the repository cannot manufacture the required fact;
- `retired` — behavior is intentionally absent with migration evidence.

“Done”, “production ready”, or unqualified “qualified” are prohibited.

## Closure order

1. Run every required Rust, Node, workflow, supply-chain, program-truth,
   qualification and impacted-test job on the exact RC head.
2. Retain `effective-status.v1.json`, exact-head/tree evidence and artifact
   digests; reject zero-job or `action_required` runs.
3. Obtain an independent latest-push review and integrate the RC into the sole
   product branch; close duplicate P0 PRs.
4. Complete issue #25 denial evidence and exact policy export.
5. Complete issue #28 hosted private legacy replay and acknowledgement.
6. Execute target-host listener/systemd/cgroup qualification in issue #17.
7. Execute destructive storage, reboot, corruption and 72-hour soak in issue #12.
8. Execute independent key lifecycle and compromise drills in issue #14.
9. Execute separated authenticated Codex author/reviewer canaries in issue #21.
10. Execute real KMS/HSM, WORM, release, portal and submission drills in issue
    #22.
11. Only after every prerequisite is accepted, perform shadow, canary, rollback,
    writer cutover and Node-authority retirement.

## Canonical document set

- [`RUST_REWRITE_MASTER_PLAN.md`](RUST_REWRITE_MASTER_PLAN.md)
- [`RUST_REWRITE_BACKLOG.md`](RUST_REWRITE_BACKLOG.md)
- [`RUST_PARITY_MATRIX.md`](RUST_PARITY_MATRIX.md)
- [`QUALIFICATION_STATE_MACHINE.md`](QUALIFICATION_STATE_MACHINE.md)
- [`RUST_RISK_REGISTER.md`](RUST_RISK_REGISTER.md)
- [`RUST_TCB_BOUNDARY.md`](RUST_TCB_BOUNDARY.md)
- [`PRINCIPAL_AND_FILESYSTEM_MATRIX.md`](PRINCIPAL_AND_FILESYSTEM_MATRIX.md)
- [`EVIDENCE_AND_QUALIFICATION_MODEL.md`](EVIDENCE_AND_QUALIFICATION_MODEL.md)
- [`CRASH_AND_RECOVERY_MATRIX.md`](CRASH_AND_RECOVERY_MATRIX.md)
- [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md)

The canonical/historical mapping is maintained in
[`DOCUMENTATION_INDEX.md`](DOCUMENTATION_INDEX.md).
