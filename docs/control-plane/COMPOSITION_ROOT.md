# Rust central control-plane composition root

## 1. Purpose

The composition root is the only production location that chooses concrete
implementations for snapshots, policy, registry, planning, resources, brokers,
verification, state, and observability. Existing Rust crates are currently
capability islands; this component turns them into one executable control plane
without transferring provider, release, storage-custody, or submission secrets.

## 2. Proposed workspace units

```text
hepta-control-plane-protocol
hepta-module-registry
hepta-state-snapshot
hepta-policy-engine
hepta-candidate-router
hepta-scheduler-core
hepta-resource-allocator
hepta-execution-dispatch
hepta-result-verifier
hepta-commit-sequencer
hepta-control-plane-service
hepta-control-plane-testkit
```

A unit may initially be a crate rather than a deployable service. The process
boundary is selected by authority and failure isolation, not by team count.

## 3. Composition graph

```text
RegistrySnapshotProvider ─┐
CampaignReadModel ────────┤
ResourceStateProvider ────┤
QualificationProvider ────┼─> StateSnapshotBuilder
PolicyProvider ───────────┘             |
                                         v
                                  HardPolicyEngine
                                         |
                                         v
                                  CandidateRouter
                                         |
                                         v
                                  SchedulerCore
                                         |
                                         v
                                  ResourceAllocator
                                         |
                                         v
                                  ExecutionDispatcher
                                         |
                                         v
                                  ResultVerifier
                                         |
                                         v
                                  CommitSequencer
                                         |
                                         v
                                  Event/Observation sinks
```

Concrete SQLite, Unix socket, filesystem, CAS, and external-authority adapters
are injected at the root. Domain and scheduler code do not import them.

## 4. Startup sequence

1. Verify executable, configuration, deployment generation, and source identity.
2. Open all authority and policy files through canonical no-follow boundaries.
3. Open central state read-only and audit schema/integrity.
4. Open the single writer through its exact signed activation boundary, but do
   not acquire writer authority until all prerequisites hold.
5. Load and validate the static module registry.
6. Resolve the qualified deployment registry and reject missing/expired modules.
7. Reconcile broker journals, process identities, resource reservations,
   prepared results, and pending commit commands.
8. Build an initial immutable snapshot.
9. Verify deterministic planner self-tests and policy hashes.
10. Acquire the control-plane instance and writer generation leases.
11. Mark readiness only after every bound dependency is current.

A failure before readiness performs no provider call, campaign mutation, release,
or external action.

## 5. Planning loop

```text
observe trigger
  -> build snapshot
  -> derive eligible capabilities/modules
  -> request bounded candidates concurrently
  -> validate and canonicalize candidates
  -> solve or run deterministic fallback
  -> independently validate plan
  -> reserve resources and side-effect budgets
  -> persist plan intent
  -> dispatch selected commands
  -> consume bounded events
  -> verify prepared results
  -> submit fenced commit commands
  -> publish observations and update calibration
```

Triggers include campaign state changes, resource release, deadline approach,
module health/qualification changes, prepared results, operator actions, and
bounded periodic reconciliation.

## 6. Instance ownership

The control-plane service has a generation-fenced instance lease. A replacement
may take over after expiry/reconciliation; the stale instance cannot renew,
dispatch, release resources, or commit.

The service lease is distinct from:

- campaign/node leases;
- broker operation reservations;
- module execution identities;
- campaign-writer lease;
- external action capabilities.

## 7. Blocking work

Latency-sensitive planning and event handling use an asynchronous runtime or
bounded event loop. Blocking operations use named bounded pools/actors:

```text
state writer actor
SQLite/read-model pool
filesystem/hash/CAS pool
archive/compression pool
process wait/reap pool
external receipt verification pool
```

No unbounded `spawn_blocking`, thread-per-connection, or module-controlled pool
creation is permitted.

## 8. Authority ceiling

The central control plane may:

- read campaign and qualification state;
- request candidates;
- reserve resources;
- dispatch capabilities through brokers;
- verify results;
- request the commit sequencer to apply a validated transition.

It may not:

- read provider credential bytes;
- act as an author or reviewer;
- sign release artifacts;
- administer KMS/HSM or WORM storage;
- hold portal credentials;
- perform submission directly;
- bypass the campaign writer or external action journals.

## 9. Initial vertical slice

The first executable slice uses only:

- fake author and reviewer modules;
- one in-memory or fixture registry;
- one SQLite campaign fixture;
- existing workspace authority;
- deterministic baseline scheduler;
- existing campaign writer behind the commit-sequencer interface;
- no real provider, release, or external authority.

Acceptance requires crash injection before and after every durable boundary and
proves that provider work, prepared integration, and authoritative commits are
never duplicated.
