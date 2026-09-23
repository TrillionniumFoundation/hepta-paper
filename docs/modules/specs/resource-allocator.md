# module.resource-allocator

Status: normative module specification  
Manifest: [`../manifests/resource-allocator.v1.json`](../manifests/resource-allocator.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.resource-allocator
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-SCHEDULER
secondaryOwnerTeam: TEAM-SRE
independentReviewerTeam: TEAM-STATE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Admit, reserve, fence, account, reconcile, and release multi-resource capacity with hierarchical fairness and bounded starvation policy.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- plan certificate
- capacity and accounting generation
- hierarchical entitlements
- finite resource vectors

Outputs:

- prepared/finalized reservations
- single-use dispatch capability
- settlement and accounting reports

## State and authority

Maximum authority class: `read_only`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- No hard module dependency.

Current implementation and contract roots:

- `paper-application/automation/resource-governor.mjs`
- `docs/control-plane/RESOURCE_MODEL.md`
- `rust/crates/hepta-control-plane`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject negative/overflowing units, stale generations, hierarchy violations, double reservations, unreserved use, owner loss, overuse, or ambiguous release. Unknown consumption remains charged until reconciled.

## Security and privacy

Reservation handles are audience-bound and single-use. Capacity never implies execution, credential, writer, release, or submission permission.

## Compatibility and migration

Resource dimensions and units are schema-versioned. State upgrades preserve prepared/finalized reservations or explicitly reconcile them before rollback.

## SLO, capacity, and observability

Track p50/p95/p99 latency, maximum queue age/depth, throughput, timeout/fallback rate, recovery time, and all zero-tolerance safety counters. Canonical workload and threshold versions are bound in the deployment evidence; source documents do not invent production numbers.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

The current Node helper's exact interface, units, policy bounds, accounting
invariant and non-claims are specified in
[`RESOURCE_MODEL.md`](../../control-plane/RESOURCE_MODEL.md#13-current-node-governor-executable-bounded-admission).
`createResourceGovernor` now provides idempotent release handles, strict integer
vectors, bounded waiting and opt-in bounded conflicting overtaking. Legacy
first-fit remains the default because nested acquisitions need a separate
dependency-aware policy; finite barriers are only for independent work. Pending cancellation
uses a propagation-resistant disposable subscription, removes its listener and
reconsiders queued work even when an earlier native listener suppresses ordinary
abort propagation; granted work remains charged
until explicitly released. Tests in
`paper-core/tests/resource-governor-invariants.test.mjs` bind these behaviors to
executable positive, adversarial, capacity and deterministic-sequence checks.
The additive `acquireEnvelope` API reserves retained parent resources plus an
independent child pool before parent execution. Child consumers receive only
that pool's resource port; they cannot close the owner or borrow its retained
quota. Owner cancellation seals admission but does not refund resources; explicit
owner close plus settlement of every child is required. The exact lifecycle,
limits, conservation argument and supported dependency assumptions are recorded
in [`RESOURCE_MODEL.md`](../../control-plane/RESOURCE_MODEL.md#14-opt-in-parent-and-child-resource-envelope).
`paper-core/tests/resource-envelope.test.mjs` executes boundary and race cases,
separate-ledger mixed workloads and the actual nested-agent runner with local
campaign ports. The policy-bound engine integration now routes explicitly declared node kinds
through both global and local pools; see
[`RESOURCE_MODEL.md`](../../control-plane/RESOURCE_MODEL.md#15-explicit-campaign-integration-and-joined-nested-execution).
The persisted campaign-definition hash must match the runtime policy before
claims. Nested operations are joined before parent result preparation; premature
return, recursive same-scope calls and undeclared kinds fail closed.
`paper-core/tests/campaign-resource-envelope.test.mjs` exercises the real engine
and SQLite state, including no-early-commit and no-early-refund controls. Default
routing, multiprocess/host recovery, physical quota enforcement and independent
host acceptance remain outside this source increment.

The legacy defaults are not qualified production capacity. Hierarchical DRF,
durable fenced leases, host measurements and whole-work-item acceptance remain
open; the local governor must not be presented as their implementation.


Agent and empirical-cell calls share the engine settlement boundary; neither
can outlive a prepared parent result through those managed ports. Heartbeat
setup faults and resource-lease loss are covered by the engine lifecycle tests.
This is logical cleanup and result-fencing, not distributed lease recovery or
physical CPU/GPU enforcement.

Capability bindings: `CAP-RES-ALLOCATE`. Related work identifiers: `RES-001`, `RES-002`, `RES-003`, `RES-004`, `RES-005`, `RES-006`, `RES-007`. Implementation/contract roots: `paper-application/automation/resource-governor.mjs`, `docs/control-plane/RESOURCE_MODEL.md`, `rust/crates/hepta-control-plane`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Standalone Rust orchestration compatibility contract

[`ResourceLedgerV1`](../../../rust/crates/hepta-orchestration-kernel/src/resource.rs) remains available only from the standalone
`hepta-orchestration-kernel` crate. It is not re-exported by the product control plane and is not a selected resource owner. This in-memory Rust ledger checks hierarchical integer budgets, individual scope generations and prepare/commit/finalize/cancel transitions. Commit time must be within the inclusive creation/expiry interval; expired committed reservations remain charged as ambiguous. It has no durable load/replay or physical CPU/GPU enforcement and is separate from the control-plane durable lease ledger.

See the [Rust orchestration development handoff](../../../rust/crates/hepta-orchestration-kernel/HANDOFF.md)
for exact fields/units, bounds, hash domains, failure/recovery behavior and
implementation selection. This standalone compatibility API is not wired into
an existing product command. Focused source validation from `rust` is
`cargo test -p hepta-orchestration-kernel --locked`; those fixtures do not establish
Node parity, production activation or independent qualification.

## Rollout and rollback

Current channel is `authoritative`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `RES-001` — `source_implemented`
- `RES-002` — `source_implemented`
- `RES-003` — `source_implemented`
- `RES-004` — `source_implemented`
- `RES-005` — `source_implemented`
- `RES-006` — `source_implemented`
- `RES-007` — `source_implemented`


## Durable journal failure handling

The standalone Rust lease journal now refuses further reads and mutations after
an append may have changed disk without a confirmed result. Recovery validates
all complete events before truncating an incomplete tail. Its checked
`active_charges()` API cannot turn uncertain persistence into an empty charge
list. See the [persistence handoff](../../../rust/crates/hepta-control-plane/src/durable_resource/HANDOFF.md)
for exact API changes, tests and limits. This closes a local persistence error
path; it does not supply trusted reconciliation receipts or connect the journal
to mandatory hierarchical dispatch.
