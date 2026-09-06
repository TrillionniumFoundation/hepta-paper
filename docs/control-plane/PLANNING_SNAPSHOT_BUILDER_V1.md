# Planning Snapshot Builder V1

## Status and authority

This document specifies the repository-owned, pure Node source candidate for
`module.snapshot-builder`. The implementation is
`paper-application/orchestration/planning-snapshot-builder.mjs`.

It constructs and revalidates immutable planning snapshots. It performs no I/O,
does not open a database transaction, does not authenticate module
qualification, does not select or execute candidates, and grants no writer,
provider, release, submission, or production authority. Static module and work
item states remain unchanged until exact-source qualification and independent
acceptance complete.

## Input boundary

The public build and currentness functions require:

```text
inputBoundary = trusted_same_realm_plain_data
```

The marker is a contract classification, not a security mechanism. The object
API uses descriptors and rejects accessors, unsupported prototypes, symbols,
sparse arrays, cycles, nonfinite numbers, unsafe integer values, and unknown
fields. JavaScript Proxy reflection traps can still execute while the input is
being classified. Untrusted data must first cross a bounded, duplicate-key-safe
serialized or isolated-process boundary.

All accepted strings are Unicode scalar-value strings. Isolated UTF-16 high or
low surrogate code units are rejected in keys and values. Canonical maps order
keys by unsigned UTF-8 bytes; this is a total order on the accepted string
domain. Records are captured in null-prototype objects so `__proto__`,
`constructor`, and `prototype` remain ordinary own, enumerable, hash-visible
keys.

## Qualification metadata contract

The builder consumes the exact `PlanningModuleQualificationMetadataV1` records
from Candidate Router V1. Their complete set hash is embedded in the snapshot
request and checked again during currentness verification.

The records are deliberately classified as:

```text
qualificationTrustClass: caller_supplied_unverified
qualificationCurrentnessMode: external_live_revalidation_required
```

The builder verifies shape, hash, module/version/capability identity, generation,
observation/expiry interval, and exact set membership. It does not authenticate
the currentness receipt or revocation-set hash. Trusted composition must perform
that external gate before building and before consuming a snapshot.

Every supplied module metadata record must be used by at least one required
component. Extra trusted-looking records are rejected instead of broadening the
snapshot's apparent qualification surface.

## Snapshot request

`PlanningStateSnapshotRequestV1` binds:

- snapshot request identity;
- one upstream read-transaction hash and consistency epoch;
- module-registry, policy-set, resource-price, and objective identities;
- exact module-qualification metadata-set hash;
- issued-at and deadline timestamps;
- per-component and aggregate byte limits;
- the complete required component set.

Each requirement binds component ID/kind, source module/version, required
capability, minimum revision, maximum observation age, and maximum payload
bytes. Requirement order is not semantic; component ID is unique and canonical.

The read-transaction hash and consistency epoch are assertions supplied by the
read adapter. Equal strings do not manufacture database snapshot isolation. A
production read adapter must prove that all returned components came from the
same authoritative read transaction and that semantic changes advance the
source generation.

## Component contract

`PlanningSnapshotComponentV1` binds:

- component ID/kind;
- source module/version and required capability;
- exact qualification-metadata record hash;
- read transaction and consistency epoch;
- revision and source generation;
- observation and validity times;
- bounded immutable payload;
- a recomputed component hash.

The builder requires exact one-to-one coverage of request requirements. Missing,
extra, duplicate, wrong-kind, wrong-source, wrong-capability, mixed-transaction,
mixed-epoch, under-revision, future, stale, expired, or forged components fail
the complete build. It never returns a partial snapshot.

## Bounds

Compiled hard ceilings are:

| Surface | Hard ceiling |
|---|---:|
| Components | 2,048 |
| Module metadata records | 1,024 |
| Component bytes | 2 MiB |
| Aggregate component bytes | 32 MiB |
| Aggregate payload nodes | 65,536 |
| Payload depth | 32 |
| Collection items per value | 16,384 |
| String bytes | 64 KiB |

