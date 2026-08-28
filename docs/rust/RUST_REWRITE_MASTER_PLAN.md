# hepta-paper Rust control-plane rewrite master plan

Status: **working plan v2.0 — Codex-first, OpenClaw excluded**  
Baseline reviewed: `main@d2868944ecc5a6c081bcb42d67fc0643ecbecd0f` (2026-08-28)  
Target: first-party production control plane in Rust with compatibility-preserving cutover

## 1. Executive decision

hepta-paper will be rewritten as a Rust control plane, but it will not be
implemented as a line-by-line translation of the current Node tree. The rewrite
is organized around independently cuttable capabilities and externally
verifiable invariants.

Codex is the only first-party model execution backend in the target
architecture. OpenClaw is not a Rust compatibility target, does not define a
Rust domain contract, and must not be imported into the Rust dependency graph.
The existing Node/OpenClaw implementation remains legacy production behavior
until its consumers are retired or migrated; deleting it is a late cutover
activity, not a Foundation activity.

The first supported provider transport is a qualified, content-pinned Codex CLI
invoked through `codex exec --json --ephemeral --output-schema`. The control
plane treats Codex as an untrusted, cost-bearing, non-deterministic external
operation. It is not a database writer, evidence authority, release authority,
or submission authority.

## 2. Outcomes

The rewrite is complete only when all of the following are true:

1. Every first-party production control-plane writer is Rust.
2. Historical hashes, receipts, SQLite state and release packages remain
   verifiable across the language boundary.
3. Node and Rust never write the same production database concurrently.
4. Codex credentials are unavailable to the Rust campaign core and campaign
   authority is unavailable to the Codex broker.
5. Author, reviewer and formal reviewer executions are isolated by role,
   process, home, workspace, credential root and fresh session policy.
6. A provider process that may have started is never silently retried as though
   no external operation occurred.
7. Actual workspace changes, not agent self-report, determine mutation policy
   compliance.
8. Rust does not elevate evidence class, scientific validity, release readiness
   or submission authority merely because a workflow was migrated.
9. Every capability cutover has a tested rollback path and a named owner.
10. OpenClaw does not appear in the target Rust runtime graph.

## 3. Scope

### 3.1 In scope

- canonical record encoding and historical hash verification;
- versioned domain contracts, errors, statuses and command results;
- read-only and later writer-compatible SQLite access;
- campaign planning, claims, leases, generation fencing and prepared results;
- copy-on-write attempt workspaces, content-addressed artifacts and recovery;
- Codex runtime identity, broker protocol, process execution and operation
  journal;
- author/reviewer role profiles and mutation verification;
- formal, empirical and numerical orchestration and evidence packaging;
- release, KMS/HSM, WORM, backup, restore and submission handoff authority;
- shadow execution, canary, cutover and rollback;
- CI, fuzzing, crash injection, observability and operator runbooks.

### 3.2 Explicitly out of scope

- Rust adapters for OpenClaw;
- a generic provider plug-in framework built for hypothetical backends;
- replacing Codex itself or reimplementing its model runtime;
- rewriting external scientific runtimes merely to satisfy a language purity
  metric;
- byte-for-byte equality of model-generated prose or code;
- production App Server/WebSocket transport before an independent qualification
  decision;
- hidden dependency on persisted Codex sessions;
- giving Codex release, KMS, portal, backup, WORM or submission credentials.

## 4. Architectural invariants

The following invariants are release blockers, not recommendations.

| ID | Invariant |
|---|---|
| INV-001 | Campaign state has exactly one authoritative writer at a time. |
| INV-002 | Every mutation is fenced by campaign revision, attempt ID and lease generation. |
| INV-003 | Provider execution never writes the campaign database or trusted receipt ledger. |
| INV-004 | A reviewer cannot mutate canonical source or author attempt state. |
| INV-005 | Codex execution is one-shot and ephemeral unless a future version explicitly qualifies resume. |
| INV-006 | Unknown terminal-like JSONL events fail closed. |
| INV-007 | Terminal success requires bounded stream capture, schema validation and workspace mutation validation. |
| INV-008 | Spawn-after ambiguity requires a new attempt and conservative cost treatment. |
| INV-009 | Prepared results are recoverable without repeating provider execution. |
| INV-010 | Credential material is never serialized into requests, receipts, logs or hashes. |
| INV-011 | Historical V1 canonicalization is immutable; corrections use a new version. |
| INV-012 | Language migration does not increase evidence assurance. |
| INV-013 | Release and submission authority stay outside the model execution trust domain. |
| INV-014 | Rust/OpenClaw production dependencies are forbidden. |
| INV-015 | Every external side effect has a durable operation identity and recovery disposition. |

