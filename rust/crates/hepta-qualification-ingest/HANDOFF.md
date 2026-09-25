# External qualification closure implementation

This crate verifies independently signed evidence for one exact repository,
commit and tree. Its CLI records non-activating acceptance in a private replay
ledger. Neither the CLI receipt nor a successful fixture supplies a writer
lease, native deployment qualification or Node retirement authority.

## Entry points and ownership

- [`src/lib.rs`](src/lib.rs): closed seven-package identifiers, external file
  reader, pinned trust keys, canonical envelope signing bytes and Ed25519 verifier.
- [`src/package_payload.rs`](src/package_payload.rs): strict per-package payload
  schemas, package-specific decisions and nested signature verification.
- [`src/closure.rs`](src/closure.rs): the public
  versioned `verify_external_qualification_closure_v1` /
  `verify_external_qualification_closure_v2` factories and opaque
  `VerifiedExternalQualificationClosureV1`. Only the factory establishes the
  complete set and its cross-package runtime facts; the opaque value has no
  deserialization constructor.
- [`src/bin/hepta-qualification-closure.rs`](src/bin/hepta-qualification-closure.rs):
  Linux consumer identity, strict file ingestion, joint verification, canonical
  report and transactional replay ledger. Invoke
  `hepta-qualification-closure <closure-request.json>`; `--help` is read-only.

The [request schema](../../../docs/rust/qualification/external-qualification-closure-request-v1.schema.json),
[receipt schema](../../../docs/rust/qualification/external-qualification-closure-receipt-v1.schema.json)
and [trust store schema](../../../docs/rust/qualification/qualification-trust-store-v1.schema.json)
describe the unchanged historical V1 profile. Current
[request V2](../../../docs/rust/qualification/external-qualification-closure-request-v2.schema.json)
and [receipt V2](../../../docs/rust/qualification/external-qualification-closure-receipt-v2.schema.json)
remove only the repository-review package. The durable ledger schema is V2. The report digest and the opaque
closure digest are separate domains and are not interchangeable.

## File and resource contract

The request is a canonical absolute path to a singly linked regular file,
owned by the effective consumer UID, mode `0400` or `0600`, under its private
`0700` directory. Its declared consumer UID must match the actual Linux process.
Request and trust documents are limited to 1 MiB each. Exactly six declared
envelope/payload pairs are required for current V2 (seven for historical V1), with distinct paths that do not alias the
declared trust-store or ledger path.

Trust, envelope and payload files must be owned by the declared external UID,
different from the consumer, singly linked, regular and mode `0400` or `0440`.
The ancestor walk rejects symlinks, group/other-writable directories and
consumer-owned writable ancestors. Readers open with `O_NOFOLLOW|O_CLOEXEC`,
bound allocation and reads, and compare path/open-file identity and timestamps
before and after reading. Envelope and trust encodings are compared to their
canonical serialization; payload validators enforce canonical package encoding.
These are read-time checks, not a retained installation or revocation observer.

Each envelope is limited to 8 MiB and each payload to 32 MiB. The CLI applies a
64 MiB aggregate payload budget before allocating subsequent payloads. It moves
the exact payload buffers into candidates; the factory independently enforces
the same per-package and aggregate payload limits. These limits bound input
bytes, not total process RSS: parsed JSON and signature structures add overhead.

## Verification and durable acceptance order

1. Validate the private request, actual consumer UID and externally owned trust
   document. Trust generation is positive, validity is at most 30 days, and the
   forbidden domains include implementation author, repository admin and hosted CI.
2. For each package, verify the actual envelope signature and exact immutable
   subject, then read and hash its payload and validate package semantics. This
   order preserves the existing per-package diagnostic behavior.
3. After every authority file is read and closed, sample the real system clock
   again and require it not to precede the initial sample. Recheck the original
   validated trust document's retained validity window. Pass the actual envelopes
   and payloads to the public opaque factory at this fresh time. It
   re-verifies them, requires the exact versioned package set, distinct nonces and payload
   hashes, and four operational authority groups for V2 (five for V1). An authority domain cannot
   straddle those groups. Its retained exclusive expiry is the minimum of all
   required envelope expiries, all required payload expiries and the four required
   inner authority-receipt expiries. The payload-derived bound is returned only
   after payload validation and every required nested signature succeeds.
