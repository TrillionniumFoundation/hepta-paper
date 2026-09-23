# hepta-paper Rust control-plane rewrite and authority migration master plan

Status: **plan v4.1 — active scoped migration subplan**
Global plan: [`../system/MASTER_PLAN.md`](../system/MASTER_PLAN.md)
Global architecture: [`../system/ARCHITECTURE.md`](../system/ARCHITECTURE.md)
Scoped static status: [`CURRENT_STATUS.md`](CURRENT_STATUS.md)
Scoped machine projection: [`current-status.v1.json`](current-status.v1.json)
Qualification rules: [`QUALIFICATION_STATE_MACHINE.md`](QUALIFICATION_STATE_MACHINE.md)

This document governs Rust source and authority migration only. It cannot define
a competing whole-system architecture, module ownership model, scheduler
objective, or global status. Those subjects are canonical under `docs/system`,
`docs/modules`, and `docs/control-plane`.

## 1. Mission

Replace first-party production control-plane authority with Rust without
changing historical meaning, adding a second writer, or transferring campaign,
scientific, release or submission authority into the model-execution domain.

This is a control-plane and authority migration, not a blanket rewrite of every
scientific/data-plane implementation. The migration is complete only after
capability-by-capability cutover evidence is accepted. Source availability,
successful unit tests or entry into `main` is never a production activation
event.

Codex is the only first-party model backend in the target Rust architecture.
OpenClaw remains historical Node behavior and is not a Rust dependency, feature,
profile or compatibility target.

## 2. Non-negotiable outcomes

1. Exactly one authoritative campaign writer exists at a time.
2. Historical hashes, receipts, SQLite state and release packages remain
   verifiable across the language boundary.
3. Every external operation has a durable identity before its irreversible
   effect and an explicit recovery disposition after ambiguity.
4. Codex credentials are absent from campaign, release and submission
   principals; campaign authority is absent from the Codex broker.
5. Author, reviewer, formal reviewer and repairer are separated by role,
   principal, home, workspace, socket, journal and capability audience.
6. Actual filesystem change, not agent self-report, is mutation truth.
7. Language migration never upgrades evidence or scientific assurance.
8. Every cutover has a tested rollback and a named owning authority.
9. Production claims bind exact commit, tree, binary, configuration, host and
   external-authority evidence.
10. No missing external authority is replaced by a local fixture, repository
    administrator or self-signed record.
11. A committed source document never self-promotes its own qualification.
12. One immutable release-candidate branch and one integration PR are the only
    accepted convergence surface.

## 3. Static and effective status

Plan v4 separates implementation from qualification.

- `source_implemented` is committed static truth.
- `source_qualified` is an exact-head result derived from a non-empty complete
  workflow matrix.
- `blocked_external` means the repository cannot manufacture the required fact.

The exact promotion, invalidation and demotion rules are normative in
`QUALIFICATION_STATE_MACHINE.md`.

Every effective source result must bind:

```text
repository ID and full name
pull request number
exact base repository/ref/commit/tree
exact head repository/ref/commit/tree
tested synthetic merge commit/tree
static machine-truth digest
required check contexts
producer workflow IDs, paths, Git blobs and SHA-256 digests
complete eligible workflow run/attempt history and its canonical set hash
selected run/attempt, check-suite, job and non-empty step identities
capability-to-context evidence mapping
normalized check, artifact, review and policy snapshot identities
non-authority statement
```

A base, head, tested-merge, producer-definition, eligible-run-history, artifact,
or review change invalidates the retained result. Missing or colliding jobs,
skipped jobs, dirty postflight, stale review, or a newly accepted P0 defect also
invalidate it. Any mutation of an eligible old or new run/attempt changes the
complete run-set identity. A new success requires fresh derivation; a new
non-success demotes immediately.

The current RC implements most producer-origin and schema protections but does
not yet satisfy this complete subject. G0 and
`docs/qualification/QUALIFICATION_SUBJECT_V3.md` are the mandatory first gate.

## 4. Release-blocking invariants

