# Node-to-Rust capability migration

## 1. Strategy

Migrate capability-by-capability behind stable module contracts. Do not treat the
repository as one indivisible rewrite and do not run two authoritative writers
for the same effect.

The current Node architecture remains the behavior/authority source until a
specific capability completes its cutover gate. Rust source presence or global
merge does not transfer authority.

## 2. Per-capability states

```text
node_authoritative
  -> rust_contract_ready
  -> rust_source_implemented
  -> rust_source_qualified
  -> rust_shadow
  -> rust_canary
  -> rust_authoritative
  -> node_retiring
  -> node_retired
```

An external/evaluation capability may require target-host or external-authority
evidence between source qualification and shadow/canary.

## 3. Capability record

Each migration record contains:

```text
capabilityId
Node entrypoints and authority paths
Rust module/crates
parity class: exact/semantic/evaluation/retire
known Node defects and approved correction decision
state/schema/protocol dependencies
shadow comparator or evaluator
cutover prerequisites
writer/external-effect mutual-exclusion group
rollback implementation/version
retirement evidence
```

## 4. Parity classes

### Exact

Bytes, hashes, statuses, rows, and accept/reject decisions match. Use golden and
adversarial corpora.

### Semantic

Representation may differ, but approved invariants, state transitions, and
effect class match. Use normalized projections and transition tables.

### Evaluation

Model-generated prose/code/reviews are not byte-compared. Bind inputs,
permissions, metrics, downstream deterministic checks, and independent quality
review.

### Retire

No Rust target. Prove the behavior is unreachable, authority is removed, and
historical artifacts remain verifiable.

## 5. Strangler adapters

The first module registry may point to Node legacy adapters. An adapter:

- receives the common versioned command;
- translates to the existing Node capability;
- preserves attempt/lease/idempotency/resource identity;
- returns the common prepared-result envelope;
- cannot add authority beyond the existing path;
- emits differential evidence for Rust shadow comparison.

Adapters are temporary and have retirement work items.

### Current generic Rust adapter source

`rust/crates/hepta-module-platform/src/legacy_adapter.rs` implements the common
`MIG-002` strangler boundary. A deployment supplies a closed set of exact Node
entrypoint, contract, translation-policy, parity, resource and cost bindings.
The adapter produces a deterministic candidate, persists a reserve-before-run
lifecycle in its caller-owned ledger, emits an immutable Node invocation, and
accepts only a bounded terminal observation. It returns a prepared result plus a
hash-bound differential receipt; it never launches Node or receives a central
writer or irreversible external-effect capability.

Exact duplicate retries are idempotent. Conflicting command, candidate,
invocation or observation reuse is rejected. A running or unknown execution is
classified for reconciliation, not retried as absent. Central-state-write or
irreversible-effect observations are rejected. These properties are covered by
Rust unit tests and the complete workspace formatting, Clippy, test and
documentation gates.

The source closes only the generic adapter implementation work item `MIG-002`.
`MIG-001` remains open for the complete incumbent capability inventory and
`MIG-004` remains open for per-capability shadow/evaluation integration. No
static record advances to shadow, canary, authoritative, retiring or retired.

## 6. Duplicate crate resolution

Before production composition, adjacent Rust responsibilities receive one
canonical decision, including:

```text
hepta-workspace vs hepta-workspace-authority
hepta-readonly-store vs hepta-readonly-control
hepta-compatibility vs hepta-legacy-compatibility
```

Allowed outcomes:

- one public facade over private implementation crates;
- explicit legacy-only verifier;
- merge and retire;
- distinct capability split documented by ADR.

“Both remain available and callers choose” is not acceptable.

## 7. Data migration

Data/state changes use:

1. read-only preflight and normalized projection;
2. schema/version compatibility proof;
3. backup and exact restore canary;
4. shadow replay on production-shaped copies;
5. writer quiescence and preimage binding;
6. atomic migration/cutover transaction;
7. post-cutover read-back and event audit;
8. rollback before the irreversible threshold or forward recovery after it.

## 8. Cutover

Authority transfer binds exact source, binaries, configurations, host/service,
state preimage, active leases, external evidence, and first new writer/effect
identity. Node authority is disabled mechanically, not merely unused.

## 9. Retirement

Node retirement requires:

- no production entrypoint/import reachability;
- no active service, credential, queue, cron, or writer lease;
- compatibility reader/verifier retained where historical artifacts require it;
- migration and rollback window decision;
- documentation and module registry updated;
- no fallback silently reactivates Node authority.
