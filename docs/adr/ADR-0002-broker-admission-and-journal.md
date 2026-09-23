# ADR-0002: authenticate local broker requests before durable reservation

Status: accepted for source implementation; compile qualification pending  
Date: 2026-08-28

## Context

The Codex broker is a separate Unix principal with provider credentials and a
minimal operation journal. A local socket pathname and filesystem permissions
are not sufficient request authority: another same-group process could connect,
a copied request could be replayed, and a crash between provider reservation and
campaign integration could cause a duplicate paid call.

The broker must reject unauthenticated input before it allocates persistent
state, and its state must distinguish one broker operation from one campaign
attempt.

## Decision

Foundation V1 admits a request in this order:

1. inspect Linux `SO_PEERCRED` on the connected Unix stream;
2. require an exact UID/GID principal allowlist match;
3. read one `HEPTACX1` length-prefixed frame under a hard byte/time limit;
4. parse and re-encode a deny-unknown-fields `CodexExecutionRequestV1`, rejecting
   any noncanonical JSON bytes;
5. require the request role, sandbox and qualified runtime-identity hash to match
   the exact broker instance surface;
6. bind the capability's UID/GID claims to `SO_PEERCRED`;
7. verify issue/expiry/deadline limits;
8. strictly verify a domain-separated Ed25519 signature;
9. reserve the operation and consume the nonce in one SQLite `BEGIN IMMEDIATE`
   transaction.

The capability signs every request field that can influence execution plus its
nonce, issue/expiry time, signer key ID and peer UID/GID. It does not bind the
peer PID because an exact idempotent reconnect may be performed by a restarted
client under the same authorized principal. The first observed PID remains
journal evidence.

The broker database is independent of the campaign database. It stores exact
request bytes/hash, idempotency identity, capability nonce, peer identity,
append-only transitions, provider-start projection and prepared-result hash.
It cannot grant campaign, release or submission authority.

## Durability

- private canonical parent directory and `0600` single-link database file;
- SQLite `NOFOLLOW`, bundled SQLite, foreign keys, WAL and `synchronous=FULL`;
- bounded database size and busy timeout;
- operation reservation and nonce consumption are atomic, linked by a deferred circular foreign-key contract, and share one timestamp;
- expired authenticated requests cannot enter the reservation transaction;
- transition append and current-state projection are atomic;
- transition and nonce rows are update/delete protected by triggers;
- schema/application identity, STRICT tables, exact schema-object manifest and
  the single-row metadata manifest are verified on every open;
- first creation is guarded by a private fsync'd `.initializing` marker; an unmarked empty/foreign database is never adopted;
- a stale valid marker may roll forward only an empty database or the exact stamped schema, and is removed only after full verification plus parent-directory fsync;
- every open runs integrity, foreign-key and journal/projection validation;
- injected faults after operation or transition insertion must roll back.

## Idempotency and replay

- exact duplicate idempotency request returns the existing journal;
- the same idempotency key with different evidence is rejected;
- the same operation ID with another reservation is rejected;
- a nonce used by another operation is rejected;
- a terminal operation is never reopened;
- provider-may-have-started recovery requires a new campaign attempt;
- a prepared result is integrated without rerunning Codex.

## Cryptography

The trust store contains qualified Ed25519 public keys only. Weak public keys
are rejected and verification uses strict Ed25519 checks. Private signing keys
are outside the broker process in production; test-only deterministic signing
keys do not establish production authority.

## Rejected alternatives

### Socket permissions only

Rejected because they do not bind a particular request, deadline, generation,
role, sandbox or idempotency identity.

### Capability without kernel credentials

Rejected because a copied capability should not be usable by a different Unix
principal.

### Campaign database as broker journal

Rejected because it would give the credential-bearing broker campaign writer
authority and make the single-writer cutover boundary ambiguous.

### Re-run on missing local acknowledgement

Rejected because process/provider action may already have started. Recovery is
based on the durable operation state, not on the caller's last observed reply.

## Consequences

The broker now needs a signer trust-store lifecycle, nonce retention, private
SQLite storage and an explicit reconciliation path. These costs are accepted to
prevent replay, duplicate paid calls and authority collapse.
