# Native externally fenced SQLite mutation coordination

The Rust coordinator implements the local reserve/apply/finalize protocol and
pending-finalization recovery. It consumes authenticated external authority
responses; it does not implement or independently qualify the external
linearizable authority service. It is an internal component of
`module.rust-control-plane-service`, not a new standalone command or a production
runtime activation receipt.

## Source chain and implementation ownership

Incumbent source:

- `paper-domain/automation/autonomous-research-online-mutation-contract.mjs`;
- `autonomous-research-online-mutation-recovery-contract.mjs` and
  `autonomous-research-online-writer-manifest.mjs`;
- `paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs`,
  its `-validation.mjs` companion, `externally-fenced-sqlite-mutation-recovery.mjs`
  and `externally-fenced-sqlite-storage-primitives.mjs`;
- `autonomous-research-online-mutation-authority.mjs` for pinned public authority
  verification and controlled process IPC;
- `externally-fenced-sqlite-mutation-plan.mjs` for the fixed SQL statement surface.

Rust files under `rust/crates/hepta-paper-service/src/`:

| File | Responsibility and principal symbols |
|---|---|
| `sqlite_mutation_coordinator.rs` | protocol constants, required database roles, typed error, canonical hash helpers |
| `sqlite_mutation_coordinator/contracts.rs` | `assert_reserve_request_v1`, `verify_reservation_v1`, `build_finalize_request_v1`, `assert_finalize_request_v1`, `verify_finalization_v1`, `verify_current_head_v1`, abort/resolution assertions and verifiers, state/marker/receipt/signed-payload hashes |
| `sqlite_mutation_coordinator/manifest.rs` | `assert_writer_manifest_v1`, `writer_manifest_hash_v1` |
| `sqlite_mutation_coordinator/execution.rs` | `SqliteMutationCoordinatorV1`, `SqliteMutationCoordinatorOptionsV1`, `RecoverabilityEpochFenceV1`, commit/abort/control outcomes |
| `sqlite_mutation_coordinator/recovery.rs` | `recover_sqlite_mutations_v1`, persisted request/marker/reservation verification |
| `sqlite_mutation_coordinator/storage.rs` | `exact_schema_hash_v1`, metadata/head queries, marker insertion and finalization recording |
| `sqlite_mutation_coordinator/clock.rs` | `MutationClockV1`, `SystemMutationClockV1`, ISO formatting and random UUID nonces |
| `sqlite_mutation_coordinator/authority.rs` | `MutationAuthorityTransportV1`, `PinnedMutationAuthorityV1`, opaque `VerifiedMutationReceiptV1` |
| `sqlite_mutation_coordinator/authority/files.rs` | bounded descriptor-relative public-input snapshots and duplicate-key rejecting JSON |
| `sqlite_mutation_coordinator/authority/process.rs` | `ProcessMutationAuthorityTransportV1`, pinned held-descriptor process execution |
| `sqlite_mutation_plan.rs` and its submodules | validated fixed plans and restricted SQLite Session transaction surface |

This is a static source map. It does not substitute for a dynamic call trace or
independent operational qualification.

## Construction and callback API

`PinnedMutationAuthorityV1::load(configuration_path, expected_configuration_file_hash,
transport)` requires an independently supplied SHA-256 of the raw configuration
bytes. `load_process(process_configuration_path, expected_process_configuration_file_hash)`
constructs the controlled process adapter. Callers cannot directly create a trusted
client from an arbitrary JSON trust object or construct a verified receipt.

`SqliteMutationCoordinatorV1::new(authority, options, clock, fence)` accepts:

- the pinned authority client;
- `SqliteMutationCoordinatorOptionsV1`: `manifest`, `operation_plans`,
  `database_instances`, optional `requested_lease_ms`, and `commit_safety_margin_ms`;
- `Box<dyn MutationClockV1>`; production can use `SystemMutationClockV1`;
- an optional `Box<dyn RecoverabilityEpochFenceV1>`.

The default lease is the smaller of 60 seconds and the trust's maximum lease.
The safety margin must be at least 100 ms and less than the selected lease.
Reserve-request validation additionally enforces the authority's lease limits.
The coordinator owns transaction lifetime; the statement-plan layer never commits
or reserves authority.

