# hepta-paper Rust rewrite current status

This is the scoped human-readable **static source declaration** for the Rust
control-plane migration. Global development truth is owned by
[`../system/CURRENT_STATUS.md`](../system/CURRENT_STATUS.md) and
[`../system/truth/program.v2.json`](../system/truth/program.v2.json). Within the
Rust migration scope, the machine source remains
[`current-status.v1.json`](current-status.v1.json) until its projections are
fully generated from global truth.

Plan v4 separates two facts that earlier documents conflated:

1. `source_implemented` is a source-tree fact that may be committed by the
   implementation branch.
2. `source_qualified` is an **effective, exact-head evidence result** derived by
   CI after all required jobs complete successfully on that unchanged head.

Source files never self-assert `source_qualified`. The current source contains a
Qualification Subject V3 collector and integrity validator, a V3-bound effective
artifact wrapper (artifact version 2), and live currentness verification. V2
required-check evidence and the V1 effective artifact remain intermediate inputs;
they are not a substitute for V3 base/head/tested-merge and complete eligible
run-attempt-history binding. Zero-job, skipped, dirty, stale, base-moved,
merge-moved and run-history-mutated evidence must fail closed.

`QUAL-001` through `QUAL-005` remain open acceptance records in static machine
truth. Their historical defect wording does not mean the V3 source is still
missing. No current exact-head qualification or independent acceptance is
asserted by this document.

## Bound baseline and current candidate

The historical Plan v3 rebaseline remains:

```text
repository  TrillionniumFoundation/hepta-paper
branch      codex/rust-broker-service-20260828
commit      80223a2531de32ceeeab7d5d4e6c9b36a605716f
tree        cee44bee7bf42f5a7287de14700b83985f5e3557
```

The prior release-candidate branch `codex/rust-plan-v4-rc1-20260831` and its
`codex/rust-plan-v3-final-product-20260830` integration base are historical audit
lineage. They do not identify the current implementation candidate:

```text
implementation branch  codex/rust-production-migration-20260908
source baseline        6e56a3508e871018e1b4e0c5a573b50818032e38
stage                  executable local/shadow runtime migration
exact head/tree        read live; never substituted by a historical audit digest
```

The current implementation map, reproducible commands and remaining production
boundaries are in
[`RUNTIME_MIGRATION_IMPLEMENTATION.md`](RUNTIME_MIGRATION_IMPLEMENTATION.md).
Each changed candidate still needs a producer-authenticated non-empty matrix,
retained fully schema-valid artifacts, live V3 revalidation and independent
review. Local execution does not qualify a branch or authorize a deployment.

## Static source state

| Plane | Current status | Effective evidence rule | Authority granted |
|---|---|---|---|
| Foundation contracts | `source_implemented` | eligible for exact-head workflow promotion | none |
| Broker protocol/journal | `source_implemented` | eligible for exact-head workflow promotion | broker-local fixture state only |
| Durable pre-exec gate | `source_implemented` | eligible for exact-head workflow promotion | fake/local executable only |
| Workspace mutation authority | `source_implemented` | latest descriptor-bound P0 patch awaits exact-head execution | attempt fixtures only |
| Compatibility kernel | `source_implemented` | actual production Node serializer and native database differential fixtures present; hosted historical replay remains external | verification only |
| Read-only Rust campaign plane | `source_implemented` | real Node migration-ledger/schema validation plus separate Rust HPCW detection await exact-head qualification | read-only inspection only |
| Local author/reviewer slice | `source_implemented` | latest writer/workspace integration awaits exact-head execution | no live provider authority |
| Rust campaign writer | `source_implemented` | atomic campaign/control result and receipt persistence, replay and signed activation source await exact-head qualification | explicitly local marked database writes; no production activation |
| Scientific evidence orchestration | `source_implemented` | eligible for exact-head workflow promotion | no assurance elevation |
| Cutover/retirement contracts | `source_implemented` | durable journal, epoch, process-crash/concurrency and data-preserving local rollback tests await exact-head qualification | local drill only; production requires separate signed authorization |
| Protected main merge boundary | `blocked_external` | policy is configured; seven denial probes and independent signed decision remain | none |
| Trusted legacy matrix replay | `blocked_external` | private archive exists; retained hosted replay receipt/index remains absent | verification only |
| Production target host | `blocked_external` | repository and hosted runners cannot establish target-host facts | none |
| Real Codex credentials/provider | `blocked_external` | real credential custody and live role canaries remain absent | none |
| Release/KMS/WORM/submission | `blocked_external` | real external authority receipts remain absent | none |

The static table preserves the declared component projection. The separate
`module.rust-control-plane-service` registry entry remains `design_ready`:
local/shadow execution exists, while production composition, adapters, complete
capability parity and host acceptance remain open. A successful,
artifact-retained exact-head run may derive `source_qualified` for eligible
repository-local rows without editing this file. External rows never
auto-promote.

## Qualification Subject V3 source and remaining evidence closure

