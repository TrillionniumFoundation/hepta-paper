# Executable control-plane snapshot source candidate

## Scope

`paper-application/orchestration/control-plane-snapshot-builder.mjs` assembles a
pure, immutable `ControlPlaneSnapshotV1` from already obtained read-only
projections. It does not query an authoritative database, acquire credentials,
mutate campaign state, execute a plan, or grant production authority.

The caller supplies:

- a `SnapshotBuildRequestV1` with exact module-registry, policy, resource-price,
  objective, qualified-source-set, time and byte-limit identities;
- a complete qualified projection-source set;
- one exact `ReadOnlyProjectionV1` for every qualified source.

A separate consumption step calls `revalidateControlPlaneSnapshotV1` with the
current context hashes and current source generations before planning.

## Source and projection identity

Each qualified source binds:

```text
projection ID and version
module ID and version
authority class
qualification status and identity
maximum projection age
```

Only `pure` and `read_only` source authorities are accepted. Source
qualification must be one of the explicitly qualified states. The source set is
canonically ordered and hashed. The build request must bind that exact hash.
Substituting a source version, qualification receipt, authority, or age policy
therefore changes the request identity.

Each projection binds the same projection/module identities plus a positive
source generation, observation time, validity deadline, canonical payload and
payload hash. Unknown fields, accessors, sparse arrays, cycles, non-finite
numbers, invalid timestamps, duplicate identities and over-limit values fail
closed.

## Time and generation semantics

For projection `p`, build time `B`, observation time `O_p`, validity end `V_p`
and declared maximum age `A_p`, admission requires:

```text
O_p <= B <= V_p
B - O_p <= A_p
```

Snapshot expiry is not caller-selected. It is exactly:

```text
min(build-request deadline, every projection validUntil)
```

The snapshot embeds each source's maximum-age and qualification identity, the
complete build request hash, the projection-set hash, and the exact byte limits.
A consumer can therefore recompute those constraints rather than trusting only
an outer self-hash.

Before planning, currentness revalidation requires the exact current:

```text
moduleRegistryHash
policySetHash
resourcePriceSnapshotHash
objectiveVersion
qualifiedProjectionSetHash
source generation for every projection
```

Any mismatch rejects the snapshot. A valid currentness receipt remains
non-authorizing and binds the snapshot, reconstructed build request, current
context and generation set.

## Bounds

The source candidate enforces:

| Dimension | Limit |
|---|---:|
| projections | 2,048 |
| one canonical projection payload | 2 MiB |
| all canonical projection payloads | 32 MiB |
| nested value nodes | 65,536 |
| nested value depth | 32 |
| one string | 65,536 code units |

Bounds are checked during construction and again while consuming a serialized
snapshot. A caller cannot increase limits by editing the snapshot and
recomputing only its outer hash.

## Determinism and authority

Projection/source declaration order does not affect the canonical snapshot.
All semantic times are explicit inputs. The snapshot and currentness receipt
contain only false authority flags. They grant no central write, execution,
provider, release, submission, or external-authority capability.

## Integration with candidate routing

A `PlanningRequestV1` may bind the resulting `stateSnapshotHash`. Candidate
routing then requires every `ActionCandidateV1` to carry that exact hash.
Generation or registry/policy/objective/price drift invalidates currentness even
when a previously built candidate frontier remains byte-identical.

This creates a source-level sequence:

```text
qualified read-only projections
  -> immutable state snapshot
  -> currentness receipt
  -> snapshot-bound planning request
  -> candidate frontier
```

It does not yet provide the authoritative read adapters, transactional
cross-source observation, producer collection, scheduler selection, execution,
or commit sequence.

## Verification

`paper-core/tests/control-plane-snapshot-builder.test.mjs` covers:

- declaration-order determinism;
- exact source/projection coverage and hashes;
- source authority and qualification restrictions;
- future, expired and over-age projections;
- byte, count, structural and mutation bounds;
- exact expiry reconstruction;
- registry, policy, price, objective, source-set and generation drift;
- hostile records whose inner and outer hashes are recomputed after weakening
  expiry or age constraints;
- immutable currentness receipts;
- a direct snapshot-to-candidate-router binding control.

These are source tests with synthetic projections. They do not authenticate an
actual production source, prove that separate source reads were atomic, or close
`CTL-002`, G2/G3, target-host qualification, independent review, or any
activation gate. Machine work-item and module states remain unchanged until the
full acceptance chain succeeds.
