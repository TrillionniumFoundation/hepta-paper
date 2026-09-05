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

The exact executable/source digest, configuration, deployment generation, read-model
producer identity, current qualification evidence, host identity and rollback version
belong to an exact deployment subject. This static document cannot grant source
qualification, target-host acceptance, writer authority or production activation.

## Mission and non-goals

Construct one immutable, hash-bound planning snapshot from validated campaign,
module-registry, qualification, hard-policy and resource read projections that all
belong to the same explicit read-consistency session and barrier generation.

The builder does not open a database, query GitHub, mutate campaign state, repair
missing state, obtain credentials, execute a candidate, reserve resources, sign a
plan, issue an external effect or self-promote evidence. A shared session ID or a
self-hash is consistency data, not authentication of the projection producer.

## Inputs and outputs

The executable entrypoint is:

```text
buildControlPlaneSnapshot({
  readSession,
  campaign,
  moduleRegistry,
  qualification,
  policy,
  resources,
  nowEpochMs
})
```

All inputs are closed plain-data records. Accessors, symbols, inherited/class
instances, sparse arrays, functions, BigInts, non-finite numbers, unknown fields
and malformed canonical timestamps fail before snapshot construction.

`ReadConsistencySessionV1` contains:

```text
readSessionId
barrierGeneration
startedAt
completedAt
expiresAt
sessionHash
```

Every campaign, qualification, policy and resource projection contains the exact
`readSessionId`, `readBarrierGeneration`, bounded observation/expiry timestamps and
its own `projectionHash`. Matching text IDs alone are insufficient: every projection
must carry the same positive barrier generation as the session.

`CampaignReadProjectionV1` binds campaign/revision, campaign state hash, database
identity hash and remaining planning budget. `QualificationCurrentnessProjectionV1`
binds the exact qualified module-registry snapshot, independently selected registry
policy, qualification generation, qualification-set hash and explicit `current`
status. `PlanningPolicyProjectionV1` binds policy generation, objective, hard
constraint-set hash, required capabilities and optional deterministic seed.
`ResourceStateProjectionV1` binds resource generation, resource-state and price
snapshot hashes, and a finite resource ceiling.

The module registry is an exact `QualifiedModuleRegistrySnapshotV1`. Every module
binding contains an exact module/version, V1-compatible protocol range, non-empty
capability set, accepted qualification class and qualification-evidence hash.
Unqualified entries do not enter the planning snapshot.

The output is an immutable `ControlPlaneSnapshotV1` containing all exact identities,
all four generations, the read barrier, policy/objective/constraint bindings,
resource and budget ceilings, required capabilities, each projection hash, earliest
validity deadline and `snapshotHash`. Every authority field is fixed to false.

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The
module owns no durable state and exposes no database, writer, provider, release or
submission handle. It receives values only and returns a frozen value.

Declared side-effect classes: `none`.

A current snapshot is an input to later policy and planning steps. It is not an
execution capability, resource reservation, writer lease, provider credential,
release approval or proof that a future consumer still observes current state.
Consumers must revalidate expiry and any required generation immediately before
an irreversible boundary.

## Dependencies

Hard registered module dependencies:

- `module.module-registry`
- `module.readonly-control`

Current implementation and contract roots:

- `docs/control-plane/COMPOSITION_ROOT.md`
- `paper-application/orchestration/control-plane-snapshot-builder.mjs`

The read-only control dependency must produce bounded projections without exposing
writable handles. The module-registry dependency must produce the exact qualified
registry snapshot and its independent policy/qualification evidence. Importing a
private source file is not a runtime dependency contract.

## Concurrency and resources

The implementation is synchronous and performs no I/O, timer, process, thread,
network, filesystem, database or provider operation. V1 bounds include:

| Dimension | Maximum |
|---|---:|
| qualified modules | 256 |
| required capabilities | 256 |
| normal identity text | 2,048 UTF-8 bytes |
| projection depth used by hash construction | 12 |
| projection values visited | 8,192 |
| projection aggregate string bytes | 64 KiB |
| one projection collection | 4,096 entries |
| integral resource/generation values | `Number.MAX_SAFE_INTEGER` |

CPU and GPU resource units must be finite non-negative numbers within their
explicit ceilings; byte, MiB, token, cost, external-action and generation values
are non-negative safe integers. The builder does not allocate or enforce those
resources.

## Determinism and optimization contract

Declared class: `deterministic`. For the same canonical projections, registry and
explicit integer clock, the output is byte-stable under the repository hash domain.
Module order, module capability order and required-capability order do not change
the snapshot identity.

The explicit clock is used only to reject future/incomplete/stale observations. It
is not copied into the semantic snapshot, so two validations during the same valid
window produce the same snapshot hash.

Every source identity, generation, resource ceiling, objective, constraint,
qualification evidence change or projection-hash change alters the snapshot hash.
No optimizer score or candidate preference is computed here.

## Failure, recovery, and idempotency

The builder fails closed on:

- inconsistent session IDs or read-barrier generations;
- observations outside the session interval;
- incomplete, future or expired sessions;
- stale projections;
- invalid or mismatched projection hashes;
- registry snapshot or registry-policy mismatch;
- qualification status other than `current`;
- qualification-set disagreement with exact module evidence;
- unqualified/duplicate/unsupported module bindings;
- required capabilities absent from the qualified registry;
- invalid resources, revisions, generations or canonical timestamps;
- unknown fields, mutable handles represented as functions, accessors or unbounded structures.

No partial snapshot is returned. Exact replay is idempotent. Any input identity,
producer generation, source hash or validity change creates a new subject. The
builder never writes a journal or repairs authoritative state; a rejected read must
be reacquired through the read-only control boundary.

## Security and privacy

Inputs are captured through own enumerable data descriptors before validation and
hashing. Nested projection-hash construction copies only bounded JSON-like values
and rejects accessors/functions. Qualified registry modules and resources are
copied into frozen records.

Projection payloads contain hashes, bounded identities, generations and finite
planning limits. Credential bytes, private keys, unrestricted prompts/provider
responses, confidential manuscript bodies, environment dumps, developer home paths,
file descriptors, sockets, transactions and writer objects are prohibited.

The exported projection-hash helper recognizes only the five V1 projection domains;
it cannot be used to mint an arbitrary authority receipt under a caller-selected
hash domain.

## Compatibility and migration

Only V1 projection kinds and canonical UTC millisecond timestamps are accepted.
Every projection now binds `readBarrierGeneration`; readers must not interpret a
legacy ID-only projection as belonging to a current barrier. This is an explicit
fail-closed source contract change.

Changes to projection fields, hash domains, generation semantics, resource units,
qualification classes or validity rules require a new version and fresh producer,
builder and consumer conformance. Old snapshot bytes remain historical evidence
and are never reinterpreted under new policy.

## SLO, capacity, and observability

Source evidence records construction latency, accepted/rejected snapshot counts,
rejection code, projection bytes, module/capability counts, generation tuple,
validity horizon and exact input/output hashes. Production p50/p95/p99 and memory
thresholds require named workloads and target-host evidence; this document does not
invent them.

Zero-tolerance counters include accepted mixed barriers, accepted stale
qualification, accepted hash mismatch, required capability without a qualified
module, writable-handle exposure and authority escalation.

## Operational runbook

Composition first establishes one read-consistency session through the read-only
control plane. Every projection producer receives the session ID and barrier and
returns a bounded self-hashed projection. The registry and qualification producers
must bind the same exact registry snapshot and policy.

Call the builder only after all projections are captured. On failure, record the
bounded symbolic code and non-secret subject hashes, discard the complete set and
re-read it; do not mix one replacement projection into an older session. Before
candidate collection and again before irreversible execution or commit, check the
snapshot validity/generation policy required by that consumer.

No operator may replace a missing projection, rewrite its hash, downgrade a module
qualification requirement or bypass a barrier mismatch. Any builder, producer,
schema, registry, policy or resource contract change invalidates cached snapshots.

## Verification and evidence

`paper-core/tests/control-plane-snapshot-builder.test.mjs` covers deterministic
module/capability order; exact generation and source binding; mixed session and
barrier rejection; observation windows and expiry; every projection hash;
registry/policy/qualification cross-binding; qualification-set derivation;
required-capability coverage; strict module/resource capture; writable-handle and
accessor rejection; immutable output; non-authority; canonical timestamps and 100
input permutations.

The barrier-splicing test is critical: an old projection carrying the same textual
session ID but a different barrier generation must be rejected. This closes the
ID-only consistency ambiguity in the previous draft. The tests use in-memory data
and do not authenticate real projection producers or establish a transactionally
atomic multi-store read.

Capability binding: `CAP-CTL-SNAPSHOT`. Related work item: `CTL-002`. This increment
implements the bounded in-process construction kernel and structural module truth.
It does not close all of CTL-002: production read-session orchestration, concrete
read-only adapters, cross-language conformance, startup integration, live
revalidation and independent acceptance remain open.

The documentation validator continues to prove registry/spec/manifest parity,
required sections, source-path existence and authority language. Source conformance
never substitutes for current exact-head/merge CI, target-host evidence or
independent review.

## Rollout and rollback

Current channel is `disabled`. Rollout proceeds through registered,
contract-ready, source-implemented, conformance-qualified, shadow, canary and only
then authoritative where applicable. The deployment subject binds exact builder,
projection producers, registry and qualification provider, hash domains,
configuration, workload evidence and rollback version.

Rollback requires a reviewed source revert and invalidation of snapshots produced
under the reverted contract. It cannot accept legacy ID-only projections, widen
qualification classes, omit generation checks or grant writer/provider authority.

## Open blockers

- `CTL-002` — `design_ready`: concrete read-session producer orchestration,
  read-only adapter integration, cross-language snapshot conformance, startup and
  live revalidation, target workload evidence and independent acceptance remain open.