| ID | Invariant |
|---|---|
| INV-001 | Campaign state has exactly one authoritative writer. |
| INV-002 | Every mutation is fenced by campaign revision, attempt ID and lease generation. |
| INV-003 | Provider execution cannot write campaign state or trusted receipt ledgers. |
| INV-004 | Reviewer roles cannot mutate canonical source or author attempt state. |
| INV-005 | V1 provider sessions are fresh, one-shot and non-resumable. |
| INV-006 | Unknown terminal-like JSONL events fail closed. |
| INV-007 | Success requires bounded stream, schema and mutation validation. |
| INV-008 | Post-release ambiguity requires a new attempt and conservative cost treatment. |
| INV-009 | Prepared results integrate without repeating provider work. |
| INV-010 | Credential bytes never enter requests, receipts, logs, hashes or artifacts. |
| INV-011 | Historical V1 canonicalization is immutable. |
| INV-012 | Migration never elevates assurance level. |
| INV-013 | Release/submission authority stays outside model execution. |
| INV-014 | Rust/OpenClaw runtime dependency count remains zero. |
| INV-015 | Every external effect has durable intent, outcome and reconciliation. |
| INV-016 | Production child containment survives `setsid`, double fork and descendant escape attempts. |
| INV-017 | A listener configuration proves an intended authorized principal and rejects non-authorized principals. |
| INV-018 | Exact-head evidence binds source commit, tree, tested ref, workflows and produced artifacts. |
| INV-019 | `main` admits changes only through a no-bypass protected merge boundary with current-head checks and independent review. |
| INV-020 | Zero-job, skipped-required-job and `action_required` runs never count as qualification. |
| INV-021 | Qualification automatically demotes when its exact-head or evidence preconditions cease to hold. |
| INV-022 | A writer-cutover permit binds exact runtime subject, database preimage and first writer lease. |
| INV-023 | Confidential legacy replay evidence cannot be replaced by the public minimal fixture. |
| INV-024 | A required check is accepted only from its manifest-bound workflow definition and exact PR run. |
| INV-025 | No capability is promoted without a non-empty capability-specific evidence mapping. |
| INV-026 | Any producer-run mutation invalidates a retained effective artifact until live revalidation succeeds. |

## 5. Target topology

```text
operator / scheduler
        |
        v
Rust campaign control plane
  domain + policy + state + evidence + single writer
        |
        | signed expiring request capability
        v
role-specific Unix broker
  peer identity + trust bundle + broker journal + containment
        |
        | durable blocked launch -> release authorization
        v
qualified codex exec --json --ephemeral --output-schema
        |
        v
bounded events -> schema verifier -> COW mutation verifier -> prepared result
        |
        v
campaign integration fenced by revision + lease generation
        |
        v
release/submission ports owned by separate external authorities
```

The broker and model domains never acquire campaign writer, release, KMS/HSM,
WORM or submission credentials.

## 6. Workstreams

### FND — contracts and program truth

Versioned request/receipt types, canonical digests, strict JSONL, operation
state machine, fake executor, pinned toolchain, supply-chain policy, static
machine truth and effective exact-head qualification.

Repository-local exit:

- exact-head format, lint, tests and rustdoc pass;
- dependency policy and SBOM are retained;
- human status/backlog/parity projections match machine truth;
- the `effective-status.v1.json` derivation authenticates workflow producers and
  rejects missing, colliding, zero-job, zero-step, skipped and stale check sets;
- every promotable row has a non-empty capability-specific context mapping;
- the complete normalized check evidence and effective artifact pass their
  committed JSON Schemas;
- `source-qualification-current` rejects any producer-run mutation until a fresh
  artifact is derived.

### BRK — broker, runtime and durable launch

Executable/home identity, environment scrubbing, listener/peer/capability
admission, broker SQLite, durable pre-exec gate, containment, recovery and
prepared acknowledgement.

Repository-local exit: source and hosted-installed fixtures prove the protocol,
listener admission, durable gate and cgroup-v2 source contract.