`execute_mutation(&mut Connection, &input, callback)` takes the database role/instance,
writer/operation, schema contract, authorization-receipt hashes and side-effect
reservation hashes in `input`; an optional code-provenance hash must match the
writer's implementation hash. The callback accepts only
`&mut RestrictedMutationTransactionV1`, uses registered `get`/`all`/`run` statement
identifiers, and returns `Result<serde_json::Value>`. It cannot return a future
through this API. The callback's result becomes the receipt's `value`. Exclusive `&mut Connection`
borrowing prevents safe Rust callbacks or captured transports from simultaneously
using a second alias of that same connection to escape the transaction boundary.
This is a deliberate ownership restriction beyond the incumbent freely captured
JavaScript connection; unsafe raw-handle misuse is outside this API contract.

`recover_pending_mutations(&mut Connection)` performs the persisted finalization
recovery chain. `inspect_status()` always includes runtime activation as a blocker;
partial role coverage adds the 100-percent-writer-coverage blocker. A configured
status is not an activation or production acceptance claim.

## Writer manifest and protocol contracts

The manifest validates all ten required database roles and exact object shapes.
Operation IDs and role/source/entrypoint anchors must be unique. Integrated
operations must be online DML classes. Writers must have sorted unique role and
operation assignments, valid implementation hashes and the same protocol. Every
integrated operation must be assigned exactly once; a covered role cannot leave
another DML operation uncovered. Claimed covered roles/count/percentage are
recomputed. Plan hashes are independently checked against this validated manifest.

Requests bind the scope, database-scope hash, writer-manifest hash, writer and
operation, implementation provenance, prior global and per-database heads,
schema, pre/post state, SQLite changeset and authorization/reservation hashes.
The changeset is nonempty canonical Base64, at most 16 MiB, with exact byte length
and SHA-256. Hash lists must be sorted and unique. State hashes bind the next
database sequence and the complete changeset hash. Marker hashes additionally
bind the signed reservation receipt and local commit timestamp.

Head receipts must include sorted, unique database instances covering every
required role and exactly match the expected instance/schema list. They require
zero unresolved reservations, the request nonce/hash, a live observation window,
authorized identity and a real signature. Reservation/finalization/abort/resolution
receipts have exact types and field sets and must mirror their corresponding
requests. The production-compatible Rust record encoder computes hashes; no
Node output snapshot is used in the implementation.

## Pinned authority and process boundary

The authority configuration and referenced public-key document are read through
bounded `O_NOFOLLOW` descriptor-relative readers. Regular files must have one
link, belong to the effective user or root, and lack group/world write permission.
The reader checks size, identity, mode and timestamp snapshots, ancestor identities,
raw-byte hashes, JSON shape and duplicate object keys. The key document must match
the pinned authority/key IDs and contain a supported Ed25519 public SPKI PEM.
Private-key documents are refused.

Every authority operation rechecks the held public-input snapshots. Ed25519
verification authenticates the UTF-8 protocol signed-payload hash after contract
validation. Only then is `VerifiedMutationReceiptV1` created. Its value is immutable
and its verifier identity prevents cross-configuration reuse. Stored reservations
are verified at their recorded issuance time; stored finalizations use recorded
finalization time. This permits historical recovery without renewing a live lease.
File snapshots protect the observed operation; they are not leases over future
filesystem state.

`MutationAuthorityTransportV1::invoke` returns untrusted JSON. Implementing this
trait cannot mint an opaque receipt and does not establish external service
linearizability. The process adapter requires pinned process/configuration files,
an executable command, no extra fixed arguments, a bounded timeout, a clean
`PATH=/usr/bin:/bin`, `LANG=C`, `LC_ALL=C` environment, and no shell. The selected
executable is invoked through a held descriptor to avoid pathname substitution.
Pipes are bounded at 64 MiB, sufficient for the 16 MiB changeset envelope and
recovery transport. Nonblocking I/O, deadline handling and bounded shutdown avoid
hanging when escaped child processes retain pipe descriptors. These mechanisms
are currently Linux-specific.

## Local transaction and failure ordering

Before beginning a transaction, the coordinator validates the input/manifest,
rejects an existing transaction, reads the provisioned metadata, recomputes the
exact SQLite schema hash and checks protocol/role/instance/schema/scope/manifest
bindings. It refuses implicit genesis or metadata provisioning.

