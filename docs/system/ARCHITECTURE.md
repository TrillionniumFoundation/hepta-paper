# hepta-paper target system architecture

This document is the normative global architecture. `paper-core/docs/ARCHITECTURE.md`
describes the current Node implementation; `docs/rust/RUST_REWRITE_MASTER_PLAN.md`
describes the Rust migration. Neither may contradict this document.

## 1. Architectural style

The target is a **modular monorepo with explicit process boundaries**, not an
immediate microservice decomposition.

- Pure policy, protocol, planning, and deterministic verification remain library
  components where process isolation provides no security or scaling benefit.
- Model execution, language runtimes, GPU jobs, the campaign writer, release
  signing, immutable-storage custody, and submission run behind process or
  external-service boundaries because they differ in authority, failure mode,
  cost, or resource control.
- Modules communicate through versioned values and prepared effects. They do not
  share mutable implementation objects across ownership boundaries.
- The central control plane is small, deterministic where possible, and denied
  provider, release, KMS/HSM, WORM, and submission credentials.

## 2. Logical planes

### 2.1 Control plane

Owns state snapshots, hard constraints, planning, admission, dispatch,
reconciliation, verification orchestration, and commit sequencing.

It may decide **what** candidate to execute and **when**, but it does not perform
scientific work, hold model credentials, or sign releases.

### 2.2 Module execution plane

Contains author, reviewer, formal, empirical, numerical, build, package,
compatibility, and specialized worker modules. Each execution is bound to:

```text
module id and version
capability id
input snapshot hash
candidate and plan hash
attempt and lease generation
resource reservation
workspace and artifact roots
protocol version
deadline and cancellation identity
authority audience
```

Execution returns a prepared result. A module cannot assert that its result is
accepted, globally optimal, scientifically valid, or committed.

### 2.3 State and commit plane

The event log and projections are authoritative only through the single-writer
commit sequencer. Read models may be replicated and cached; write authority is
not.

The sequencer validates campaign revision, attempt, lease generation,
reservation settlement, prepared-result identity, policy version, and plan
subject in one short transaction.

### 2.4 Evidence plane

Independent producers and verifiers bind scientific, operational, migration,
performance, and authority evidence to exact subjects. Evidence classes do not
upgrade automatically during language migration.

### 2.5 External authority plane

KMS/HSM, WORM storage, release promotion, deployment, portal mutation, and
submission remain separately administered. The repository contains narrow
request/receipt ports and verifiers, never substitute credentials or self-issued
acceptance.

## 3. Core components

```text
hepta-protocol
  canonical IDs, digests, envelopes, status/error registry

hepta-module-registry
  version, capability, protocol, owner, authority, SLO, rollout metadata

hepta-snapshot-builder
  immutable campaign/read-model/resource/qualification snapshot

hepta-policy-engine
  hard authority, evidence, budget, dependency and compatibility constraints

hepta-candidate-router
  bounded concurrent candidate requests and validation

hepta-scheduler-core
  pure deterministic plan construction and explanation

hepta-optimizer-port
  optional exact/near-optimal solver behind a verified interface

hepta-resource-allocator
  hierarchical quotas, DRF, aging, reservations, deadlines and backpressure

hepta-dispatcher
  role-specific broker routing and execution lifecycle

hepta-result-verifier
  schema, mutation, artifact, evidence and policy verification

hepta-commit-sequencer
  sole authoritative state writer

hepta-observation-store
  bounded metrics, outcomes and calibration data
```

Existing Rust crates are migration inputs to these components. Similar or
adjacent crates must receive an explicit canonical-owner or retirement decision
before production composition.

## 4. Module boundaries

A module is an independently owned, versioned implementation of one or more
capabilities. A crate or package is not automatically a module, and one module
may contain several internal crates.

A valid module boundary has:

- stable capability IDs;
- a narrow input/output contract;
- no hidden central state access;
- declared authority class;
- declared resource vector and concurrency limits;
- deterministic/idempotent semantics where applicable;
- fault and cancellation behavior;
- conformance tests and SLOs;
- owner, secondary owner, reviewer, and rollback version.

Module internals may change without system-wide coordination when the public
contract, declared resource/SLO envelope, and authority remain compatible.

## 5. Allowed dependency direction

```text
protocol / kernel values
        ↑
domain policy and module contracts
        ↑
application use cases / control algorithms
        ↑
adapters and execution backends
        ↑
composition roots and executable entrypoints
```

Forbidden patterns:

- domain importing adapters or executable composition;
- module implementation importing another module's private implementation;
- worker importing campaign-writer authority;
- release/submission adapter imported into research execution graphs;
- compatibility or historical reference code entering production authority;
- central scheduler importing provider-specific credentials or SDK state.

## 6. Data and state ownership

| State | Owner | Writers |
|---|---|---|
| campaign DAG and lifecycle | campaign state plane | commit sequencer only |
| broker operation journal | role-specific broker | that broker service only |
| workspace attempt | workspace authority | owning attempt process under policy |
| prepared result | execution module + verifier | append/create-only until integration |
| resource reservations | resource allocator | allocator/sequencer transaction boundary |
| module registry | deployment/governance authority | reviewed registry publisher |
| qualification ledger | qualification ingestion authority | verifier-owned writer |
| release/submission outbox | external action service | separately authorized dispatcher |

Read access does not imply write or signing authority.

## 7. Concurrency architecture

Concurrency has three controlled levels:

1. campaign-level parallelism;
2. DAG-node/module parallelism;
3. module-internal parallelism.

All three consume centrally visible reservations. A module may not create
unbounded child concurrency outside its declared envelope.

Campaign-local decisions may be serialized by campaign actors/shards while the
global allocator arbitrates scarce shared resources. Blocking filesystem,
SQLite, hashing, process wait, and archive work runs in bounded blocking pools or
dedicated actors, not on the control plane's latency-sensitive executor.

## 8. Optimization boundary

Modules return feasible candidates or Pareto frontiers. The central planner
normalizes them against a common objective and independently validates:

- dependency feasibility;
- authority and evidence requirements;
- resource and budget feasibility;
- deadline and compatibility;
- side-effect and rollback class;
- prediction bounds and candidate expiry.

Only the central planner chooses the combination. Only the commit sequencer
makes the resulting state authoritative.

## 9. Failure model

The architecture assumes process death, host restart, duplicate delivery,
out-of-order completion, stale leases, partial filesystem work, provider
ambiguity, unavailable modules, and stale qualification.

Recovery never infers success from absence. Every durable stage has an explicit
reconciliation disposition:

```text
not_started
reserved
blocked_pre_execution
execution_may_have_started
prepared
verified
commit_pending
committed
rejected
manual_identity_mismatch
```

A result with an unclassified disposition cannot be retried or committed.

## 10. Deployment topology

The first production topology remains a bounded single-site control plane with
role-separated local services and external authority ports. The protocol must
not assume a distributed cluster, but identities, idempotency, snapshots, and
leases must permit later horizontal execution-plane scaling.

Immediate multi-repository or microservice decomposition is rejected because it
would multiply version combinations and evidence subjects while the module
protocol and Rust composition root are still changing.

## 11. Architecture fitness functions

CI must enforce:

- no dependency cycles in production graphs;
- allowed layer/module imports;
- no direct central writer outside the sequencer;
- module manifest and capability coverage;
- bounded public exports and dependency fanout;
- protocol golden vectors across Rust and Node;
- exact resource and side-effect declarations;
- documentation and CODEOWNER consistency;
- no historical document paths in the working tree.