Production exit: issue #17 supplies independent target-host/service evidence,
issue #14 supplies key-owner evidence and issue #21 supplies authenticated
Codex canaries.

### WS — workspace and mutation authority

Descriptor-bound root opening, COW attempts, deterministic inventory, versioned
role mutation policy, prepared workspace results and orphan recovery.

Repository-local exit:

- every traversed object remains descriptor bound;
- symbolic links, regular-file hard links, special nodes, nested devices and
  over-cap trees fail closed;
- regular files are hashed twice and copied bytes are reverified;
- canonical source remains untouched before fenced integration;
- injected races/crashes yield a classified residue.

Target-host filesystem and storage behavior remains part of issues #17 and #12.

### CMP — compatibility kernel

Legacy stable JSON, historical hash corpus, Node oracle, Rust verifier,
status/error registry and deterministic differentials.

Repository-local exit: zero unexplained byte/hash/authority drift in the public
frozen corpus.

Full migration exit: issue #28 supplies the retained secret-gated 263-file
hosted replay receipt and independent acknowledgement.

### RO — read-only control plane

Immutable schema-1..25 SQLite inspection, campaign/artifact/ledger decoding and
normalized parity bundles.

Repository-local exit: no write flags, WAL creation or sidecar mutation in the
supported fixture matrix.

### MVP — local research vertical slice

One fake-provider author/reviewer loop, prepared results, COW workspaces,
read-only review and replay-safe integration.

Repository-local exit: crash/cancel/retry does not duplicate fake-provider work
or pollute canonical source. A fake provider can never satisfy issue #21.

### DB — persistent Rust writer

Writer ownership, claims, leases, generation fencing, prepared integration,
budgets, resource reservations, backup/restore and deterministic simulation.

Repository-local exit:

- public raw writer-open authority is absent;
- cutover requires exact-subject Ed25519 verification;
- database preimage and first writer lease are bound;
- Node/Rust dual write is mechanically fenced;
- prepared integration is replay-idempotent;
- backup/restore source drills pass;
- the 10k deterministic simulation has zero stale or duplicate commit.

Production exit: issue #12 supplies the real 72-hour topology soak, reboot,
disk-full and corruption drills.

### EVD — scientific evidence

Formal, empirical and numerical orchestration with producer/verifier
implementation independence.

Repository-local exit: migration does not increase evidence class and source
cross-verifier contracts pass. Any external assurance still requires its real
independent producer or reviewer.

### REL — release and external authority

KMS/HSM command ports, immutable deployment, WORM custody, backup authority,
release packages, submission permits and dispatch.

Repository-local exit: narrow receipt-verifying ports and denial boundaries pass
source tests.

Production exit: issue #22 supplies real KMS/HSM, WORM, release, portal and
submission receipts while model principals retain zero external-authority
secret.

### CUT — shadow, cutover and retirement

Read-only shadow, isolated dual execution, capability writer cutover, rollback,
canary and Node-authority retirement.

Repository-local exit: phase transitions, writer fencing, receipt verification
and rollback contracts pass.

Production exit: all prerequisite target-host and external-authority issues are
accepted, followed by the required shadow, canary and final retirement evidence.

## 7. Milestone gates

| Milestone | Required outcome | Minimum evidence |
|---|---|---|
| M0 Program truth | static/effective truth, baseline, entrypoints, defects and TCB classified | source |
| M1 Compatibility kernel | public historical byte/hash/authority parity | source |
| M1X Full legacy replay | 263-file confidential replay and independent acknowledgement | hosted installed + independent review |
| M2 Broker foundation | strict protocol, journal, launch, access and containment | target host for production use |
| M3 Read-only control plane | schema-25 and artifact/ledger parity, no writes | source |
| M4 Local research MVP | author/build/reviewer/revise package, no release | hosted installed + qualified provider |
| M5 Persistent alpha | single writer, fencing, budgets, backup, 10k simulation, 72h soak | target host |
| M6 Filesystem/CAS beta | COW/CAS/package crash matrix and restore | target host |
| M7 Evidence beta | independent recomputation and cross-verifier proof | external where required |
| M8 Release RC | KMS/HSM/WORM/release/submission handoff | external authority |
| M9 Cutover | shadow, canary, rollback and ownership migration | target host + external authority |
| M10 Retirement | no active first-party Node writer | release evidence |

