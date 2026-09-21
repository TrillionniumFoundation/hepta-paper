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
  `verify_external_qualification_closure_v1` factory and opaque
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
remain V1. The durable ledger schema is V2. The report digest and the opaque
closure digest are separate domains and are not interchangeable.

## File and resource contract

The request is a canonical absolute path to a singly linked regular file,
owned by the effective consumer UID, mode `0400` or `0600`, under its private
`0700` directory. Its declared consumer UID must match the actual Linux process.
Request and trust documents are limited to 1 MiB each. Exactly seven declared
envelope/payload pairs are required, with distinct paths that do not alias the
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
3. Pass the actual envelopes and payloads to the public opaque factory. It
   re-verifies them, requires all seven package IDs, distinct nonces and payload
   hashes, and five independent authority groups. An authority domain cannot
   straddle those groups. Its retained exclusive expiry is the minimum of all
   seven envelope expiries, all seven payload expiries and the four required
   inner authority-receipt expiries. The payload-derived bound is returned only
   after payload validation and every required nested signature succeeds.
4. Require cgroup and storage packages to agree on `hostIdentityHash`; storage
   and cutover/soak packages must agree on `databaseIdentityHash`. The factory
   also derives service identity, Codex runtime identity and writer-transfer
   receipt identity from the verified payloads.
5. Build the existing V1 report from records obtained through the opaque
   closure's `package()` accessors. Joint verification failure occurs before
   opening, creating or advancing the replay ledger.
6. In one `BEGIN IMMEDIATE` transaction, advance monotonic verifier time and
   trust generation and check all seven nonces, then insert the canonical
   receipt and nonce bindings. Commit and sync precede stdout publication.

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
The current CLI samples wall time once before reading inputs. Acceptance is
evaluated at that instant; the report is not a continuously current activation
permit and carries no separate observation-time field.

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
and checked arithmetic. Deterministic fixture time is not a system-clock or
SQLite lock-wait currentness test. Fixture keys supply test evidence
only; the helper tests do not claim an installed cross-UID file-ingestion pass.

The public opaque factory remains the input boundary for a later owning native
activation loader. A CLI report cannot be deserialized into that authority.
`serviceUnitHash` is a signed commitment; ingest does not independently observe
service-manager objects, ELF build provenance, mounts or legacy-runtime scans.
Complete native deployment and independently controlled production packages
remain required. See the
[external authority protocol](../../../docs/qualification/EXTERNAL_AUTHORITY.md)
and [qualification model](../../../docs/qualification/QUALIFICATION_MODEL.md).