The current source contains these concrete contracts and executables:

- `qualification/source-check-producers.v1.json` binds required contexts to exact
  workflow identities and candidate-tree file digests.
- `qualification/source-capability-evidence.v1.json` defines capability-specific
  context sets; the scoped validator reports 126 bindings across its projections.
- `qualification/required-check-evidence-v2.schema.json` and
  `qualification/effective-status-v1.schema.json` validate the intermediate
  producer/run/job/step and effective results.
- `../qualification/schemas/qualification-subject-runtime-v3.schema.json`,
  `tools/qualification_subject_v3.py` and `tools/qualification_subject_integrity.py`
  implement exact base/head/tested-merge, bounded complete eligible run-attempt
  histories, history hashes, freshness and artifact/evidence integrity checks.
- `qualification/effective-status-runtime-v2.schema.json`,
  `tools/derive_effective_status_v2.py` and
  `tools/verify_effective_status_v2_current.py` wrap the effective result in the
  verified V3 subject and compare it with freshly collected live evidence.
- `tools/run-qualification-subject-v3.sh` runs schema/adversarial tests, raw
  collection completeness and projection validation, V3 derivation and repeat
  collection/currentness checks.

`rust-effective-source-qualification.yml`, `rust-qualification-subject-v3.yml`
and `rust-qualification-subject-v3-revalidation.yml` invoke that V3 entry point.
The legacy `rust-source-qualification-revalidation.yml` still revalidates the V1
intermediate artifact under `source-qualification-current`; that older check
alone cannot establish V3 acceptance. The dedicated V3 currentness context is
`source-qualification-v3-current`. Existing machine policy is retained rather
than silently rewritten by this narrative update.

The remaining G0 question is accepted current-source evidence and independent
review of the complete chain, not the absence of V3 collector or verifier code.
Historical green artifacts and historical request-changes decisions describe
their own exact subjects; neither qualifies nor reviews this new candidate.
Production and external authority remain independently controlled.

## Repository-local closure represented in this candidate

The source candidate contains contracts and tests for:

- strict request/receipt and JSONL protocols;
- exact executable, configuration, schema and principal identities;
- durable pre-exec gating and conservative ambiguity recovery;
- descriptor-bound COW workspaces, hard-link/symlink/cross-device rejection,
  two-pass hashing and partial-copy cleanup;
- real Node migration-ledger/schema-1..25 inspection, native logical-report
  parity, separate Rust HPCW detection and production serializer oracle vectors;
- generation-fenced campaign persistence, atomic prepared-result/receipt/control
  accounting, exact replay, stale-plan rejection, backup and recovery;
- runnable local/shadow service composition with explicit native workers and
  pinned process-language/source provenance;
- exact-subject Ed25519 writer cutover authorization binding repository, commit,
  tree, binary, configuration, host, service, database preimage and first lease;
- concrete signed broker dispatch, bounded output/schema validation and cgroup
  containment with deployment authority supplied externally;
- non-activating external evidence ingestion and durable Node/Rust cutover
  fencing, actual SQLite restore drills and ownership rollback preserving
  post-cutover committed data.

The global inventory has 72 work items; the separate scoped Rust backlog has 75.
These counts come from their respective machine records and must not be merged
into a synthetic completion percentage.

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

Historical repository evidence records protected `main` and configured status
contexts. `GAP-GOV-003` remains open until the current active policy export, all
seven denial outcomes and an independent signed exact-candidate decision are
retained; the historical configuration is not a current policy attestation.

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
   qualification and impacted-test producer on the exact RC head.
2. Authenticate results against the producer manifest, derive the V1 intermediate
   result and V3-bound `effective-status.v2.json`, validate both complete schemas,
   then pass `source-qualification-v3-current` using newly collected complete
   required-check and V3-subject evidence; the legacy currentness check alone is insufficient.
3. Retain exact-head/tree, workflow-definition, run/job/step and artifact
   digests; reject collisions, zero-job, skipped, stale or failed reruns.
4. Obtain an independent review of the exact new candidate and integrate through
   the repository's existing qualified merge boundary.
5. Complete issue #25 denial evidence and exact policy export.
6. Complete issue #28 hosted private legacy replay and acknowledgement.
7. Execute target-host listener/systemd/cgroup qualification in issue #17.
8. Execute destructive storage, reboot, corruption and 72-hour soak in issue #12.
9. Execute independent key lifecycle and compromise drills in issue #14.
10. Execute separated authenticated Codex author/reviewer canaries in issue #21.
11. Execute real KMS/HSM, WORM, release, portal and submission drills in issue
    #22.
12. Use the existing local/shadow service and cutover drills as source tests; only
    after all production prerequisites, complete capability/state translation and
    reverse compatibility are accepted perform production canary, rollback, writer
    cutover and Node-authority retirement.

## Canonical document set

- [`RUNTIME_MIGRATION_IMPLEMENTATION.md`](RUNTIME_MIGRATION_IMPLEMENTATION.md)
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
