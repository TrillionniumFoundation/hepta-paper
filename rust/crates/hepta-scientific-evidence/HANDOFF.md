# Scientific capsule consistency and independent verification

[`lib.rs`](src/lib.rs) computes structural consistency between supplied producer
and verifier records. It does not run a proof assistant, experiment, numerical
solver or model, read artifact bytes, verify a signature or establish that a
verifier is independently controlled. These responsibilities belong to the real
producer/verifier adapters described in the
[scientific runtime handoff](../../../docs/modules/SCIENTIFIC_RUNTIME_HANDOFF.md).

## Records and validation order

`ProducerEvidenceV1` binds version, campaign/attempt IDs, producer implementation
hash, input manifest hash, artifact hashes and a declared evidence level.
`IndependentVerificationV1` binds verifier implementation hash, producer-record
hash, recomputed artifact-set hash, declared level, acceptance/reason and optional
external-attestation hash. Both are ordinary deserializable records.

IDs/reasons contain 1–128 ASCII bytes from letters, digits, `-_.:`. Hashes use
lower-case `sha256:` plus 64 hex characters. Artifact sets must be nonempty,
duplicate-free and contain canonical digests. This library does not impose a
maximum artifact count or encoded input size; the actual intake must supply
those limits before allocating records or calling it.

`verify_evidence_capsule_v1` performs these checks in order:

1. Validate both record shapes and artifact set.
2. Hash the supplied producer record and compare the verifier's bound hash.
3. Reject an equal producer/verifier implementation-hash string.
4. Hash the supplied artifact-hash set and compare the verifier's recomputation.
5. Reject `accepted=false`, retaining the bounded reason code.
6. Reject a higher verifier level unless that level is `external_trust`, and
   require a shaped external-attestation hash for `external_trust`.
7. Return the lower of producer/verifier levels, the two record hashes and the
   sorted artifact hashes.

Levels are ordered `contract_fixture < real_runtime_fixture < live_model <
external_trust`. An external-trust verifier cannot elevate a weaker producer:
the returned level still uses the minimum. The presence of an attestation hash
is only a structural requirement; its bytes, signature, source, subject and
currentness are not loaded or checked here.

## Hash contracts and provenance boundary

`HeptaProducerEvidenceV1` and `HeptaIndependentVerificationV1` hash their typed
Serde JSON bodies with a big-endian u64 length before each domain/body byte
string. The producer body preserves the supplied artifact vector order; its
record hash can change when that vector is reordered. `HeptaArtifactSetV1`
instead frames the domain and each lexicographically sorted distinct digest.
It identifies a set of digest strings, not actual artifact contents.

| Fact | What the function establishes | What the independent owner must establish |
|---|---|---|
| Producer binding | Exact hash of the provided producer record. | Authentic producer and exact actual input/output bytes. |
| Implementation independence | Producer and verifier digest strings differ. | Trusted build identities, separate principals and absence of shared production authority. |
| Artifact recomputation | Hash of the listed digest strings matches the supplied verification record. | Independently read and verify each actual artifact and its scientific result. |
| Assurance | Consistent ordering/minimum of declared levels. | Evidence that each declared level was actually earned. |
| External attestation | Optional digest has correct syntax and is present when required. | Independently verified attestation, freshness/revocation and exact subject. |

Despite its name, `VerifiedEvidenceCapsuleV1` has public fields and can be
constructed directly by another Rust caller. It is not an opaque capability or
authorization boundary. A decoded or manually built capsule cannot grant a
writer, release, submission or production-qualification permission. A future
owning consumer needs actual authenticated verifier results and independent
authority evidence, not just this consistency result.

## State, failures and recovery

The function is pure and opens no file, database, process or network connection.
It has no nonce/replay journal, host clock, timeout, cancellation or crash state.
The same valid input reproduces the same output; a result does not attest that
an external operation ran exactly once. Hash/binding/independence/recomputation
errors and a rejected scientific result remain failures; they cannot be repaired
by raising the supplied evidence level or replacing a record with an accepted
boolean. External effects and their ambiguous recovery remain with the adapter
which actually performs them.

## Development and acceptance

From `rust`, run `cargo test -p hepta-scientific-evidence --locked`. Existing tests
cover matching records and rejection of an equal implementation hash or an
unattested evidence-level promotion. They use constructed data and do not prove
signature verification, real scientific execution or administrative independence.
The scientific runtime and business-kernel suites validate different source
execution slices; each still needs its own full-operation and independent
acceptance evidence before replacing a Node role.