## 5. Target topology

```text
operator / scheduler
        |
        v
hepta Rust control plane
  domain + campaign + policy + state + evidence
        |
        | signed, expiring CodexExecutionRequestV1
        v
role-specific Unix-socket broker
  runtime identity + operation journal + bounded process control
        |
        | pinned codex executable, fresh session, isolated workspace
        v
codex exec --json --ephemeral --output-schema
        |
        v
bounded JSONL -> schema verifier -> mutation verifier -> prepared result
        |
        v
campaign integration guarded by revision + lease generation
```

Separate production principals are required for author and reviewer brokers.
The local MVP may use bounded local independence, but it must never claim
provider-account independence that has not been established.

## 6. Delivery workstreams

### A — Compatibility and canonicalization

Owns legacy stable JSON, record hashes, status/error registry, fixture corpus,
Node oracle, cross-language verification and contract versioning.

Exit signal: all historical fixtures verify and unexplained serialization drift
is zero.

### B — Domain and application contracts

Owns Rust domain types, ports, command results, state-machine invariants,
authority boundaries and dependency rules. Provider-specific JSON must not leak
into these contracts.

Exit signal: domain crates compile without filesystem, SQLite, process, network
or Codex dependencies.

### C — SQLite and ledger

Owns schema 1–25 read compatibility, migration catalog, writer transactions,
leases, generation fencing, prepared-result integration, ledger verification,
backup and restore metadata.

Exit signal: deterministic logical diff is zero and stale generations cannot
commit under stress.

### D — Filesystem, CAS and recovery

Owns descriptor-relative filesystem access, COW attempt workspaces, inventory
hashes, CAS, no-clobber publication, fsync boundaries, kill injection,
retention and restore.

Exit signal: every injected crash recovers to one valid state without orphaned
canonical mutations.

### E — Campaign engine and resource governance

Owns campaign DAGs, claims, retries, pause/resume/cancel, budget reservations,
resource governor, fairness, admission control and scheduler observability.

Exit signal: long-running stress tests show no stale commits, duplicate
integration or unexplained budget settlement.

### F — Codex broker

Owns transport qualification, executable identity, credential boundary, Unix
peer authorization, request verification, JSONL decoding, process groups,
deadlines, output limits, operation journal and receipts.

Exit signal: a broker compromise cannot mutate campaign authority and a Codex
child cannot read control-plane or role-peer credentials.

### G — Scientific evidence

Owns formal, empirical and numeric orchestration, independent recomputation,
evidence capsules, reviewer binding and evidence-level policy.

Exit signal: producer and verifier implementation independence is demonstrated,
not inferred from separate binaries.

### H — Release and external authority

Owns attestation, KMS/HSM clients, immutable deployment, WORM custody, release
packages, submission permits and API/browser sidecars.

Exit signal: model principals have no access to external authority secrets and
all irreversible actions are idempotent or explicitly ambiguous.

### I — CI, SRE, security and documentation

Owns toolchain qualification, dependency policy, fuzzing, sanitizers, fault
injection, dashboards, runbooks, threat models, branch protection and release
criteria.

Exit signal: required checks are protected, reproducible and tied to explicit
acceptance evidence.

## 7. Milestones and gates

### M0 — Trusted Node baseline (weeks 0–6)

Deliverables:

- freeze and sign the compatibility baseline;
- classify production entrypoints and contracts;
- disposition known defects as preserve, fix-v2, read-only or retire;
- remove OpenClaw from the Rust target plan;
- publish the Rust TCB and parity matrix;
- require green baseline CI and protected merge checks.

Gate:

```text
unclassified entrypoints = 0
unclassified contracts = 0
known defects without disposition = 0
required baseline checks = green
```

