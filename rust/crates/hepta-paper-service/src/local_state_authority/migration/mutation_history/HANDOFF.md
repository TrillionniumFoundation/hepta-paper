# Read-only incumbent mutation history replay

`verify_mutation_history_v1(&JournalRows, &genesis, &trust, &VerifyingKey)` is a
crate-private pure observer. It consumes the owner's already bounded SQL
snapshot and the final epoch reconstructed by `schema_history`. It uses a real
Ed25519 public key and never receives a private key, signs a record, invokes a
mutation handler, executes SQL, opens files, or changes a connection. Its opaque
result exposes `head()` and `report()`; neither is a migration permission or
proof that an authority process has stopped.

The starting head is exactly `{globalSequence: 0, globalHash, databaseHeads}`.
Every one of the ten unique database roles and instance IDs must be present at
sequence zero. Each head retains `schemaContractId` alongside the persisted
role, instance, hash, schema hash and state hash. The schema-history producer
must authenticate and deterministically reconstruct this anchor. This module
never derives a missing genesis from the first mutation, nor treats input JSON
as independently verified schema evidence.

The snapshot preserves every source SQL value and original JSON TEXT. The owner
checks the six-table Node schema, transaction and connection settings before
capturing rows. Its conservative first-version limits are 10,000 mutation rows,
1 MiB per TEXT cell and 64 MiB across the snapshot. Oversized histories are
rejected, not truncated. Although the online changeset contract permits 16 MiB,
that does not expand this observer's bounded source profile. The source owner
also refuses backup histories and validates initial schema/rebind state; this
mutation-only observer does not replace those checks.

Replay sorts borrowed SQL rows by global sequence, independently of physical
rowid. It verifies all of the following:

- Every original rowid/attempt/reservation is unique; SQL attempt, reservation,
  sequence and database-instance columns match the signed reservation and its
  actual stored request. Finalized and aborted rows have exact mutually
  exclusive nullable request/receipt pairs. Reserved rows are always refused,
  even when a lease has expired.
- Strict JSON parsing rejects duplicate keys and malformed records. Existing
  receipt contracts rebuild canonical signed payloads and validate exact fields,
  the real public-key signature, request/receipt hashes, canonical base64,
  changeset length/hash, derived post-state and local-marker hashes.
- Each global predecessor and touched database predecessor equals replayed
  state. The instance role, schema hash and schema contract remain bound to the
  authenticated final epoch. Global and database sequences increment within
  JavaScript's safe-integer range.
- The observer recomputes `HeptaLocalStateAuthorityGlobalHead`,
  `HeptaLocalStateAuthorityDatabaseHead` and
  `HeptaLocalStateAuthoritySideEffectPermit`. The generic receipt contract only
  validates SHA-shaped values for these fields; even a genuinely signed
  alternative value is insufficient for this incumbent producer profile.
- A finalized row advances both heads. The original Node unconditional unique
  global-sequence index permits at most one aborted next-sequence tail. That
  tail verifies against the current heads without advancing them; any later
  row is refused. No aborted receipt is discarded or repaired.
- The final global head, authority/key/scope/writer fields and all ten actual
  SQL database heads must match, including untouched databases. Full daemon
  configuration-hash binding and the uninitialized branch remain the owning
  history verifier's responsibility.

Historical reservation validation uses its signed `issuedAt`; finalization and
abort use their signed terminal timestamps. Authority finalization may occur
after lease expiry when the stored local `committedAt` met the existing contract.
There is no invented cross-row timestamp monotonicity requirement: the original
Node clock did not provide that invariant. Numeric comparisons preserve Node's
safe-integer equivalence, including JSON `1.0` versus `1`. Such spelling changes
preserve signatures but change the owner's raw SQL logical hash.

The epoch `schemaContractId` check is deliberately stricter than the original
Node reserve handler, which checked the stored schema hash but accepted any
syntactically valid contract ID. This observer refuses histories with another
contract ID, rather than claim that this edge case is automatically compatible.
Likewise a valid authority signature is not evidence of a business database's
actual changeset application, deployed process isolation, exclusive key custody,
or external qualification.

Tests import the shared schema-history fixture, then call the actual Node
22.23.1 runtime's mutation reserve/finalize/abort handlers. They exercise empty
initialized history, mutations across two databases, a genuinely activated
rebind, late finalization, a regressing Node clock, and a valid aborted tail.
Negative cases include reserved rows, missing or transplanted SQL columns,
partial NULL pairs, wrong keys/signatures, duplicate-key JSON, epoch mismatch,
and a correctly signed non-terminal abort. Correctly signed false head and
permit values are shown to pass generic receipt verification and fail this
incumbent replay. Equivalent floating-integer JSON is tested without re-signing.

Actual DELETE and existing WAL source files also retain a real SQLite writer
transaction during snapshot/replay success and failure. A separate process
must remain unable to acquire `BEGIN IMMEDIATE`. Raw fixture bytes and fixture
private keys are read only outside the source connection's lifetime. Private
keys are test inputs only and never enter an observation or report.

Run with the qualified Node on PATH from the Rust workspace:

```text
cargo test -p hepta-paper-service --lib local_state_authority::migration::mutation_history::tests
```

This is one read-only prerequisite of `../../JOURNAL_MIGRATION_DESIGN.md`. No
archive publication, schema rewrite, service-maintenance capability or live
migration entry point is implemented here.
