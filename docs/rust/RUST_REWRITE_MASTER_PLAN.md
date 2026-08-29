# hepta-paper Rust control-plane rewrite master plan

Status: **plan v3.0 — invariant-first, evidence-tiered, Codex-first**
Canonical status: [`CURRENT_STATUS.md`](CURRENT_STATUS.md)
Machine truth: [`current-status.v1.json`](current-status.v1.json)

## 1. Mission

Replace first-party production control-plane authority with Rust without
changing historical meaning, adding a second writer, or transferring campaign,
scientific, release or submission authority into the model-execution domain.
The rewrite is complete only after capability-by-capability cutover evidence is
accepted. Source availability alone is never a production activation event.

Codex is the only first-party model backend in the target architecture.
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
6. Actual filesystem change, not agent self-report, is the mutation truth.
7. Language migration never upgrades evidence or scientific assurance.
8. Every cutover has a tested rollback and a named owning authority.
9. Production claims are tied to exact commit, tree, binary, configuration,
   host and external-authority evidence.
10. No missing external authority is replaced by a local fixture or self-signed
    record.

## 3. Status and evidence model

Capability status and evidence tier are independent dimensions. The allowed
status vocabulary is defined in `CURRENT_STATUS.md`. Evidence tiers are:

| Tier | What it proves | What it never proves |
|---|---|---|
| design | reviewed contract and acceptance criteria | executable behavior |
| source | exact source passed deterministic gates | installed host or real credential facts |
| hosted installed | disposable hosted runner exercised real UIDs/files | production host ownership/custody |
| target host | named target host passed destructive drills | external key/provider authority |
| external authority | separately controlled owner issued evidence | unrelated capabilities |

A milestone gate is green only when every required item has the minimum status
and evidence tier specified by that gate.

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
| INV-017 | A listener configuration has at least one proven authorized principal and rejects every non-authorized principal. |
| INV-018 | Exact-head evidence binds source commit, tree, tested ref, workflow and produced binaries. |

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

## 6. Workstreams

### FND — contracts and protocol

Versioned request/receipt types, canonical digests, strict JSONL, operation
state machine, fake executor and pinned toolchain.

Exit: exact-source fmt, lint, test and rustdoc are green with a committed lock.

### BRK — broker, runtime and durable launch

Executable/home identity, environment scrubbing, listener/peer/capability
admission, broker SQLite, durable pre-exec gate, containment, recovery and
prepared acknowledgement.

Exit: authorized role UIDs can reach only their listener; escaped descendants
remain contained; every ambiguous launch has one durable disposition.

### WS — workspace and mutation authority

Descriptor-relative root opening, COW attempts, deterministic inventory,
versioned role mutation policy, prepared workspace results and orphan recovery.

Exit: canonical source is untouched until fenced integration and every injected
crash yields a classified workspace.

### CMP — compatibility kernel

Legacy stable JSON, historical hash corpus, Node oracle, Rust verifier,
status/error registry and deterministic differentials.

Exit: zero unexplained byte/hash/authority drift.

### RO — read-only control plane

Immutable schema-1..25 SQLite inspection, campaign/artifact/ledger decoding and
normalized parity bundles.

Exit: no write flags, WAL or sidecar mutation; normalized diff is zero.

### MVP — local research vertical slice

One author, build, frozen reviewer, revision, rebuild and local package using
prepared results and COW workspaces.

Exit: crash/cancel/retry does not duplicate provider work or pollute canonical
source.

### DB — persistent Rust writer

Writer ownership, claims, leases, generation fencing, prepared integration,
budgets, scheduler, backup/restore and soak testing.

Exit: Node/Rust dual write is mechanically impossible and 72-hour soak has zero
stale or duplicate commit.

### EVD — scientific evidence

Formal, empirical and numerical orchestration with producer/verifier
implementation independence.

Exit: migration does not increase evidence class and cross-verifier matrices
pass.

### REL — release and external authority

KMS/HSM command ports, immutable deployment, WORM custody, backup authority,
release packages, submission permits and dispatch.