If a local committed marker lacks a finalization receipt, recovery runs first.
A successful recovery returns `pending_recovery_completed_retry_required` before
the new callback can run. Failure stays blocked; fatal recovery errors propagate.
With an epoch fence, control outcomes record reconciliation requirements and carry
explicit deferred/retryable flags. A successful recovery marks finalized heads
without manufacturing a new mutation.

The coordinator obtains a fresh authenticated external head and compares it with
the latest local database head. It begins `BEGIN IMMEDIATE`, checks that the local
head has not changed, captures a SQLite Session changeset around the restricted
callback, and rechecks schema and protected-system-table counts. An empty changeset
rolls back and returns `no_change` with no side-effect permit.

For a nonempty changeset, it requests a signed reservation. If the reserve response
is lost or fails, it queries the same mutation attempt and reserve-request hash.
A verified `not-found` response fails without committing; unresolved resolution
returns a reconciliation-required control outcome. A resolved reservation still
must pass the complete pinned verification chain.

The remaining lease must exceed the safety margin both before marker insertion and
immediately before `COMMIT`. The marker persists the original reserve request,
request hash, signed reservation, receipt hash, previous/new state/head fields,
local marker hash and commit time in the same transaction as business DML.

Before a commit attempt, failure rolls back and attempts an authenticated abort
with the stage-specific reason. Abort failure reports `reservation_abort_pending`.
Once a commit has been attempted, failure is conservatively reported as
`commit_outcome_unknown`; no abort is issued on an uncertain commit. After a known
commit, authority finalization failure and local finalization-record failure remain
explicit committed/pending outcomes. They never return a usable success receipt.
An unexpected callback unwind also rolls back the local transaction through RAII.

A signed finalization is recorded in its own immediate transaction. An existing
reservation ID is accepted only when its stored receipt hash matches exactly.
The successful receipt carries reservation/finalization hashes and the authenticated
`sideEffectPermitHash`. That hash alone is not a separately verified mirror repair,
submission or other external-action permit.

## Recovery and epoch fencing

Recovery requires an idle connection and matching provisioned metadata/schema. It
loads unfinalized markers in database sequence order, parses their original JSON,
recomputes request and signed-receipt hashes, checks all mirrored fields against
the row and metadata, verifies the stored signature at issuance, and recomputes
the local marker hash. It then obtains and verifies a finalization, records it,
and returns recovered reservation IDs and finalized global heads. Corrupt JSON,
substituted signatures, mismatched hashes and local marker drift are refused
before finalization transport is invoked.

The optional `RecoverabilityEpochFenceV1` has explicit current/reconcile and
mark-finalized/mark-reconciliation operations. The coordinator uses the two mark
operations and preserves fatal fence errors. An epoch error after durable commit
retains `committed:true` and the reservation identity. The coordinator does not
implement the underlying external epoch authority or claim it has reconciled.

## Validation and remaining scope

The fixed-plan layer exposes `validate_sqlite_mutation_operation_v1`,
`externally_fenced_sqlite_writer_plan_hash_v1`,
`validate_sqlite_mutation_plans_v1`,
`assert_sqlite_mutation_database_surface_v1` and
`with_restricted_sqlite_mutation_v1`. Validated plans and their statement fields
are opaque. Statement IDs must be unique and ordered, SQL must belong to the
bounded SELECT/DML grammar, and DDL/transaction control/comments/system-table
writes are rejected. Production collation and record hashes preserve the tested
Node plan identities, including raw legacy identifier values used only in hashes.
A numeric ID cannot be invoked by supplying its string spelling.

The restricted wrapper itself requires an existing transaction and validates the
database surface before invoking the callback. It takes `&mut Connection`; a
compile-fail documentation test verifies that capturing the same connection to
commit inside the callback is rejected by Rust's borrow checker. Statements can
return rows, including DML `RETURNING`, without exposing arbitrary SQL or a raw
connection. Temporary guards prohibit unplanned table/operation effects. Their
RAII cleanup runs on errors and unwinding; the outer coordinator rolls back.

Actual changes are captured by the bundled SQLite Session extension and decoded
by `sqlite_changeset.rs`. The decoder rejects patchsets, indirect effects,
malformed/truncated records, invalid primary-key order, invalid UTF-8 table names,
more than 1,024 tables, 4,096 columns, 1,000,000 changes or 16 MiB. Every observed
effect must occur both in the signed plan and in a successfully invoked fixed
statement. It never applies a supplied changeset. A 400-plus-case oracle corpus
uses real Node SQLite changesets and damaged variants; tests compare complete
effects, authorization projections and stable rejection codes.

