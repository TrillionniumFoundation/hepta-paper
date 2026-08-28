# Codex broker protocol and operation journal v1

Status: source implementation on `codex/rust-broker-protocol-journal-20260828`; no production authority.

## Purpose

This slice establishes the local control-plane boundary that exists before a
Codex process can be inspected or spawned. It authenticates one bounded request,
records an idempotent external-operation reservation and returns a machine
response. It does not launch Codex, read credential bytes, write campaign state,
sign releases or authorize submissions.

## Admission sequence

```text
Unix socket connection
  -> Linux SO_PEERCRED
  -> exact UID/GID policy
  -> fixed 56-byte frame header
  -> payload length checked before allocation
  -> exact payload SHA-256
  -> deny-unknown-fields request decode
  -> request/domain validation
  -> peer/request/broker-bound HMAC capability
  -> request deadline check
  -> SQLite IMMEDIATE reservation transaction
  -> operation/request/idempotency/nonce uniqueness
  -> reserved-state response frame
```

Every connection carries one admission request. A successful admission creates
only `reserved` state. Provider execution requires later runtime, workspace and
journal transition gates.

## Frame v1

Header layout:

| Offset | Bytes | Meaning |
|---:|---:|---|
| 0 | 8 | magic `HEPTACX1` |
| 8 | 2 | version, big endian |
| 10 | 2 | message kind |
| 12 | 4 | reserved flags, must be zero |
| 16 | 8 | payload length, big endian |
| 24 | 32 | raw SHA-256 payload digest |

The payload cannot be empty. Deployment limits may reduce but cannot exceed the
16 MiB protocol hard maximum. Unknown versions, kinds, flags, truncated data and
hash mismatch fail before JSON influences broker state.

## Peer authority

The peer PID, UID and GID are read from Linux `SO_PEERCRED` through the pinned
Rustix source. No request field can replace or override kernel credentials.
Policies contain explicit nonempty UID and GID sets and can deny root.

PID is evidence and is included in the request capability subject. A capability
issued to a previous process instance therefore cannot be replayed after that
process exits and a new process obtains the same UID.

## Request capability

Foundation V1 uses a local HMAC-SHA256 capability. The authenticated subject
contains:

```text
broker instance ID
kernel peer PID / UID / GID
all CodexExecutionRequestV1 fields
nonce, expiry and signer-key ID
all authority and budget hashes
```

The signature is canonical standard Base64. Verification is constant-time after
shape validation. The expiry is short and bounded relative to broker time. The
journal additionally makes the nonce unique.

This is a same-host authenticated capability, not an external signature or an
independent trust-domain attestation. The issuer and broker share key material.
Production qualification must define key-file ownership, rotation, zeroization,
recovery and incident response before credentials are enabled.

## Broker SQLite journal

The broker database is separate from campaign state. Its parent and database
objects must be canonical, owner-bound, private and single-link. WAL and SHM
sidecars receive the same checks.

Durability profile:

```text
journal_mode = WAL
synchronous = FULL
foreign_keys = ON
trusted_schema = OFF
temp_store = MEMORY
```

Core uniqueness:

```text
operation_id UNIQUE
request_hash UNIQUE
idempotency_key UNIQUE
capability_nonce UNIQUE
```

An exact duplicate returns the existing reservation. Reusing any secondary
identity for another operation fails closed.

Transitions are append-only. The current state and revision are updated with a
compare-and-swap transaction after the in-memory Rust state machine accepts the
transition. Transition rows carry a domain-separated hash. Update/delete
triggers protect immutable identity and transition history.

## Crash and ambiguity rules

- failure before transaction commit leaves no reservation or transition;
- failure after an exact reservation can return the existing operation;
- a transition insert and state/revision update are one transaction;
- stale current state or revision cannot commit;
- `process_spawned` permanently raises `provider_action_may_have_started`;
- `result_prepared` binds one immutable prepared receipt hash;
- terminal journal states cannot reopen;
- prepared results integrate without provider re-execution.

## Public error surface

Socket peers receive only a bounded code:

```text
invalid_frame
invalid_request
peer_unauthorized
capability_rejected
replay_or_conflict
journal_unavailable
internal_failure
```

Paths, SQL, credential metadata and internal errors are never serialized to the
peer. Full errors remain local operator observations subject to redaction.

## Negative tests

The source suite covers:

- wrong magic/version/kind/flags;
- empty, oversized, truncated and tampered frames;
- unknown JSON fields;
- UID/GID policy mismatch;
- capability request/peer tampering;
- expired and overlong capability windows;
- duplicate reservation and nonce/idempotency replay;
- stale-state transition;
- injected SQL failure rollback;
- prepared-result recovery;
- symlink database rejection;
- end-to-end response and sanitized error frames.

## Explicit non-authority

This slice cannot:

- inspect or launch the real Codex binary;
- read or serialize Codex credential bytes;
- mutate the campaign database or trusted ledger;
- integrate a workspace result;
- sign a release;
- use portal credentials or a submission permit.

## Qualification blockers

Before merge or any credential-bearing deployment:

1. Rust 1.98.0 must actually compile, format, lint, test and build docs;
2. the resolved `Cargo.lock`, bundled SQLite identity and Rustix revision must be
   committed and reviewed;
3. the foreign-database initialization path and schema fingerprint must be
   fault tested;
4. HMAC key custody and guaranteed zeroization must be qualified;
5. existing runtime P0s for stable `CODEX_HOME` identity and schema authority
   separation remain closed gates;
6. listener socket path ownership, stale-socket recovery and systemd deployment
   must be implemented in a later slice.