4. Require cgroup and storage packages to agree on `hostIdentityHash`; storage
   and cutover/soak packages must agree on `databaseIdentityHash`. The factory
   also derives service identity, Codex runtime identity and writer-transfer
   receipt identity from the verified payloads.
5. Build the versioned V1 or V2 report from records obtained through the opaque
   closure's `package()` accessors. Joint verification failure occurs before
   opening, creating or advancing the replay ledger.
6. Acquire `BEGIN IMMEDIATE`, which may wait behind another writer. Before any
   clock/trust advancement or nonce query, sample the actual system clock again,
   reject regression from step 3 and recheck both the original trust window and
   the genuinely verified opaque closure. Advance monotonic verifier time and
   trust generation using this post-lock sample; check every required nonce, then
   insert the canonical receipt and nonce bindings. Exact existing replay passes
   the same fresh gate. Commit and sync precede stdout publication.

The CLI deliberately repeats cryptographic and payload verification at step 3
to preserve earlier error ordering while giving the opaque factory the original
signed inputs. It does not manufacture an opaque value from public per-package
records or from the report JSON.

The opaque window rejects clocks before its original verification sample or at
and after the earliest expiry. Exact decimal UTC timestamps round upward to
the first invalid integer millisecond: `.1000` expires at millisecond 100;
`.1005` remains valid at 100 and expires at 101. Conversion uses checked integer
arithmetic and agrees with the payload validator's exact decimal comparison.
`assert_current` checks the retained window; it does not observe later key
revocation, re-read files or establish current installed host state.

## Replay, failure and compatibility

The private ledger is consumer-owned, mode `0600`, in a canonical `0700` parent.
Opening checks the application ID, schema V2, exact four-table SQL, absence of
additional schema objects, quick check and required SQLite pragmas. It uses
DELETE journal, FULL synchronous, foreign keys and a five-second busy timeout.
All authority file reads finish before SQLite is opened.

Complete identical replay returns the existing canonical report. Partial nonce
overlap or changed records under existing nonces are rejected transactionally.
Time regression, trust rollback, skipped generations and chain forks are
rejected; a new ledger starts at trust generation 1. No migration of older
ledger schemas is implicit.

Valid CLI report field order, bytes, receipt digest and replay keys remain unchanged.
The separate opaque closure digest includes its derived expiry: it changes for
inputs whose payload or inner receipt narrows the previously envelope-only
window. This correction requires downstream signatures binding that digest to
be regenerated; the envelope and nested-signature formats do not change.
`payloadSemantics=strict_package_v1`, `replayProtection=durable_sqlite_v2`,
`automaticActivation=false` and `productionActivation=false` remain mandatory.
Previously individually valid but cross-inconsistent sets are now refused,
including when old receipts for those sets already exist in the ledger.

An I/O failure after SQLite commit can suppress stdout even though acceptance
persisted. The CLI does not claim rollback or invent a successful receipt in
that case; an exact, still-valid retry uses durable replay reconciliation.
The CLI samples real wall time after the private request, after all authority
input reads, and after acquiring the SQLite writer transaction. Failure before
opening SQLite creates no ledger; failure after opening may leave an initialized
empty ledger, but the rejected transaction advances none of its four tables.
New receipts use the transaction-admission sample. Exact replay keeps its first
receipt acceptance time while advancing the monotonic clock when appropriate.
Zero, unrepresentable or backward clock samples fail closed.

This is currentness at transaction admission. DELETE-mode commit can itself
wait behind readers and filesystem sync may take time; there is no claim of an
atomic clock/commit boundary. Retaining the original validated trust window does
not monitor later file replacement or independently learn an unpublished
revocation. All authority-file reads finish before SQLite opens; the transaction
gate checks retained memory only. The report is not a continuously current
activation permit and carries no separate observation-time field.

## Verification and remaining integration