### M1 — Compatibility kernel (months 2–4)

Deliverables:

- `LegacyStableJsonV1` and immutable fixture corpus;
- `HeptaCanonicalJsonV2` specification;
- Node oracle and Rust verifier;
- error/status/exit-code registry;
- deterministic cross-language property tests.

Gate:

```text
historical hash parity = 100%
receipt verification parity = 100%
unexplained canonical drift = 0
```

### M2 — Codex broker foundation (months 2–4, parallel with M1)

Deliverables:

- versioned execution request and receipt;
- strict JSONL decoder and fake Codex process;
- operation state machine and recovery classification;
- runtime identity contract;
- role profiles, environment scrub and peer authorization design;
- pinned toolchain and Rust CI.

Gate:

```text
unknown terminal event acceptance = 0
reviewer write authority = 0
unbounded provider output paths = 0
unclassified post-spawn retry = 0
```

### M3 — Read-only Rust control plane (months 3–5)

Deliverables:

- schema-25 read-only inspector;
- campaign and artifact decoders;
- ledger/release verification;
- parity dashboard and fixture navigator;
- no production writes.

Gate: logical state, campaign plan, artifact inventory and authority checks have
zero unexplained diff.

### M4 — Local Codex research MVP (months 5–8)

Scope:

```text
one paper
one author invocation
one fresh reviewer invocation
one revision round
LaTeX build
local artifact bundle
no release promotion
no submission
```

Gate: Codex writes only a COW attempt; mutation validation precedes integration;
reviewer consumes a frozen read-only bundle; failed attempts cannot pollute the
next attempt.

### M5 — Persistent campaign alpha (months 8–12)

Deliverables: Rust SQLite writer, campaign lifecycle, leases and fencing,
prepared results, provider cost settlement, resource governor and durable Codex
operation linkage.

Gate: 10,000 simulated campaigns, 72-hour soak, zero stale-generation commit,
zero duplicate provider operation and zero duplicate prepared-result
integration.

### M6 — Filesystem/CAS/recovery beta (months 10–15)

Deliverables: descriptor-relative I/O, CAS, package transactions, fsync policy,
venue migration, retention, restore qualification and crash journal.

Gate: kill injection at every write/copy/rename/fsync boundary produces no
orphan workspace or marker/tree inconsistency.

### M7 — Scientific evidence beta (months 13–18)

Deliverables: formal, empirical and numeric verifier orchestration; evidence
capsules; post-revision review; producer/verifier implementation independence.

Gate: old/new producer-verifier cross-checks pass and language migration never
promotes evidence class.

### M8 — Release and authority RC (months 17–21)

Deliverables: release attestation, KMS/HSM command ports, state authority,
backup/restore, immutable deployment, WORM custody, release bundle and
submission handoff.

Gate: Codex cannot access authority secrets; old and new release verifiers are
cross-compatible; submission requires a separate single-use permit.

### M9 — Shadow, canary and cutover (months 20–24)

Sequence:

1. Rust read-only shadow.
2. Isolated Node/Rust dual execution.
3. Capability-by-capability writer cutover.
4. Stop all Node writers.
5. WAL checkpoint, backup and restore drill.
6. Record pre-cutover state hash.
7. Install the writer-ownership migration.
8. Rust canary, reboot drill and full restore drill.

Gate: 30-day shadow, 14-day authoritative canary, zero duplicate external
actions and zero unexplained state diff.

### M10 — Node control-plane retirement (months 24–26)

Allowed JavaScript after retirement is limited to immutable historical fixtures,
explicit compatibility oracles and non-authority sidecars. No active first-party
production control-plane writer may remain.

## 8. Increment strategy

Every merge must be a reversible vertical or invariant slice. A merge may add a
read-only Rust implementation while leaving Node authoritative. It may not add
a second production writer.

Recommended PR sequence:

1. Foundation contracts, JSONL decoder, operation state machine, fake Codex and
   CI.
2. Runtime identity and environment policy with a fake executable.
3. Broker process supervisor with deadlines, process-group kill and bounded
   stdout/stderr.
4. SQLite-backed operation journal and crash recovery.
5. Unix-socket request authentication and peer credentials.
6. COW workspace snapshot and mutation verifier.
7. Local author/reviewer vertical slice.
8. Read-only schema and compatibility kernel.