Dates are forecasts, never gate substitutes.

## 8. Single-RC convergence sequence

1. Use only `codex/rust-plan-v4-rc1-20260831` for remaining repository-local
   convergence.
2. Integrate the descriptor-bound workspace and signed writer-cutover P0 patch.
3. Replace self-asserted qualification with static/effective machine truth.
4. Run the complete producer-authenticated context set on the exact unchanged RC
   head.
5. Derive the capability-specific artifact, validate it against the complete
   committed schema, and pass live currentness revalidation.
6. Retain producer definitions, run/job/step snapshot identity, exact-head/tree
   and supply-chain artifacts.
7. Obtain independent latest-push review.
8. Integrate the RC into the sole product branch and close duplicate P0 PRs.
9. Refresh the product integration PR and repeat its entire exact-head matrix.
10. Complete governance issue #25 and legacy replay issue #28.
11. Execute issues #17, #12, #14, #21 and #22 in dependency order.
12. Perform production shadow, canary, rollback, writer cutover and Node
    retirement only after every prerequisite is accepted.

No branch, package or issue may bypass a dependency by relabelling a fixture,
GitHub-hosted runner, self-signed record or implementation-author approval as
target-host or external-authority evidence.

## 9. Merge contract

Every PR must state:

```text
exact base/head commit and tree
stable backlog, parity, invariant and blocker IDs
authority gained and authority explicitly retained elsewhere
deterministic, adversarial, crash and differential tests
static-status and effective-evidence impact
rollback and recovery behavior
documentation and operator impact
remaining blockers and their true owner
```

Required checks run on the exact head. A previous head's result is never reused.
A PR with zero jobs, a missing context, an unsigned direct update to protected
`main`, unresolved conversations or an active request-changes decision remains
blocked.

The implementation author does not independently approve repository governance,
target-host, credential, key-custody, release or submission evidence.

## 10. Quality system

Mandatory repository-local layers:

```text
actionlint over every GitHub Actions workflow
rustfmt
clippy --all-targets --all-features -D warnings
workspace tests
rustdoc -D warnings
protocol golden vectors
property/adversarial corpora
SQLite transaction and recovery tests
filesystem race and crash tests
Node/Rust deterministic differentials
secret/redaction scans
cargo-deny advisory/license/source/version policy
CycloneDX 1.5 all-feature/all-target SBOM
exact-head/tree and clean-worktree evidence
static/backlog/parity/package semantic validation
non-empty required check-run aggregation
```

Production layers additionally require real principal topology,
cgroup/service containment, reboot and storage drills, independently controlled
credentials, long-lived signed evidence and an accepted rollback exercise.

## 11. External blockers

The repository may finish the schemas, collectors, verifiers and fail-closed
activation boundaries, but it cannot self-create:

- the issue #25 independent governance denial package;
- the issue #28 private secret-bearing hosted legacy replay receipt;
- issue #17 target-host ownership and Linux review;
- issue #12 destructive storage/reboot/corruption/72-hour evidence;
- issue #14 independently owned key lifecycle evidence;
- issue #21 real credential custody and authenticated Codex canaries;
- issue #22 KMS/HSM, WORM, release, portal and submission authority receipts.

These remain blocked until their real owners execute and independently attest
the defined packages.

## 12. Stop conditions

Development or promotion stops when:

- the candidate head or canonical machine truth changes during qualification;
- a required context is absent, skipped or non-successful;
- source/tree/binary/configuration evidence cannot be bound;
- an identity mismatch would require signaling an unproven process;
- a proposed change creates Node/Rust dual-write authority;
- a failure residue has no deterministic recovery state;
- a required external authority is unavailable;
- a test or document would overstate the evidence tier;
- an external fact would have to be fabricated to claim closure.