The request may narrow byte ceilings but cannot exceed the hard values. One
aggregate node budget spans every component in the build transaction; it is not
reset per payload. Payload bytes, full component bytes, aggregate component
bytes, and final snapshot bytes are checked separately.

## Output and determinism

`PlanningStateSnapshotV1` retains the normalized request, exact normalized
module metadata, and all normalized components. It derives:

```text
snapshotRequestHash
moduleQualificationMetadataSetHash
componentSetHash
stateSnapshotHash
expiresAt
```

`expiresAt` is the earliest request deadline, component validity boundary, or
module-qualification metadata expiry. A valid outer hash cannot renew an inner
expiry.

For the same accepted input records and explicit observation time, output bytes
and hashes are deterministic across input order and process locale. The output
is deeply immutable and carries only false authority fields.

## Currentness verification

`verifyPlanningStateSnapshotCurrentV1` first reconstructs the complete snapshot
and compares every canonical byte, rather than trusting its outer hash. It then
requires a current context containing:

- current registry, policy, resource-price, and objective identities;
- the exact current module-qualification metadata set;
- exact component ID/module/version/revision/source-generation values.

Any drift fails. The observation time must be between snapshot construction and
snapshot expiry, and module qualification intervals must still cover it.

The receipt status is:

```text
planning_state_snapshot_current_against_supplied_context
```

That phrase is intentional. It proves consistency with the supplied context,
not authenticity of the store, absence of hidden writes, database isolation,
or qualification/revocation authority. The receipt retains
`externalCurrentnessGateRequired: true` and only false authority flags.

## Candidate-router composition

The resulting `stateSnapshotHash` is accepted directly by current Candidate
Router V1. A candidate built for a different snapshot, transaction, policy,
resource-price identity, objective, component generation, or module
qualification set is not interchangeable.

The builder does not call module producers, construct candidate frontiers,
solve the bounded optimization problem, reserve resources, or issue execution
commands. Those remain downstream contracts.

## Failure, retry, and rollback

All validation failures are typed, non-retryable source errors. A caller may
retry only after acquiring a new authoritative read transaction or correcting
the exact rejected input. Reusing an old snapshot under a changed generation or
policy is forbidden.

Before integration, rollback is closure of the draft PR. After integration,
rollback is a reviewed revert followed by fresh exact-source, base/merge, and
consumer qualification. Rollback cannot restore expired qualification metadata
or waive an external currentness gate.

## Machine wire schemas and executable conformance

The checked-in closed wire schemas are:

- `docs/modules/schemas/planning-state-snapshot-request-v1.schema.json`;
- `docs/modules/schemas/planning-snapshot-component-v1.schema.json`;
- `docs/modules/schemas/planning-state-snapshot-v1.schema.json`;
- `docs/modules/schemas/planning-state-snapshot-currentness-receipt-v1.schema.json`.

They fix every named field, identity literal, scalar pattern/range, collection
ceiling, timestamp shape and false-authority field at the JSON boundary. They
do not attempt to encode cross-field time ordering, component/hash relations,
UTF-8 byte ceilings, Unicode-scalar validity, aggregate capture budgets, exact
set coverage, freshness, or currentness. Those remain executable runtime
obligations and are rechecked after parsing. Schema acceptance by itself is
never a qualification or integrity receipt.

`paper-core/tests/planning-snapshot-schema-conformance.test.mjs` validates every
runtime-produced public record against its schema, round-trips schema-valid JSON
through full runtime reconstruction, and requires both layers to reject shared
closed-shape, identity, range and authority violations. It also proves the
intentional boundary with a schema-valid component whose payload/hash relation
is forged: the runtime must still reject it. The test invokes the repository's
fail-closed strict schema verifier rather than a permissive third-party default.

## Required acceptance

Source acceptance requires the checked-in wire schemas, executable conformance, focused adversarial tests, schema/contract review,
current exact-head and prospective-merge CI, module-documentation integrity, and
an independent latest-head decision. Production use additionally requires a
qualified readonly-control adapter, authoritative generation semantics,
revocation/currentness readback, target-host evidence, and integration through
the canonical planning pipeline.