Run `cargo test -p hepta-qualification-ingest --all-features --locked` from the
Rust workspace. Existing tests cover envelope signatures, payload semantics,
replay, trust generations, clock rollback and malformed SQLite schema. Joint
closure tests use seven genuinely signed fixture packages and actual SQLite to
exercise the production verification/commit helper, including re-signed host
and database disagreement, no ledger creation or mutation on rejection, stable
positive report bytes and conflicting replay. Genuine signatures also cover
each of the seven payloads and each of the four inner receipt expiries, exact
and fractional millisecond boundaries, the earlier outer-envelope case, and
unchanged CLI bytes/replay followed by rejection without ledger mutation at
expiry. Private conversion tests cover long decimal fractions, calendar limits
and checked arithmetic. A real owned child process separately holds SQLite
`BEGIN IMMEDIATE`; the production worker waits, then must take a second clock
sample before either a new acceptance or exact replay. Deterministic injected
clock values cover envelope/payload/inner-receipt/trust expiry, rollback and
unavailable clocks; all four tables remain unchanged on refusal. Positive cases
check fresh persisted time and unchanged receipt bytes. The owned helper has
bounded readiness/exit waits and kill/reap cleanup; its ignored test entry is
invoked by the parent cases. These injected samples do not observe an OS clock
change. The actual CLI always selects `system_unix_ms`; explicit-time test
wrappers are absent from production builds. Fixture keys supply test evidence
only; the helper tests do not claim an installed cross-UID file-ingestion pass.

The public opaque factory remains the input boundary for a later owning native
activation loader. A CLI report cannot be deserialized into that authority.
`serviceUnitHash` is a signed commitment; ingest does not independently observe
service-manager objects, ELF build provenance, mounts or legacy-runtime scans.
Complete native deployment and independently controlled production packages
remain required. See the
[external authority protocol](../../../docs/qualification/EXTERNAL_AUTHORITY.md)
and [qualification model](../../../docs/qualification/QUALIFICATION_MODEL.md).

## Current single-maintainer profile and compatibility

`ClosureRequestV1.version` is an explicit selector: 1 retains the historical
seven-package contract; 2 selects `SingleMaintainerV2` and exactly the six
`CURRENT_REQUIRED` package IDs. Unknown versions, duplicates, a governance
package substituted for a runtime package, and incomplete sets fail before
file intake. No caller can supply a relaxable required-package list.

The common producer authenticates every supplied operational payload and
cross-package identity through the existing verifier. V2 receipt kind/version
are distinct and hashed. The opaque value exposes `profile()` so consumers can
check the actual producer contract. Existing seven-package V1 receipt bytes and
replay remain unchanged; six-package data is never accepted as V1.

The real signed-fixture tests execute the shared post-file CLI owner, commit
and repeat a six-package receipt through SQLite, and reject signature tampering,
host substitution, package omission and clock rollback. These tests do not
claim a real independently owned host, credential or production installation.
Keep the current file/UID, trust, validity and precommit admission rules; no
human PR approval is part of them. Use `cargo test --locked -p
hepta-qualification-ingest` from `rust` to run both historical and current cases.


## Restricted research qualification V3

The existing CLI also accepts the closed
[research request V3](../../../docs/rust/qualification/research-qualification-request-v3.schema.json)
and emits the distinct
[research receipt V3](../../../docs/rust/qualification/research-qualification-receipt-v3.schema.json).
It requires exactly the host/cgroup, destructive-storage, key-owner, separate-role
Codex and cutover/soak packages. Repository-review and irreversible-action
publication/submission packages are neither required nor accepted in this scope.
Actual signatures, nested payload validation, cross-host/database identities,
expiry, authority separation, bounded external file intake, post-lock clock
checks and the original SQLite replay ledger are unchanged. Changing a previously
accepted full package set into this scope cannot reuse the old acceptance.

The public factory `verify_research_qualification_v3` returns a separate opaque
`VerifiedResearchQualificationV3`. It exposes retained facts but has no conversion
or dereference to `VerifiedExternalQualificationClosureV1`; a compile-fail test
protects that boundary. V1/V2 full producers still reject the five-package set,
and the full production-writer API cannot accept this research type. This
separates evidence intake and persistent acceptance, not a new production
research writer. The named runtime consumer, real host evidence and explicit
writer activation still require composition. No source fixture is external
qualification, a provider credential, release permission or submission authority.

`cargo test -p hepta-qualification-ingest --locked` runs actual fixture-signature
acceptance, missing/extra package denial, cross-host/signature rejection,
cross-profile replay and the type boundary; the same suite preserves full V1/V2
fixtures and real SQLite lock-wait currentness tests.
