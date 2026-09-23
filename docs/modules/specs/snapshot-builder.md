# module.snapshot-builder

Status: normative module specification  
Manifest: [`../manifests/snapshot-builder.v1.json`](../manifests/snapshot-builder.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.snapshot-builder
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-STATE
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Construct the immutable, hash-bound planning snapshot from campaign, registry, qualification, policy, and resource read models.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- campaign/read-model revisions
- module registry snapshot
- qualification currentness
- resource and policy generations

Outputs:

- canonical immutable snapshot
- snapshot hash
- typed staleness/conflict disposition

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.module-registry`
- `module.readonly-control`

Current implementation and contract roots:

- `paper-application/orchestration/planning-snapshot-builder.mjs`
- `paper-application/orchestration/planning-snapshot-contract.mjs`
- `paper-application/orchestration/planning-snapshot-canonical.mjs`
- `docs/control-plane/PLANNING_SNAPSHOT_BUILDER_V1.md`
- `docs/modules/schemas/planning-state-snapshot-request-v1.schema.json`
- `docs/modules/schemas/planning-snapshot-component-v1.schema.json`
- `docs/modules/schemas/planning-state-snapshot-v1.schema.json`
- `docs/modules/schemas/planning-state-snapshot-currentness-receipt-v1.schema.json`
- `docs/control-plane/COMPOSITION_ROOT.md`
- `rust/crates/hepta-control-plane/src/source_closure.rs`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject inconsistent revisions, missing required projections, mixed generations, stale qualification, non-canonical records, or read-model disagreement. Snapshot construction never repairs authoritative state.

## Security and privacy

Read through validated projections only; exclude secret bytes and writable handles. Snapshot hashes bind policy and authority generations.

## Compatibility and migration

Snapshot schema changes require forward/backward readers or a stop-the-world migration; an old snapshot is never reinterpreted under new policy.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-CTL-SNAPSHOT`. Related work identifiers: `CTL-002`. Implementation/contract roots: `paper-application/orchestration/planning-snapshot-builder.mjs`, `paper-application/orchestration/planning-snapshot-contract.mjs`, `paper-application/orchestration/planning-snapshot-canonical.mjs`, `docs/control-plane/PLANNING_SNAPSHOT_BUILDER_V1.md`, `docs/modules/schemas/planning-state-snapshot-request-v1.schema.json`, `docs/modules/schemas/planning-snapshot-component-v1.schema.json`, `docs/modules/schemas/planning-state-snapshot-v1.schema.json`, `docs/modules/schemas/planning-state-snapshot-currentness-receipt-v1.schema.json`, `docs/control-plane/COMPOSITION_ROOT.md`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The current source candidate builds a complete immutable snapshot from one exact
request, the Candidate Router V1 `PlanningModuleQualificationMetadataV1` set,
and exact bounded read-only components. It rejects partial coverage,
mixed transaction/epoch, stale generation, qualification-set drift, forged
hashes, Unicode non-scalar strings, structural/byte overflow, and authority
escalation. Snapshot expiry includes each component's observation time plus its
request-bound maximum age, so later currentness cannot outlive the age check
performed during construction. It offers a separate currentness verifier that
reconstructs the complete snapshot and compares current context and component
generations.

Qualification metadata and read-transaction assertions remain
caller-supplied/unverified. The output explicitly requires external live
currentness and does not authenticate a store or create snapshot isolation.
The same-realm object API is a trusted boundary; untrusted Proxy or serialized
inputs require a separate bounded adapter. Source controls in
`paper-core/tests/planning-snapshot-builder-*.test.mjs`, with shared fixtures in
`paper-core/tests/planning-snapshot-fixtures.mjs`, include direct composition
with the current candidate router. Static module state is `source_implemented`,
as is the CTL-002 implementation projection. Acceptance of the readonly
composition, current exact-subject conformance, hosted qualification and
independent review remains separate from that source state.

The four public JSON record kinds have closed Draft 2020-12 wire schemas in
`docs/modules/schemas/planning-*-v1.schema.json`. Executable conformance in
`paper-core/tests/planning-snapshot-schema-conformance.test.mjs` verifies runtime
outputs against those schemas and reconstructs schema-valid JSON through the
runtime. Schema shape cannot prove canonical byte ceilings, Unicode-scalar
validity, cross-field time/hash relations, aggregate budgets, freshness or
authenticity; runtime reconstruction and the external currentness gate remain
mandatory. A schema-valid forged payload/hash pair is an explicit rejection
case. The registry and documentation manifest enumerate the implementation,
contract and schema paths. Their registration does not grant qualification,
change activation, transfer ownership or widen authority.

### Standalone Rust orchestration compatibility contract

[`build_planning_snapshot_v1`](../../../rust/crates/hepta-orchestration-kernel/src/snapshot.rs) remains available only from the standalone
`hepta-orchestration-kernel` crate. It is not re-exported by the product control plane and is not a selected product owner. This function checks caller-supplied revision, barrier, component time and digest consistency. It neither opens a read transaction nor verifies payload bytes or producer identity. Its 256-component and 64 GiB declared-payload limits and distinct snapshot hash are separate from the registered Node snapshot schema. A real read owner and explicit compatibility adapter remain required.

See the [Rust orchestration development handoff](../../../rust/crates/hepta-orchestration-kernel/HANDOFF.md)
for exact fields/units, bounds, hash domains, failure/recovery behavior and
implementation selection. This standalone compatibility API is not wired into
an existing product command. Focused source validation from `rust` is
`cargo test -p hepta-orchestration-kernel --locked`; those fixtures do not establish
Node parity, production activation or independent qualification.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-002` — `source_implemented`