Each PR must identify:

- invariant(s) implemented;
- authority gained or explicitly not gained;
- compatibility oracle;
- failure and rollback behavior;
- deterministic tests and live tests;
- next blocked capability.

## 9. First 120 days

### Days 1–30

- ratify this plan and TCB;
- build the Rust workspace and CI;
- implement versioned request/receipt contracts;
- implement bounded JSONL parsing and fake Codex fixtures;
- implement operation transition and recovery model;
- inventory Node canonicalization, SQLite and agent contracts;
- freeze the compatibility baseline and defect disposition ledger.

### Days 31–60

- implement executable, config, credential-root and role identity inspection;
- implement environment allowlist and child-secret leakage tests;
- implement process group, deadline and output-bound supervisor;
- persist operation transitions in an isolated broker SQLite database;
- add Unix-socket protocol framing, peer credential checks and expiring request
  capabilities;
- add recorded real-Codex JSONL fixtures, scrubbed of secrets and prompts.

### Days 61–90

- implement schema-25 read-only inspection;
- implement Node hash oracle and Rust historical fixture runner;
- implement COW attempt workspace and before/after inventory;
- implement mutation allowlist verifier;
- run real author and reviewer smoke tests with independent homes;
- execute credential leakage and read-only reviewer qualification suites.

Decision gate at day 90:

```text
historical hash parity = 100%
schema read parity = 100%
credentials visible to Codex child commands = 0
reviewer canonical-source writes = 0
unexplained JSONL protocol events = 0
```

### Days 91–120

- build a local campaign planner;
- execute author -> build -> reviewer -> revise -> rebuild;
- write prepared-result recovery and failed-workspace discard;
- package local artifacts with complete input/output hashes;
- repeat the campaign under crash and cancellation injection;
- publish baseline cost, latency and ambiguity metrics.

Day-120 deliverable: a local, non-release-authoritative Rust/Codex research MVP
that proves the architecture, not a production cutover.

## 10. Quality system

Required test layers:

- unit tests for contracts, state machines and policy;
- golden fixtures for canonicalization and JSONL transcripts;
- property tests for parse/serialize/validate round trips;
- fuzzing for JSON, paths, receipts and protocol framing;
- fake-process fault injection for malformed streams, hangs, child leaks,
  signals, output limits and credential probes;
- SQLite crash and transaction tests;
- filesystem kill injection and restore qualification;
- Node/Rust differential tests for deterministic behavior;
- live Codex evaluation for quality and reliability, never textual equality;
- shadow and canary production evidence.

Live model metrics:

```text
draft completion rate
build completion rate
mutation violation rate
citation fabrication rate
unsupported-claim rate
review issue-detection recall
revision regression rate
cost per accepted campaign
P50/P95 latency
post-spawn ambiguous-call rate
```

## 11. Capacity and sequencing assumptions

A realistic program is 180–260 engineering person-months and 20–26 calendar
months with parallel workstreams. The estimate assumes a stable team spanning
Rust systems, database/recovery, security/SRE and scientific workflow expertise.
It excludes major product scope additions and independent scientific validation
labor.

The critical path is not Codex API plumbing. It is compatibility evidence,
SQLite writer ownership, filesystem crash safety, scientific assurance and
external authority cutover.

## 12. Governance

- This document is the planning source of truth; detailed backlog IDs live in
  `RUST_REWRITE_BACKLOG.md`.
- Architectural changes require an ADR before implementation.
- A milestone cannot be declared complete from code coverage alone; its exit
  evidence must be attached to a release or qualification receipt.
- A compatibility difference must be classified as intended, historical defect,
  tolerated nondeterminism or blocker.
- Any proposal to enable session resume, provider networking, MCP, plugins,
  App Server, danger-full-access or shared role credentials requires a new
  threat model and ADR.
- OpenClaw references in Rust source, manifests or runtime configuration are a
  CI blocker.

## 13. Definition of done

The program is done only after all M0–M10 gates pass, Node writer authority is
removed, rollback and restore drills have succeeded, external operations show
no duplicate side effects, and the production dependency graph contains no
first-party Node control-plane or Rust/OpenClaw path.
