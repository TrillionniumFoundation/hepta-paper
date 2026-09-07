# External provider idempotency and reconciliation contract

## Purpose and authority boundary

This contract defines the minimum externally implemented behavior required before a provider companion may be considered for real submission delivery. It does not authorize credentials, a provider account, portal mutation, release, submission, or production use. Repository tests can verify protocol behavior; only the provider owner and target environment can supply authoritative remote facts.

## Canonical operation identity

One irreversible delivery intent is identified by the canonical tuple:

```text
provider owner identity
provider account identity
paper identity
submission dispatch authorization hash
immutable package hash
provider protocol version
remote operation kind
```

The provider companion derives one idempotency key from the canonical encoding and SHA-256 hash of that complete tuple. The key is stable across retries of the identical intent and changes whenever any tuple member changes. A caller-provided key is never accepted without recomputation. Key reuse with different canonical bytes is a conflict and must fail closed before a remote mutation.

The companion must durably record the intent and its canonical hash before the first network attempt. A process-local map, log line, temporary file, test fixture, or caller memory is not durable idempotency state.

## State machine

The durable operation state is exactly one of:

```text
prepared
send_started
remote_outcome_ambiguous
remote_acknowledged
reconciled_present
reconciled_absent
quarantined_conflict
revoked
```

Permitted forward transitions are:

```text
prepared -> send_started
send_started -> remote_acknowledged
send_started -> remote_outcome_ambiguous
remote_outcome_ambiguous -> reconciled_present
remote_outcome_ambiguous -> reconciled_absent
reconciled_absent -> send_started
remote_acknowledged -> reconciled_present
any nonterminal state -> quarantined_conflict
prepared -> revoked
reconciled_absent -> revoked
```

No timeout, client disconnect, process exit, HTTP status absence, or missing local response may be interpreted as `reconciled_absent`. An ambiguous operation remains charged, locked, and non-retriable until authoritative reconciliation returns a bound result.

`reconciled_present`, `quarantined_conflict`, and `revoked` are terminal for the original intent. A correction requires a new dispatch authorization and therefore a new idempotency identity.

## First-send requirements

Before sending, the companion verifies and binds:

- the immutable source/release manifest;
- the target-host profile and running executable digest;
- provider owner and account identities;
- current credential version without exposing credential bytes;
- current dispatch authorization and package hashes;
- remote endpoint and method allowlists;
- the absence of an existing conflicting local or remote operation.

The transition to `send_started` and persistence of the attempt number occur atomically before opening the network request. Failure to persist denies the send.

The request carries the provider-supported idempotency key when such a field exists. If the provider has no native idempotency facility, the companion must use an independently reviewed remote lookup or reservation protocol that makes duplicate detection authoritative. Local deduplication alone is insufficient.

## Remote acknowledgement

A remote acknowledgement is accepted only when it binds all load-bearing identities available from the provider, including:

```text
provider and account
remote operation or submission ID
idempotency key or provider duplicate token
paper/package identity
remote state and revision
provider timestamp
response body digest
request body digest
endpoint and method identity
```

The exact raw response bytes are captured once, bounded, hashed, and retained under the applicable confidentiality policy. Parsed fields are projections of those captured bytes. A response with missing identity, conflicting duplicate status, malformed encoding, unexpected redirect, wrong endpoint, or unbounded body is quarantined rather than promoted.

An acknowledgement is not final reconciliation when the provider exposes an authoritative read-after-write endpoint. The companion must perform that read and bind its result before returning `reconciled_present`.

## Authoritative reconciliation

Reconciliation is a separately retryable read operation with its own bounded attempt history. It queries the authoritative provider state by the strongest available identity, in this order:

1. remote operation or submission ID plus account identity;
2. provider idempotency key plus account identity;
3. immutable package or manuscript identifier plus account identity;
4. independently reviewed provider-specific search contract.

A reconciliation result records the query identity, endpoint, captured response hash, provider revision, observation time, validity interval, and whether the remote object is present, absent, duplicated, revoked, or indeterminate.

`reconciled_absent` requires a provider response that authoritatively covers the complete account and operation identity. Search failure, pagination truncation, authorization denial, stale caches, rate limiting, network failure, or an endpoint that cannot prove absence yields `remote_outcome_ambiguous`.

A duplicate or conflicting remote object yields `quarantined_conflict`; the companion must not choose one silently or send again.

## Retry rules

A send retry is permitted only when all of the following hold:

- the durable state is `reconciled_absent`;
- source, host, provider account, credential version, package and authorization identities remain current;
- revocation has not occurred;
- retry count and elapsed window remain within policy;
- the next attempt reuses the same canonical idempotency identity;
- the previous reconciliation evidence is retained.

Backoff, jitter and rate-limit handling are bounded configuration inputs and are recorded in the operation subject. A retry budget exhaustion leaves the operation non-authorizing and unresolved; it does not invent success or absence.

## Crash and restart recovery

On startup, the companion scans durable nonterminal operations before accepting new work. `send_started` without an acknowledged result is treated as `remote_outcome_ambiguous` and reconciled before any retry. Recovery is idempotent and protected by a persistent lease or fencing generation so two companion processes cannot reconcile or send the same operation concurrently.

The recovery process must survive process death, host reboot and storage remount. A target-host qualification campaign must demonstrate these cases against the actual durable store and provider sandbox account.

## Required receipts

The acceptance packet retains distinct typed receipts for:

- intent persistence;
- send start;
- captured remote acknowledgement or ambiguity;
- each reconciliation attempt;
- terminal reconciliation;
- conflict quarantine;
- revocation;
- retry decision;
- recovery after restart.

Each receipt binds schema version, source and host subject, operation identity, attempt and fencing generation, predecessor receipt hash, observation time, raw evidence hashes, disposition and authority flags. Receipt continuity must be independently verified; a summary counter is not sufficient.

## Failure codes

At minimum, the implementation distinguishes:

```text
provider_identity_mismatch
provider_manifest_not_current
provider_host_profile_not_current
provider_credential_version_mismatch
provider_idempotency_conflict
provider_send_persistence_failed
provider_remote_outcome_ambiguous
provider_reconciliation_indeterminate
provider_reconciliation_duplicate
provider_retry_not_permitted
provider_operation_revoked
provider_recovery_fencing_lost
provider_receipt_chain_invalid
```

Unknown failures are conservative and cannot be converted into success, absence, or retry permission.

## Acceptance tests

External qualification must include positive and hostile demonstrations for exact duplicate retry, conflicting key reuse, disconnect before response, disconnect after provider commit, process kill during send, restart recovery, provider timeout, pagination truncation, stale read, duplicate remote objects, credential revocation, fencing loss, receipt corruption, and authoritative read-after-write.

Every test binds the exact external companion source, provider sandbox account, target host, durable store, credential version and provider endpoint. Portable repository fixtures do not satisfy this requirement.