Intentional safety tightenings cover gaps also found in the incumbent: NULL
primary keys that Session would omit are rejected both in existing rows and in
new INSERT/UPDATE effects; case aliases cannot bypass trigger, foreign-key or
system-table restrictions; names such as `sqliteX` are included in guards rather
than lost through SQL LIKE's underscore wildcard. Six plan integration tests
cover those attacks, actual return values and changesets, Node plan hashes,
surface checks, cleanup and callback failure. These additional denials need
explicit compatibility review before production replacement.

The workspace enables rusqlite's `session` feature on the locked bundled SQLite
source. Building therefore requires a C compiler and a discoverable `libclang`
shared library for generated Session bindings; local validation uses Clang 18.
No Node process or Clang toolchain is required by native service execution.

`tests/sqlite_mutation_coordinator_parity.rs` currently has six tests. The principal
differential test executes 13 scenarios against the original Node coordinator
using in-memory SQLite and a synthetic, genuinely signing Ed25519 authority:
normal commit, no change, lost reserve response, reserve not applied, unresolved
resolution, expiring reservation, marker failure, finalization-record failure,
finalization failure plus recovery, abort failure, both lease-margin boundaries,
and a real deferred-foreign-key `COMMIT` failure. It compares complete requests,
receipts/hashes, coordinator status, row changes and marker/finalization counts.
Nonces captured from the Rust execution are replayed only into the test oracle.

Additional coordinator tests cover manifest/coverage/assignment attacks, invalid
input and nested transactions before authority use, corrupt persisted recovery
records, required retry after recovery, fatal epoch outcomes and callback unwind.
Concrete symbols:

- `signed_coordinator_commit_no_change_resolution_abort_and_recovery_match_node`;
- `manifest_validation_and_hashes_match_node_for_coverage_and_assignment_attacks`;
- `pending_recovery_requires_retry_before_callback_and_preserves_fatal_fence`;
- `recovery_rejects_corrupted_request_receipt_marker_and_signature`;
- `invalid_input_nested_transaction_and_local_metadata_fail_before_authority`;
- `unexpected_callback_unwind_rolls_back_without_reserving_external_authority`.

`tests/sqlite_mutation_authority_parity.rs` adds seven tests covering 40-plus real
signature/domain/binding/lease differential cases, all five coordinator IPC modes,
historical receipt checks, cross-verifier refusal, invalid requests before IPC,
configuration/public-key drift, duplicate JSON, unsafe files, malformed keys,
invalid process output, timeouts, escaped pipe holders and a signed 3 MiB changeset.
The original Node coordinator and mutation-contract suites also pass 32 tests.

Use pinned Node **22.23.1** for the test-only oracles, which qualify its production
Node/ICU/CLDR/hash profile. Tests operate only on disposable fixtures; no live
authority, production database, user private key or production trust is used.

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --test sqlite_mutation_coordinator_parity --test sqlite_mutation_authority_parity
cargo clippy --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --lib --bins -- -D warnings -D clippy::unwrap_used \
  -D clippy::expect_used -D clippy::panic
node --test paper-core/tests/externally-fenced-sqlite-mutation-coordinator.test.mjs \
  paper-core/tests/autonomous-research-online-mutation-contract.test.mjs
```

Explicit limits remain:

- Canonical UTC ISO timestamps are supported; the full permissive `Date.parse`
  language and JavaScript coercions for malformed/non-string identifiers have
  not been adopted. Public keys use strict supported SPKI rather than every
  OpenSSL container/DER variant. Native OS/SQLite/process diagnostic text is not
  claimed to match every raw platform error string.
- The authority is external. Linearizability, durable reserve resolution,
  adversarial service behavior, hosted exact-candidate replay and independent
  authority/owner acceptance require separate evidence. Test signatures prove
  implementation behavior, not production service qualification.
- Active-authority challenges, scope activation, unresolved-reservation startup
  enumeration, schema transitions, cross-database maintenance and higher-level
  permit-journal/mirror repair are separate source surfaces. This coordinator
  does not activate or silently replace them.
- Pending-marker recovery does not audit every already-finalized historical
  marker. Consumers needing a latest finalized proof must verify that separate
  row/request/reservation/finalization chain; arbitrary stored JSON or a permit
  hash must not be treated as an opaque verified action permit.