Exit: model principals hold no external authority secret; every irreversible
operation is idempotent or explicitly ambiguous.

### CUT — shadow, cutover and retirement

Read-only shadow, isolated dual execution, capability writer cutover, rollback,
canary and Node authority retirement.

Exit: 30-day shadow and 14-day canary complete with zero unexplained state diff
or duplicate side effect.

## 7. Milestone gates

| Milestone | Required outcome | Minimum evidence |
|---|---|---|
| M0 Program truth | baseline, entrypoints, defects, TCB, plan and protected checks classified | source |
| M1 Compatibility kernel | historical byte/hash/authority parity | source |
| M2 Broker foundation | strict protocol, journal, launch, access and containment | target host for production use |
| M3 Read-only control plane | schema-25 and artifact/ledger parity, no writes | source |
| M4 Local research MVP | author/build/reviewer/revise package, no release | hosted installed + qualified provider |
| M5 Persistent alpha | single writer, fencing, budgets, backup, 10k simulation, 72h soak | target host |
| M6 Filesystem/CAS beta | COW/CAS/package crash matrix and restore | target host |
| M7 Evidence beta | independent recomputation and cross-verifier proof | external where required |
| M8 Release RC | KMS/HSM/WORM/release/submission handoff | external authority |
| M9 Cutover | shadow, canary, rollback and ownership migration | target host + external authority |
| M10 Retirement | no active first-party Node writer | release evidence |

Dates are forecasts, never gate substitutes. A milestone does not pass because
its calendar window elapsed.

## 8. Current package sequence

The next merge-sized packages are ordered by dependency:

1. `RUST-GOV-TRUTH-V1` — canonical status, machine truth and exact-evidence schema.
2. `RUST-BRK-LISTENER-ACCESS-V2` — explicit private/shared-group listener modes.
3. `RUST-BRK-EXACT-HEAD-CI-V1` — head/tree-bound workflow evidence.
4. `RUST-BRK-CONTAINMENT-V1` — cgroup-v2/pidfd production containment.
5. `RUST-WS-COW-INVENTORY-V1` — descriptor-relative COW and exact inventory.
6. `RUST-CMP-LEGACY-JSON-V1` — frozen corpus, Node oracle and Rust verifier.
7. `RUST-RO-SCHEMA25-V1` — immutable read-only store inspection.
8. `RUST-MVP-LOCAL-LOOP-V1` — one complete fake then qualified-provider loop.
9. `RUST-DB-SINGLE-WRITER-V1` — ownership lease and fenced writer alpha.

No package may bypass an unmet dependency by relabeling a fixture as external
evidence.

## 9. Merge contract

Every PR must state:

- exact base/head commit and tree;
- stable backlog and gap IDs;
- invariants implemented;
- authority gained and authority explicitly retained elsewhere;
- deterministic, adversarial, crash and differential tests;
- status/evidence tier changes;
- rollback and recovery behavior;
- documentation and operator impact;
- remaining blockers and their true owner.

Required checks must run on the exact head tree. The implementation author does
not independently approve target-host or external-authority evidence.

## 10. Quality system

Mandatory source layers:

```text
rustfmt
clippy --all-targets --all-features -D warnings
workspace tests
rustdoc -D warnings
protocol golden vectors
property tests
fuzz corpus
SQLite transaction/SIGKILL tests
filesystem race and crash tests
Node/Rust deterministic differentials
secret/redaction scans
supply-chain policy and SBOM
```

Production layers additionally require real principal topology, cgroup/service
containment, reboot and storage drills, independently controlled credentials,
long-lived signed evidence and an accepted rollback exercise.

## 11. Stop conditions

Development stops and the package remains blocked when any of these occurs:

- base or canonical truth changes during implementation;
- a required external authority is unavailable;
- an identity mismatch would require signaling an unproven PID/process group;
- evidence cannot bind the exact source/tree/binary/configuration;
- a proposed change creates Node/Rust dual-write authority;
- a failure residue cannot be classified into one recovery state;
- a test or document would overstate the evidence tier.
