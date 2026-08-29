# hepta-paper Rust rewrite current status

This is the **single canonical human-readable status** for the Rust rewrite. The
machine source is [`current-status.v1.json`](current-status.v1.json). Older
slice, checkpoint and trigger documents are historical evidence only and cannot
override this file.

## Bound baseline

The plan-v3 rebaseline starts from:

```text
repository  TrillionniumFoundation/hepta-paper
branch      codex/rust-broker-service-20260828
commit      80223a2531de32ceeeab7d5d4e6c9b36a605716f
tree        cee44bee7bf42f5a7287de14700b83985f5e3557
```

Every later claim is valid only for the exact commit and tree tested by its
workflow evidence. A green historical SHA, a local test, or a merge-ref test may
not be described as qualification of a different head.

## Product status

The Rust work is a **broker source candidate**, not a completed hepta-paper
rewrite and not a production release.

| Plane | Current status | Strongest evidence | Authority granted |
|---|---|---|---|
| Foundation contracts | source qualified | locked Rust CI | none |
| Broker protocol/journal | source qualified | source + hosted installed fixtures | broker-local test state only |
| Durable pre-exec gate | source qualified | source + hosted installed fixtures | fake/local executable only |
| Production target host | blocked external | none | none |
| Real Codex credentials/provider | blocked external | none | none |
| Workspace mutation authority | not started | none | none |
| Read-only Rust campaign plane | not started | none | none |
| Rust campaign writer | not started | none | none |
| Release/KMS/WORM/submission | blocked external | none | none |

The following remain forbidden until their gates are independently accepted:

```text
real Codex credentials
live provider calls
campaign database writes
release signing or promotion
KMS/HSM/WORM access
portal credentials
submission actions
```

## Status vocabulary

Only these terms may be used for current capability status:

- `not_started` — no accepted source implementation;
- `design_ready` — normative design and acceptance criteria exist;
- `source_implemented` — source exists but the complete source gate has not passed;
- `source_qualified` — exact-source tests, lint and documentation gates passed;
- `hosted_installed_qualified` — installed tests passed on a hosted disposable runner;
- `target_host_qualified` — a separately controlled target host passed its drill;
- `external_authority_qualified` — a separate authority issued accepted evidence;
- `blocked_external` — repository work cannot manufacture the required evidence;
- `retired` — behavior is intentionally absent with migration evidence.

“Done”, “closed”, “production ready”, and “qualified” without a tier are
prohibited in status documents and PR descriptions.

## Immediate closure order

1. Make the program truth machine-verifiable and remove stale-status ambiguity.
2. Fix exact-head/exact-tree workflow identity and evidence retention.
3. Correct the Unix listener access model and test an authorized principal
   succeeding against a live listener.
4. Add production containment that defeats `setsid`/double-fork escape; retain
   process-group-only mode for local fixtures only.
5. Build the descriptor-relative COW workspace and mutation-policy slice.
6. Build the compatibility kernel and schema-25 read-only control plane.
7. Complete one local author/build/reviewer/revise vertical slice.
8. Introduce the Rust writer only after single-writer and rollback gates pass.
9. Qualify release and submission authorities only with separately controlled
   evidence.

## Evidence rule

Repository and GitHub-hosted evidence can establish source and hosted-installed
claims. They cannot self-create target-host ownership, independent review,
provider authentication, key-owner custody, KMS/HSM, WORM, portal or submission
authority. Those gaps remain open until evidence arrives from their real owner.

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
