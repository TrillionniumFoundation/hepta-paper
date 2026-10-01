# Native release-attestation inspection

This handoff documents the Rust local inspection corresponding to
`node paper-core/bin/release-evidence.mjs --execute`. The native command is a
source inspection and bounded differential replay. It remains blocked for both unimplemented native
implementation work and independently qualified release authority; supplying
external credentials alone cannot turn this report into release evidence.

## Input and command

`hepta-paper-rust release-attest REQUEST` reads a bounded JSON request with a
`ReleaseAttestationRequest` envelope. It contains the existing schema-25
`LegacyDeletionDrillAttestationRequest`, a release-state consistency request,
and release trust-layer counts. The command validates the release subject,
evaluates the native release-state and trust gate implementations, and reuses
the native archive identity and legacy freeze inspection.

Request files use the frontend's shared `read_bounded` reader: no-follow,
nonblocking regular-file reads with a finite byte cap and held/named metadata
checks before and after reading. FIFO, directory, symlink and oversized inputs
refuse before replay or signing inspection. The same reader preserves empty
and binary CAS payloads, and `put` reads its payload before creating writable
state. `frontend_request_bounds` executes these public commands and a fresh
valid retry under the existing bounded process owner.

## Local boundary

The report includes the release-state result, trust-layer result, drill report,
deduplicated blockers, and a domain-separated report hash. The release-state
and trust-layer values are explicitly marked as caller-supplied pure projections;
they are not source-bound observations. V1 retains those projections. The same
command accepts a closed V2 `ReleaseAttestationSourceRequestV2` with
`workspaceRoot`, root-owned ELF `gitExecutable` and SHA-256 pin, expected
commit/tree, expected release-state snapshot hash and `timeoutMs`. V2 derives
provenance and the snapshot from actual Git and the five fixed repository
documents. It binds tree/index modes and blobs to actual read bytes, verifies
Git object integrity, and retains source/tool descriptors and directory
identities across the observations. The shared ordered serializer preserves
the qualified Node snapshot hash and tag ordering. Cancellation reuses the
existing bounded process-group owner with explicit resource limits.

The V2 source owner limits each file to 32 MiB, all observed bytes and original
blob responses to 2 GiB, source entries to 200,000, held directories to 4,096,
and the operation deadline to the requested value up to 600,000 ms. These
limits apply to V2 source inspection. V1 retains the existing archive/SQLite
drill owner and its resource boundaries; V2 does not add limits to that drill.

Successful V2 capture closes only provenance capture and snapshot binding. It
retains five internal implementation blockers, four external qualification
blockers and any observed release-state refusal. The current signed release
capability remains unobserved. It never reads a signing key,
writes runtime evidence, mutates or deletes a legacy database, publishes a
bundle, or grants release or Node-retirement authority.

The ordinary command also accepts closed V3 `ReleaseAttestationReplayRequest`
with a V2 `source` request, `nodeExecutable`, its SHA-256 pin and `timeoutMs`.
The native owner evaluates the fixed P0/P1 input corpora in Rust, executes the
actual qualified Node implementations and minimal archived Python baseline on
those same inputs, and compares the observed outputs. It reuses the existing
bounded process-group owner and cancellation adapter. Node/Python are explicit
differential dependencies; ordinary Rust calculations do not invoke them.

V3 retains actual executable descriptors, full source captures before/after,
and seven explicitly selected Node module/archive input descriptors during the
oracle window. Named/held metadata, raw hashes and directory identities must
remain unchanged. Captured stdout must match the complete measured byte count
and hash; a truncated diagnostic tail cannot substitute for the complete
output. The fixed input list is an observation scope, not a proof of every
possible dynamic import. Resource limits and the selected input list are
declared in `release_replay/execution.rs` and its `source_graph.rs` child.

This closes the implemented fixed-corpus differential behavior. It does not
complete restored-runtime replay, the whole retirement matrix or policy,
signing integration, runtime publication or recovery. V3 preserves the V2
machine blocker lists and false readiness/authority fields until those broader
requirements are implemented and independently qualified.

The same ordinary entry accepts closed V4 `ReleaseAttestationPolicyReplayRequest`
and V8 `ReleaseAttestationMeasuredPolicyReplayRequest` envelopes. These inspect
the original 263-source matrix and run its ten fixed Node observer suites with
held source, executable and archive inputs through the existing bounded process
owner. V8 selects the fixed `immutable_263_source_inspection_v1` profile: only
the original `bin/paperctl` path, matrix id and SHA-256 receive the measured
16 MiB exception. Other files retain the original 4 MiB limit. Selected sources,
archive, pipes, tools and the deadline keep explicit caps; caller fields cannot
widen them. The exact machine limits and package/asset identities live in
`release_replay/execution/policy`.

The Node observers use seven exact lock-bound parser packages and fifteen held
current-project runtime data assets. These assets are differential inputs, not
members of the original archive or proof of a restored runtime; the empty R
source CAS remains unqualified. Two Rust pure matching calculations compare the
same actual inputs. Success of a Node suite never counts as a Rust policy port.
Eight native policy/runtime ports, complete restored-runtime equivalence,
signing, durable publication/recovery and independent external qualification
remain required. V4/V8 retain blocked readiness and grant no authority.

## Implementation and external blockers

The result is always `release_attestation_blocked` with
`releaseEvidenceReady=false`. The V1 report retains its caller-projection
implementation gaps. V2 closes source/provenance capture and release-snapshot
binding, but retains actual conformance replay, policy replay, signing
integration, publication and recovery as implementation gaps. Both distinguish
these from external qualification requirements (independent owner/operational
acceptance, release-key custody and physical deletion authority). A blocked
report is printed before the CLI exits non-zero.

## Validation

The focused Rust unit test verifies release-subject mismatch rejection, while
the reused drill-attest tests cover real schema-25 freeze, archive identity,
hardlink rejection, unchanged database bytes, and blocked CLI behavior. Compile
and test with:

```sh
rustup run 1.98.0 cargo fmt --manifest-path rust/Cargo.toml --all -- --check
rustup run 1.98.0 cargo clippy --manifest-path rust/Cargo.toml -p hepta-paper-service --all-targets --locked -- -D warnings
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --locked --test release_attest_source_capture --test release_attest --test release_replay --test release_replay_referee --test release_replay_execution --test release_replay_policy
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --locked --test frontend_request_bounds
```

The V2 tests inspect actual private Git repositories and replay the qualified
Node release-state/provenance owners. They cover readable corrupt Git objects,
common and worktree integrity-bypass configuration, hidden index flags,
unchanged stat-cache hints, executable modes, replaced descriptors, cancellation
and deadlines. Ordinary CLI tests verify both the blocked report and duplicate
or unknown JSON field refusal. Private fixtures supply no release authority.

The V3 tests run actual fixed-corpus Node/archived-Python differential checks
and the ordinary `release-attest` CLI. They reject invalid corpora, false claimed
results, dirty or divergent source, changed source/tool metadata and incorrect
tool pins. Running Node/Python cancellation and deadline cases check actual
process identities and complete group cleanup. They do not qualify a target
host or supply external signing material.

The policy tests reject caller acceptance counts, duplicate fields, substituted
archive/profile identities and resource escalation before any oracle executes.
Library owner tests enforce precise source limits, matrix contracts, closed
package/runtime namespaces and process caps. The functional source manifest
binds each executable selector; it does not register private host-run results
as current signed-head or prospective-merge acceptance.

This is a `partial_local_source` candidate only. The incumbent Node route
remains required for complete release-evidence qualification.
