# Codex broker admission and durable state V1

## Security claim

This slice establishes source-level contracts for accepting a local request and
reserving exactly one broker operation. It does **not** qualify a real Codex
binary, load real provider credentials, call a model, update the campaign
database, or authorize release/submission.

## Wire frame

```text
8 bytes  magic        HEPTACX1
8 bytes  payload size unsigned big-endian
N bytes  UTF-8 JSON   CodexExecutionRequestV1
```

The receiver checks `SO_PEERCRED` before reading the body. Payload size is
checked before allocation and is hard limited to 1 MiB. Empty, truncated,
oversized, malformed, unknown-field and semantically invalid requests fail
closed. The decoder re-encodes the typed request and requires byte equality, so
alternate whitespace, field order or duplicate-field encodings are rejected.
The journal stores the exact payload bytes and SHA-256.

## Peer policy

A role-specific broker has a nonempty exact set of allowed:

```text
(uid, gid)
```

The kernel-observed PID must be positive. UID/GID must be present in the policy.
The request capability repeats UID/GID and must match the kernel observation.
The broker policy additionally pins one exact role, sandbox surface and qualified
Codex runtime-identity hash. A valid author request cannot enter a reviewer
broker, and a request qualified for runtime A cannot be replayed to runtime B.
The peer PID is recorded as evidence but is not signed so an exact idempotent
reconnect can survive a client restart under the same principal.

## Capability

`RequestCapabilityV1` binds:

```text
nonce
issuedAtUnixMs
expiresAtUnixMs
signerKeyId
peerUid
peerGid
signatureBase64
```

The Ed25519 signing message is domain-separated and length-prefixes every field
of the execution request except the signature bytes. Verification requires:

- known non-weak public key;
- strict Ed25519 verification;
- issue time no further in the future than the allowed skew;
- expiry strictly after issue time;
- bounded lifetime;
- expiry no later than the request deadline;
- current time before capability expiry and request deadline;
- UID/GID equality with `SO_PEERCRED`.

A valid signature does not override role/task/sandbox policy or any downstream
runtime, workspace, evidence or campaign-generation check.

## Admission order

```text
SO_PEERCRED
  -> exact principal allowlist
  -> bounded frame
  -> strict request validation and canonical JSON equality
  -> exact broker role/sandbox/runtime binding
  -> capability peer/time/signature validation
  -> authenticated request object
  -> SQLite reservation
```

No operation or nonce row is created before all preceding checks pass.

## Broker journal

Tables:

```text
broker_metadata
operations
capability_nonces
operation_transitions
```

`operations` stores immutable request/peer/capability identity plus mutable,
validated projections. A deferred circular foreign-key contract ties each
operation to exactly the nonce/signer/timestamp tuple consumed for that
reservation.

Mutable projections are limited to:

```text
currentState
providerActionMayHaveStarted
preparedReceiptHash
updatedAtUnixMs
```

`operation_transitions` is the authoritative append-only history. SQLite
triggers reject transition/nonce update or deletion and operation deletion.
Application code reconstructs `OperationJournalV1` from rows and re-runs the
normative transition validator before accepting state.

## Reservation behavior

| Condition | Result |
|---|---|
| new operation/idempotency/nonce | atomically reserve and consume nonce |
| exact duplicate idempotency payload | return existing journal |
| same idempotency, different evidence | reject |
| existing operation ID under another reservation | reject |
| nonce already attached to another operation | reject |
| authenticated request expired before transaction | reject without consuming state |
| injected failure after operation insert | transaction rollback |

## Transition behavior

A transition uses `BEGIN IMMEDIATE` and:

1. loads/revalidates the complete journal;
2. compares the persisted current state with the caller's expected state;
3. applies the normative in-memory transition;
4. inserts the append-only transition;
5. updates state/projections with compare-and-swap;
6. commits.

A failure after transition insertion but before projection update rolls back
both. `process_spawned` permanently sets the provider-may-have-started
projection. `result_prepared` binds the prepared receipt hash.

## Startup validation

First creation writes and fsyncs a private sibling `.initializing` marker before
the database file exists. Recovery may roll forward only an empty unstamped
database or the exact stamped schema. An unmarked empty/foreign database is
rejected, and the marker is removed only after complete schema/envelope
verification and parent-directory fsync.

Every open checks:

```text
private parent and database file identity
application/user/schema version
exact STRICT table/trigger manifest
single immutable broker-metadata row
SQLite integrity_check
foreign_key_check
exact operation/nonce/signer/timestamp projection
every reconstructed OperationJournalV1
provider-start projection
prepared-receipt projection
```

Any mismatch disables operation spawning.

## Fault suite

Source tests cover:

- frame truncation and oversized declared length;
- noncanonical JSON rejection;
- kernel peer allow/deny;
- peer-bound signature success;
- signature tampering, expiry and UID mismatch;
- duplicate idempotency;
- nonce replay;
- operation/nonce-insert rollback followed by close/reopen;
- transition/projection rollback followed by close/reopen;
- validly signed cross-role and cross-runtime rejection before durable state;
- expired authenticated request rejection before durable state;
- close/reopen reconstruction;
- stale valid initialization-marker roll-forward without data loss;
- malformed marker and unmarked empty-database rejection;
- foreign-schema and extra-schema-object rejection;
- weak journal parent permissions.

Actual compile/test and process-crash evidence remains blocked until a Rust 1.98
runner is assigned.
