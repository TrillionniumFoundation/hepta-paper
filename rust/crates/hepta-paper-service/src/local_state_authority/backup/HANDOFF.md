# Native local backup authority handlers

`backup.rs` implements the four incumbent handlers from
`paper-adapters/automation/local-autonomous-research-state-authority-backup.mjs`:
backup reservation, finalization, current-head observation, and finalized journal
range. `LocalStateAuthorityRuntimeV1` owns the SQLite connection and wraps every
dispatch in an IMMEDIATE transaction. These private handlers require an existing
transaction and do not begin or commit one themselves. They sign with the
runtime's configured authority key through `Context::sign_backup`; they never
create a production key or confer writer/deployment qualification.

Normal receipt kinds, status strings, request hashes, payload signing domain and
field sets remain unchanged. Journal responses retain the original nonempty
range protocol and its maximum of 4096 entries. A current-head observation is a
point-in-time statement made under the authority transaction; it is not a newly
granted long-lived mutation lease.

## Fencing and persisted evidence

- Reservation requires finalized schema state, no unresolved mutation, and exact
  actual database instance membership. An existing live backup blocks another
  reservation. The mutation handler checks the same live backup table before a
  new mutation reservation; all checks and writes share the owning transaction.
- New finalization requires an unexpired backup lease, unchanged actual global
  sequence/hash, finalized schema state, and zero unresolved mutations. At the
  expiry instant the lease has ended. An expired backup can no longer claim
  continuous fencing even if its requested timestamp is old.
- An already completed finalization remains idempotent after expiry. Its exact
  original request, signed reservation, persisted finalization body, signature,
  reservation binding, and original finalization time are rechecked first.
  Conflicting requests or corrupt stored receipts fail without new writes.
- Current-head and journal responses require finalized schema and no unresolved
  mutations. A journal range must end at the actual current sequence/hash because
  its response includes the actual current database heads. Every stored reserve
  and finalize pair is cryptographically verified against the runtime's public
  identity; global and per-database continuity and terminal touched heads are
  checked before signing. Missing rows, wrong caller endpoints, stale endpoints,
  or corrupt signatures cannot become a complete-journal receipt.

These are intentional correctness fixes to the incumbent. The Node reserve and
finalize handlers permitted a mutation between backup reservation and
finalization while still signing `allRegisteredMutationsFencedThroughFinalize`.
Its journal handler also echoed a caller's old endpoint while returning current
database heads. The native code rejects those states. Native strict JSON and
timestamp support remain the runtime's existing fail-closed contract; no V8
legacy timestamp parser is added here. Journal-state migration and genuine host
qualification remain separate from these source transitions.

## Tests

Seven unit tests use the actual schema, real Ed25519 signatures from an isolated
test key, actual mutation handlers, and transaction rollback. The accompanying
`rust/oracle/local-state-authority-backup-v1.mjs` extracts the incumbent runtime's
actual schema and calls its original handlers and receipt verifiers over the
same journal data. Successful finalization/head/journal receipts compare exactly,
including signatures. Reservation comparison excludes only each independently
generated UUID and its signature; the native receipt also passes the original
Node verifier.

Coverage includes live backup versus mutation, expiry and pending reservations,
the reproduced Node false fencing claim, completed-result retry after expiry,
signed two-mutation journal replay, stale/forged/missing ranges, corrupt persisted
signatures, invalid requests, and rollback after real signed writes. These are
authority state-machine and transport contract tests; the opaque changeset bytes
are not offered as a business-database replay or production qualification.
