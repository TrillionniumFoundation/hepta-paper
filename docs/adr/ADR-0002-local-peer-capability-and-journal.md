# ADR-0002: authenticate local broker admission with SO_PEERCRED, HMAC and SQLite

Status: accepted for source-only Foundation V1  
Date: 2026-08-28

## Context

A Codex provider call is cost-bearing and can become ambiguous after process
spawn. The campaign writer therefore needs a local broker boundary that rejects
unauthorized peers, authenticates an exact request, prevents duplicate spawn and
survives process crashes. The boundary must be usable before real credentials
or provider calls are enabled.

## Decision

Foundation V1 uses:

1. Linux Unix sockets and kernel `SO_PEERCRED` for PID/UID/GID observation;
2. an exact UID/GID peer policy;
3. a fixed-length, hash-verified, bounded binary frame;
4. a short-lived HMAC-SHA256 capability bound to the complete request, broker
   instance and kernel peer identity;
5. a broker-owned SQLite database with WAL, FULL synchronous durability,
   append-only transition rows and operation-state compare-and-swap;
6. one admission request per connection;
7. a sanitized machine-only socket error response.

The broker journal is not the campaign database. Admission creates only a
`reserved` external-operation state.

## Why HMAC in V1

The authorized campaign-side issuer and role broker are local cooperating
principals. A compact HMAC implementation avoids introducing a broad signing
stack before dependency and runner qualification. Binding PID/UID/GID, broker
instance, nonce, expiry and every request field prevents payload substitution
and cross-broker replay.

This choice does expand the local TCB because issuer and verifier share a key.
It is not presented as independent or externally authoritative evidence.
Production enablement requires qualified key custody, rotation and guaranteed
zeroization. A future asymmetric capability requires a new protocol version and
ADR, not an in-place semantic change.

## Why SQLite

SQLite already matches hepta-paper's local durable authority model and provides
atomic uniqueness and compare-and-swap transactions without introducing a
network service. `bundled` SQLite is exact-version locked by Cargo once the
runner gate can generate the lockfile.

The journal stores operation identity and transition evidence only. Prompt
bytes, manuscript content, provider credentials and campaign write capability
are excluded.

## Rejected alternatives

### Trust the socket pathname or request UID fields

Rejected because filesystem possession and self-reported identity are not peer
authentication. Kernel credentials are authoritative for the local connection.

### Retry an operation using only an in-memory map

Rejected because crash/restart would lose idempotency and could double-spawn a
paid provider action.

### Reuse the campaign SQLite database

Rejected because it would give the credential-bearing broker a path into
campaign authority and complicate single-writer cutover.

### Open the real Codex CLI in this slice

Rejected because runtime identity, schema authority, credential custody and
compile qualification still have explicit P0 gates.

## Consequences

Positive:

- unauthorized UID/GID peers fail before payload admission;
- oversized payloads fail before allocation;
- tampering with any request/peer field invalidates the capability;
- nonce and idempotency replay survive broker restart;
- stale state transitions cannot commit;
- provider execution remains outside this slice.

Costs and residual risks:

- symmetric key custody is shared and must be operationally qualified;
- same-host root remains outside this local security boundary;
- SQLite initialization/schema provenance needs explicit qualification;
- no listener lifecycle or stale-socket recovery is included yet;
- source is not merge-qualified until the Rust runner executes all gates.
